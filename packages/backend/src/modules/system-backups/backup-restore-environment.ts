import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';

const limit = 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const failed = () => new BackupRequirementError('Restore configuration recovery needs attention. Keep the server stopped and retry recovery.');
type Identity = { device: string; inode: string };
type Intent = Identity & {
  version: 1;
  id: string;
  nonce: string;
  original: string;
  incoming: string;
  target: 'original' | 'incoming';
  phase: 'writing' | 'settled';
};

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function save(file: string, intent: Intent) {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(intent));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function validate(value: unknown): asserts value is Intent {
  if (!value || typeof value !== 'object') throw failed();
  const item = value as Intent;
  if (
    Object.keys(item).sort().join(',') !== 'device,id,incoming,inode,nonce,original,phase,target,version' ||
    item.version !== 1 ||
    !uuid.test(item.id) ||
    !uuid.test(item.nonce) ||
    !/^[0-9]+$/.test(item.device) ||
    !/^[0-9]+$/.test(item.inode) ||
    !/^[a-f0-9]{64}$/.test(item.original) ||
    !/^[a-f0-9]{64}$/.test(item.incoming) ||
    !['original', 'incoming'].includes(item.target) ||
    !['writing', 'settled'].includes(item.phase)
  )
    throw failed();
}

async function readIntent(file: string) {
  let handle: FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 4096 || (process.getuid && stat.uid !== process.getuid()))
      throw failed();
    const intent: unknown = JSON.parse(await handle.readFile('utf8'));
    validate(intent);
    return intent;
  } finally {
    await handle.close();
  }
}

async function identity(handle: FileHandle) {
  const stat = await handle.stat({ bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.mode & 0o077n ||
    stat.size > BigInt(limit) ||
    (process.getuid && stat.uid !== BigInt(process.getuid()))
  )
    throw failed();
  return { device: String(stat.dev), inode: String(stat.ino) };
}

async function contents(handle: FileHandle) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (!bytesRead) return hash.digest('hex');
    total += bytesRead;
    if (total > limit) throw failed();
    hash.update(buffer.subarray(0, bytesRead));
  }
}

// The caller holds the restore lease with every controller/writer stopped behind the startup gate.
// A direct file bind cannot be renamed; its durable intent permits recovery of an interrupted same-inode write.
export async function writeRestoreEnvironment(options: {
  file: string;
  journal: string;
  id: string;
  nonce: string;
  original: Uint8Array;
  incoming: Uint8Array;
  target: 'original' | 'incoming';
}) {
  try {
    if (
      !uuid.test(options.id) ||
      !uuid.test(options.nonce) ||
      !['original', 'incoming'].includes(options.target) ||
      !path.isAbsolute(options.file) ||
      path.resolve(options.file) !== options.file ||
      !path.isAbsolute(options.journal) ||
      path.resolve(options.journal) !== options.journal ||
      path.basename(options.journal) !== 'environment-pointer.json' ||
      path.dirname(options.file) === path.dirname(options.journal)
    )
      throw failed();
    if ([options.original, options.incoming].some((value) => !(value instanceof Uint8Array) || !value.byteLength || value.byteLength > limit))
      throw failed();
    const values = { original: Buffer.from(options.original), incoming: Buffer.from(options.incoming) };
    const hashes = { original: sha256(values.original), incoming: sha256(values.incoming) };
    await privateBackupDirectory(path.dirname(options.journal));
    if ((await fs.realpath(options.file)) !== options.file) throw failed();
    const handle = await fs.open(options.file, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const current = await identity(handle);
      const intent = await readIntent(options.journal);
      if (
        intent &&
        (intent.id !== options.id ||
          intent.nonce !== options.nonce ||
          intent.device !== current.device ||
          intent.inode !== current.inode ||
          intent.original !== hashes.original ||
          intent.incoming !== hashes.incoming)
      )
        throw failed();
      const digest = await contents(handle);
      if (intent?.phase !== 'writing' && !Object.values(hashes).includes(digest)) throw failed();
      if (intent?.phase === 'settled' && digest !== hashes[intent.target]) throw failed();
      const writing: Intent = {
        version: 1,
        id: options.id,
        nonce: options.nonce,
        ...current,
        ...hashes,
        target: options.target,
        phase: 'writing',
      };
      await save(options.journal, writing);
      const bytes = values[options.target];
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.writev([bytes.subarray(written)], written);
        if (!result.bytesWritten) throw failed();
        written += result.bytesWritten;
      }
      await handle.truncate(bytes.length);
      await handle.sync();
      const after = await identity(handle);
      const pathname = await fs.lstat(options.file, { bigint: true });
      if (
        after.device !== current.device ||
        after.inode !== current.inode ||
        String(pathname.dev) !== current.device ||
        String(pathname.ino) !== current.inode ||
        pathname.isSymbolicLink() ||
        (await contents(handle)) !== hashes[options.target]
      )
        throw failed();
      await save(options.journal, { ...writing, phase: 'settled' });
    } finally {
      await handle.close();
    }
  } catch {
    throw failed();
  }
}
