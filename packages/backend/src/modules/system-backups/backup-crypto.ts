import { type CipherGCM, type DecipherGCM, createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';
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
