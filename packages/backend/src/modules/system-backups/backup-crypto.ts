import { type CipherGCM, type DecipherGCM, createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const magic = Buffer.from('ORBISBK1');
const saltSize = 16;
const nonceSize = 12;
const headerSize = magic.length + saltSize + nonceSize;
const tagSize = 16;
// SP800-38D section 5.2.1.1 limits each GCM plaintext to 2^39−256 bits.
export const backupGcmPlaintextLimit = 2 ** 36 - 32;
export const backupCipherOverhead = headerSize + tagSize;

export class BackupArchiveError extends Error {
  constructor(public readonly code: 'passphrase' | 'invalid-archive' | 'cancelled' | 'operation-failed') {
    super(
      code === 'passphrase'
        ? 'Use a backup passphrase between 12 and 1024 characters.'
        : code === 'invalid-archive'
          ? 'The backup could not be opened. Check its passphrase and file.'
          : code === 'cancelled'
            ? 'Backup operation cancelled.'
            : 'The backup file could not be saved. Check available storage and permissions.',
    );
    this.name = 'BackupArchiveError';
  }
}

export type BackupCryptoOptions = {
  source: string;
  destination: string;
  passphrase: string;
  signal?: AbortSignal;
  onProgress?: (completedBytes: number, totalBytes: number) => void;
};

function deriveKey(passphrase: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function writeAll(file: FileHandle, data: Buffer) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset);
    if (!bytesWritten) throw new Error('Incomplete backup write');
    offset += bytesWritten;
  }
}

async function transformBackup(options: BackupCryptoOptions, decrypt: boolean) {
  const { source, destination, passphrase, signal, onProgress } = options;
  if (typeof passphrase !== 'string' || passphrase.trim().length < 12 || passphrase.length > 1024) throw new BackupArchiveError('passphrase');

  let input: FileHandle | undefined;
  let output: FileHandle | undefined;
  let key: Buffer | undefined;
  let committed = false;
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.partial`);
  try {
    signal?.throwIfAborted();
    const parent = await fs.lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid()))
      throw new Error('Backup staging requires a private directory');
    input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await input.stat();
    if (!before.isFile()) throw new Error('Backup source must be a file');
    let header: Buffer;
    if (decrypt) {
      if (before.size < headerSize + tagSize) throw new BackupArchiveError('invalid-archive');
      header = Buffer.alloc(headerSize);
      const { bytesRead } = await input.read(header, 0, header.length, 0);
      if (bytesRead !== headerSize || !header.subarray(0, magic.length).equals(magic)) throw new BackupArchiveError('invalid-archive');
    } else header = Buffer.concat([magic, randomBytes(saltSize), randomBytes(nonceSize)]);

    key = await deriveKey(passphrase, header.subarray(magic.length, magic.length + saltSize));
    signal?.throwIfAborted();
    output = await fs.open(temporary, 'wx', 0o600);
    const nonce = header.subarray(magic.length + saltSize);
    const transform = decrypt ? createDecipheriv('aes-256-gcm', key, nonce) : createCipheriv('aes-256-gcm', key, nonce);
    transform.setAAD(header);
    if (decrypt) {
      const tag = Buffer.alloc(tagSize);
      const { bytesRead } = await input.read(tag, 0, tagSize, before.size - tagSize);
      if (bytesRead !== tagSize) throw new BackupArchiveError('invalid-archive');
      (transform as DecipherGCM).setAuthTag(tag);
    } else await writeAll(output, header);

    const total = decrypt ? before.size - headerSize - tagSize : before.size;
    let completed = 0;
    onProgress?.(0, total);
    const stream =
      total === 0
        ? Readable.from([])
        : input.createReadStream({ start: decrypt ? headerSize : 0, end: decrypt ? before.size - tagSize - 1 : before.size - 1, autoClose: false });
    const destinationFile = output;
    await pipeline(
      stream,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          completed += chunk.length;
          onProgress?.(completed, total);
          yield chunk;
        }
      },
      transform,
      async (chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) await writeAll(destinationFile, chunk);
      },
      { signal },
    );
    if (!decrypt) await writeAll(output, (transform as CipherGCM).getAuthTag());
    const after = await input.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || completed !== total)
      throw new Error('Backup source changed during transfer');
    signal?.throwIfAborted();
    await output.sync();
    await output.close();
    output = undefined;
    await fs.link(temporary, destination);
    committed = true;
    const parentHandle = await fs.open(directory, 'r');
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
    return { processedBytes: total };
  } catch (error) {
    if (committed) await fs.rm(destination, { force: true }).catch(() => undefined);
    if (signal?.aborted) throw new BackupArchiveError('cancelled');
    if (error instanceof BackupArchiveError) throw error;
    if (['ENOSPC', 'EDQUOT', 'EACCES', 'EROFS', 'EMFILE', 'EIO', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new BackupArchiveError('operation-failed');
    throw new BackupArchiveError(decrypt ? 'invalid-archive' : 'operation-failed');
  } finally {
    key?.fill(0);
    await output?.close().catch(() => undefined);
    await input?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export const encryptBackup = (options: BackupCryptoOptions) => transformBackup(options, false);
export const decryptBackup = (options: BackupCryptoOptions) => transformBackup(options, true);

export async function encryptBackupStream(options: {
  source: Readable;
  plaintextBytes: number;
  destination: string;
  passphrase: string;
  signal: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}) {
  const { source, plaintextBytes, destination, passphrase, signal } = options;
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0 || plaintextBytes > backupGcmPlaintextLimit) {
    source.destroy();
    throw new BackupArchiveError('operation-failed');
  }
  if (typeof passphrase !== 'string' || passphrase.trim().length < 12 || passphrase.length > 1024) {
    source.destroy();
    throw new BackupArchiveError('passphrase');
  }
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.partial`);
  let output: FileHandle | undefined;
  let key: Buffer | undefined;
  let linked = false;
  const abort = () => source.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const parent = await fs.lstat(directory);
    if (
      !parent.isDirectory() ||
      parent.mode & 0o077 ||
      (process.getuid && parent.uid !== process.getuid()) ||
      (await fs.realpath(directory)) !== path.resolve(directory)
    )
      throw new Error('Unsafe backup storage');
    const header = Buffer.concat([magic, randomBytes(saltSize), randomBytes(nonceSize)]);
    key = await deriveKey(passphrase, header.subarray(magic.length, magic.length + saltSize));
    signal.throwIfAborted();
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(magic.length + saltSize));
    cipher.setAAD(header);
    output = await fs.open(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    const writeCipher = async (bytes: Buffer) => {
      hash.update(bytes);
      await writeAll(output as FileHandle, bytes);
    };
    await writeCipher(header);
    let completed = 0;
    options.onProgress?.(0, plaintextBytes);
    for await (const chunk of source) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      completed += bytes.length;
      if (completed > plaintextBytes || completed > backupGcmPlaintextLimit) throw new Error('Backup stream exceeded its size');
      await writeCipher(cipher.update(bytes));
      options.onProgress?.(completed, plaintextBytes);
    }
    if (completed !== plaintextBytes) throw new Error('Incomplete backup stream');
    await writeCipher(cipher.final());
    await writeCipher(cipher.getAuthTag());
    signal.throwIfAborted();
    await output.sync();
    await output.close();
    output = undefined;
    await fs.link(temporary, destination);
    linked = true;
    const parentFile = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await parentFile.sync();
    } finally {
      await parentFile.close();
    }
    return { processedBytes: completed, bytes: completed + backupCipherOverhead, sha256: hash.digest('hex') };
  } catch {
    if (linked) await fs.rm(destination, { force: true }).catch(() => undefined);
    throw new BackupArchiveError(signal.aborted ? 'cancelled' : 'operation-failed');
  } finally {
    signal.removeEventListener('abort', abort);
    source.destroy();
    key?.fill(0);
    await output?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
  }
}

// Bounded metadata uses the same authenticated archive format without plaintext staging files.
export async function backupMetadataBytes(input: Buffer, passphrase: string, decrypt: boolean, maximumBytes = 1024 * 1024) {
  if (typeof passphrase !== 'string' || passphrase.trim().length < 12 || passphrase.length > 1024) throw new BackupArchiveError('passphrase');
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 32 * 1024 * 1024 ||
    input.length > maximumBytes + (decrypt ? headerSize + tagSize : 0) ||
    (decrypt && input.length < headerSize + tagSize)
  )
    throw new BackupArchiveError('invalid-archive');
  const header = decrypt ? input.subarray(0, headerSize) : Buffer.concat([magic, randomBytes(saltSize), randomBytes(nonceSize)]);
  if (!header.subarray(0, magic.length).equals(magic)) throw new BackupArchiveError('invalid-archive');
  const key = await deriveKey(passphrase, header.subarray(magic.length, magic.length + saltSize));
  try {
    const nonce = header.subarray(magic.length + saltSize);
    if (decrypt) {
      const cipher = createDecipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(header);
      cipher.setAuthTag(input.subarray(input.length - tagSize));
      return Buffer.concat([cipher.update(input.subarray(headerSize, input.length - tagSize)), cipher.final()]);
    }
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(input), cipher.final(), cipher.getAuthTag()]);
  } catch {
    throw new BackupArchiveError('invalid-archive');
  } finally {
    key.fill(0);
  }
}
