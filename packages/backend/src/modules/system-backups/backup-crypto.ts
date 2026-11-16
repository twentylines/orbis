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
        ? 'Use a backup passphrase between 8 and 1024 characters.'
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
  if (typeof passphrase !== 'string' || passphrase.length < 8 || !passphrase.trim() || passphrase.length > 1024)
    throw new BackupArchiveError('passphrase');

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

/** Authenticates a ciphertext and hashes its plaintext without writing or returning plaintext. */
type CipherInspectionOptions = { source: string; passphrase: string; plaintextBytes: number; signal: AbortSignal };
export const inspectBackupCiphertext = (options: CipherInspectionOptions) => inspectCiphertext(options);

async function inspectCiphertext(options: CipherInspectionOptions, aggregate?: ReturnType<typeof createHash>) {
  const { source, passphrase, plaintextBytes, signal } = options;
  if (typeof passphrase !== 'string' || passphrase.length < 8 || !passphrase.trim() || passphrase.length > 1024)
    throw new BackupArchiveError('passphrase');
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0 || plaintextBytes > backupGcmPlaintextLimit)
    throw new BackupArchiveError('invalid-archive');
  let input: FileHandle | undefined;
  let key: Buffer | undefined;
  const encrypted = Buffer.alloc(256 * 1024);
  const identity = (s: Awaited<ReturnType<FileHandle['stat']>>) =>
    [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
  try {
    signal.throwIfAborted();
    const parent = path.dirname(source);
    if (!path.isAbsolute(source) || path.resolve(source) !== source || (await fs.realpath(parent)) !== parent)
      throw new BackupArchiveError('invalid-archive');
    const directory = await fs.lstat(parent);
    if (!directory.isDirectory() || directory.mode & 0o077 || directory.uid !== process.getuid?.()) throw new BackupArchiveError('invalid-archive');
    input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.size !== plaintextBytes + backupCipherOverhead
    )
      throw new BackupArchiveError('invalid-archive');
    const header = Buffer.alloc(headerSize);
    const tag = Buffer.alloc(tagSize);
    if (
      (await input.read(header, 0, headerSize, 0)).bytesRead !== headerSize ||
      !header.subarray(0, magic.length).equals(magic) ||
      (await input.read(tag, 0, tagSize, before.size - tagSize)).bytesRead !== tagSize
    )
      throw new BackupArchiveError('invalid-archive');
    key = await deriveKey(passphrase, header.subarray(magic.length, magic.length + saltSize));
    const cipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length + saltSize));
    cipher.setAAD(header);
    cipher.setAuthTag(tag);
    const hash = createHash('sha256');
    let position = 0;
    while (position < plaintextBytes) {
      signal.throwIfAborted();
      const { bytesRead } = await input.read(encrypted, 0, Math.min(encrypted.length, plaintextBytes - position), headerSize + position);
      if (!bytesRead) throw new BackupArchiveError('invalid-archive');
      const plaintext = cipher.update(encrypted.subarray(0, bytesRead));
      try {
        hash.update(plaintext);
        aggregate?.update(plaintext);
      } finally {
        plaintext.fill(0);
      }
      position += bytesRead;
    }
    const last = cipher.final();
    try {
      hash.update(last);
      aggregate?.update(last);
    } finally {
      last.fill(0);
    }
    signal.throwIfAborted();
    if (
      identity(before) !== identity(await input.stat()) ||
      identity(before) !== identity(await fs.lstat(source)) ||
      [directory.dev, directory.ino, directory.uid, directory.mode].join(':') !==
        ((s) => [s.dev, s.ino, s.uid, s.mode].join(':'))(await fs.lstat(parent)) ||
      (await fs.realpath(parent)) !== parent
    )
      throw new BackupArchiveError('invalid-archive');
    return Object.freeze({ plaintextBytes: position, plaintextSha256: hash.digest('hex') });
  } catch {
    throw new BackupArchiveError(signal.aborted ? 'cancelled' : 'invalid-archive');
  } finally {
    key?.fill(0);
    encrypted.fill(0);
    await input?.close();
  }
}

/** Authenticates an ordered sequence, including its combined plaintext digest, without exposing plaintext. */
export function createBackupCiphertextSequenceInspector(options: { passphrase: string; signal: AbortSignal }) {
  const { passphrase, signal } = options;
  const aggregate = createHash('sha256');
  const verified: Awaited<ReturnType<typeof inspectCiphertext>>[] = [];
  const sources = new Set<string>();
  let total = 0;
  let pending = false;
  let closed = false;
  return {
    async add(chunk: Pick<CipherInspectionOptions, 'source' | 'plaintextBytes'>) {
      if (closed || pending) {
        closed = true;
        throw new BackupArchiveError('invalid-archive');
      }
      pending = true;
      try {
        const { source, plaintextBytes } = chunk;
        const next = total + plaintextBytes;
        if (sources.has(source) || sources.size >= 128 || !Number.isSafeInteger(next) || next < 0 || next > 128 * 1024 ** 3)
          throw new BackupArchiveError('invalid-archive');
        const result = await inspectCiphertext({ passphrase, signal, source, plaintextBytes }, aggregate);
        if (closed) throw new BackupArchiveError('invalid-archive');
        sources.add(source);
        total = next;
        verified.push(result);
        return result;
      } catch (error) {
        closed = true;
        throw error;
      } finally {
        pending = false;
      }
    },
    finish() {
      if (closed || pending || !verified.length) {
        closed = true;
        throw new BackupArchiveError('invalid-archive');
      }
      closed = true;
      signal.throwIfAborted();
      return Object.freeze({ plaintextBytes: total, plaintextSha256: aggregate.digest('hex'), chunks: Object.freeze(verified) });
    },
  };
}

export async function inspectBackupCiphertextSequence(options: {
  chunks: readonly Pick<CipherInspectionOptions, 'source' | 'plaintextBytes'>[];
  passphrase: string;
  signal: AbortSignal;
}) {
  if (!Array.isArray(options.chunks) || options.chunks.length < 1 || options.chunks.length > 128) throw new BackupArchiveError('invalid-archive');
  const chunks = options.chunks.map(({ source, plaintextBytes }) => ({ source, plaintextBytes }));
  const { passphrase, signal } = options;
  const total = chunks.reduce((sum, chunk) => sum + chunk.plaintextBytes, 0);
  if (!Number.isSafeInteger(total) || total < 0 || total > 128 * 1024 ** 3 || new Set(chunks.map((chunk) => chunk.source)).size !== chunks.length)
    throw new BackupArchiveError('invalid-archive');
  const inspector = createBackupCiphertextSequenceInspector({ passphrase, signal });
  for (const chunk of chunks) await inspector.add(chunk);
  return inspector.finish();
}

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
  if (typeof passphrase !== 'string' || passphrase.length < 8 || !passphrase.trim() || passphrase.length > 1024) {
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
      try {
        completed += bytes.length;
        if (completed > plaintextBytes || completed > backupGcmPlaintextLimit) throw new Error('Backup stream exceeded its size');
        await writeCipher(cipher.update(bytes));
        options.onProgress?.(completed, plaintextBytes);
      } finally {
        bytes.fill(0);
      }
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
  if (typeof passphrase !== 'string' || passphrase.length < 8 || !passphrase.trim() || passphrase.length > 1024)
    throw new BackupArchiveError('passphrase');
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
