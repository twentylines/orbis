import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { encryptBackup } from './backup-crypto';
import { fullBackupLimits } from './backup-limits';
import { resetScopes } from '../system-reset/reset-contract';

export class BackupRequirementError extends Error {}

export type BackupFile = {
  name: string;
  source: string;
  bytes: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  ctime: number;
  device: number;
  inode: number;
};
export type BackupProgress = { stage: 'inventory' | 'copying' | 'archiving' | 'encrypting'; completedBytes: number; totalBytes: number | null };
export type BackupLink = { name: string; target: string; uid: number; gid: number; mtime: number };

export async function resolveBackupLinkPath(root: string, parent: string, target: string) {
  const invalid = () => new BackupRequirementError('Backup app-data link target is unsafe. No data was changed.');
  if (
    !target ||
    Buffer.byteLength(target) > 4096 ||
    path.isAbsolute(target) ||
    target.includes('\\') ||
    Array.from(target).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    (await fs.realpath(parent)) !== parent ||
    !(parent === root || parent.startsWith(`${root}${path.sep}`))
  )
    throw invalid();
  let current = parent;
  const parts = target.split('/');
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part || part === '.') continue;
    if (part === '..') {
      if (current === root) throw invalid();
      current = path.dirname(current);
    } else {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw invalid();
    }
  }
  if (!current.startsWith(`${root}${path.sep}`) || (await fs.realpath(current)) !== current) throw invalid();
  const stat = await fs.lstat(current);
  if (!stat.isFile() && !stat.isDirectory()) throw invalid();
  if (stat.isDirectory() && (parent === current || parent.startsWith(`${current}${path.sep}`))) throw invalid();
  return current;
}

export function validateBackupLinks(
  links: readonly BackupLink[],
  sockets: readonly string[],
  files: readonly { name: string }[],
  directories: readonly { name: string }[],
) {
  const invalid = () => new BackupRequirementError('Backup app-data links or runtime exclusions are unsafe. No data was changed.');
  const ordinary = new Set([...files, ...directories].map(({ name }) => name));
  const directoryNames = new Set(directories.map(({ name }) => name));
  const special = new Set<string>();
  let bytes = 0;
  const appName = (name: string) =>
    name.startsWith('app-data/') &&
    safeName(name) &&
    !name.split('/').includes('.') &&
    !name.split('/')[1]?.startsWith('.orbis-restore-') &&
    name.split('/').every((part) => Buffer.byteLength(part) <= 255 && !/[\uD800-\uDFFF]/u.test(part)) &&
    Buffer.byteLength(name) <= 4096;
  for (const name of [...links.map((link) => link.name), ...sockets]) {
    if (!appName(name) || ordinary.has(name) || special.has(name) || !directoryNames.has(path.posix.dirname(name))) throw invalid();
    special.add(name);
    bytes += Buffer.byteLength(name);
  }
  for (const link of links) {
    const target = link.target;
    if (
      typeof target !== 'string' ||
      !target ||
      Buffer.byteLength(target) > 4096 ||
      path.posix.isAbsolute(target) ||
      target.includes('\\') ||
      Array.from(target).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw invalid();
    bytes += Buffer.byteLength(target);
    const components = path.posix.dirname(link.name).split('/');
    const parts = target.split('/');
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part || part === '.') continue;
      if (part === '..') {
        if (components.length <= 1) throw invalid();
        components.pop();
      } else {
        components.push(part);
        if (index < parts.length - 1 && !directoryNames.has(components.join('/'))) throw invalid();
      }
    }
    const resolved = components.join('/');
    if (!resolved.startsWith('app-data/') || !ordinary.has(resolved)) throw invalid();
    const parent = path.posix.dirname(link.name);
    if (directoryNames.has(resolved) && (parent === resolved || parent.startsWith(`${resolved}/`))) throw invalid();
    for (let parent = path.posix.dirname(resolved); parent !== '.'; parent = path.posix.dirname(parent)) if (special.has(parent)) throw invalid();
  }
  for (const name of ordinary)
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) if (special.has(parent)) throw invalid();
  if (
    files.length + directories.length + links.length + sockets.length > fullBackupLimits.entries ||
    bytes + [...ordinary].reduce((n, name) => n + Buffer.byteLength(name), 0) > fullBackupLimits.pathBytes
  )
    throw invalid();
}

const inside = (root: string, target: string) => target === root || target.startsWith(`${root}${path.sep}`);
const safeName = (name: string) =>
  name !== '' &&
  !Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\') &&
  !path.posix.isAbsolute(name) &&
  name.split('/').every((part) => part !== '..' && part !== '');

export async function privateBackupDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new BackupRequirementError('Full backups need a private storage directory.');
  if ((await fs.realpath(directory)) !== path.resolve(directory))
    throw new BackupRequirementError('Full backup storage cannot contain symbolic links.');
}

export async function inventoryBackup(
  roots: { name: string; source: string; required?: boolean }[],
  signal: AbortSignal,
  excludedDirectories: readonly string[] = [],
  options: { allowAppDataLinksAndSockets?: boolean } = {},
) {
  const files: BackupFile[] = [];
  const directories: { name: string; mode: number; uid: number; gid: number; mtime: number }[] = [];
  const symlinks: BackupLink[] = [];
  const excludedRuntimeSockets: string[] = [];
  const specialSources: { source: string; device: number; inode: number; ctime: number; mtime: number; target?: string }[] = [];
  const names = new Set<string>();
  let pathBytes = 0;
  const excluded = new Set(excludedDirectories);
  const observedExclusions = new Set<string>();
  if (
    excluded.size !== excludedDirectories.length ||
    excludedDirectories.some(
      (directory) =>
        !path.isAbsolute(directory) ||
        path.resolve(directory) !== directory ||
        !roots.some((root) => path.resolve(root.source) === path.dirname(directory)) ||
        !/^\.orbis-restore-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:incoming|previous)$/.test(
          path.basename(directory),
        ),
    )
  )
    throw new BackupRequirementError('Backup restore exclusions could not be verified.');
  const visit = async (source: string, name: string, root: string): Promise<void> => {
    signal.throwIfAborted();
    if (!safeName(name) || names.has(name) || !inside(root, source)) throw new BackupRequirementError('Backup source contains an unsupported path.');
    // Reset intent belongs to this host. Replaying its journal or staged preferences from an archive can resume an unrelated reset.
    const parent = path.posix.dirname(name);
    const resetStage =
      (parent === 'data' || resetScopes.some((scope) => parent === `data/state/${scope}`) || parent === 'data/state') &&
      /^\.orbis-reset-stage-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(path.posix.basename(name));
    if (name === 'data/state/orbis-reset' || resetStage) {
      const stat = await fs.lstat(source);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (await fs.realpath(source)) !== source
      )
        throw new BackupRequirementError('Reset recovery files need local review before creating a full backup.');
      return;
    }
    if (source !== root && path.dirname(source) === root && path.basename(source).startsWith('.orbis-restore-')) {
      if (!excluded.has(source)) throw new BackupRequirementError('Unrecognized restore recovery files need review before creating a full backup.');
      const stat = await fs.lstat(source);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (await fs.realpath(source)) !== source
      )
        throw new BackupRequirementError('Backup restore exclusions could not be verified.');
      observedExclusions.add(source);
      return;
    }
    pathBytes += Buffer.byteLength(name);
    if (names.size >= fullBackupLimits.entries || pathBytes > fullBackupLimits.pathBytes)
      throw new BackupRequirementError(
        'This export exceeds the current file-count limit. Back up large app libraries separately until streaming inventory is available.',
      );
    names.add(name);
    const stat = await fs.lstat(source);
    if (options.allowAppDataLinksAndSockets && name.startsWith('app-data/') && (stat.isSymbolicLink() || stat.isSocket())) {
      if ((await fs.realpath(path.dirname(source))) !== path.dirname(source))
        throw new BackupRequirementError('Backup source changed. Retry after current writes finish.');
      const target = stat.isSymbolicLink() ? await fs.readlink(source) : undefined;
      const after = await fs.lstat(source);
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs)
        throw new BackupRequirementError('Backup source changed. Retry after current writes finish.');
      specialSources.push({
        source,
        device: stat.dev,
        inode: stat.ino,
        ctime: stat.ctimeMs,
        mtime: stat.mtimeMs,
        ...(target === undefined ? {} : { target }),
      });
      if (target === undefined) excludedRuntimeSockets.push(name);
      else symlinks.push({ name, target, uid: stat.uid, gid: stat.gid, mtime: stat.mtimeMs });
      return;
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new BackupRequirementError('A data directory contains links or special files that need a separate backup plan.');
    if (stat.isDirectory()) {
      directories.push({ name, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, mtime: stat.mtimeMs });
      for (const child of (await fs.readdir(source)).sort()) await visit(path.join(source, child), `${name}/${child}`, root);
    } else
      files.push({
        name,
        source,
        bytes: stat.size,
        mode: stat.mode & 0o777,
        uid: stat.uid,
        gid: stat.gid,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
        device: stat.dev,
        inode: stat.ino,
      });
  };
  for (const root of roots) {
    const resolved = path.resolve(root.source);
    if ((await fs.realpath(path.dirname(resolved))) !== path.dirname(resolved))
      throw new BackupRequirementError('Backup source parent contains a symbolic link.');
    const exists = await fs
      .lstat(resolved)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && !root.required) return false;
        throw error;
      });
    if (exists) await visit(resolved, root.name, resolved);
  }
  if (observedExclusions.size !== excluded.size) throw new BackupRequirementError('Restore recovery files changed during backup planning.');
  validateBackupLinks(symlinks, excludedRuntimeSockets, files, directories);
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new BackupRequirementError('Backup source exceeds the supported size.');
  return { files, directories, totalBytes, symlinks, excludedRuntimeSockets, specialSources };
}

export async function copyBackupFiles(
  inventory: Awaited<ReturnType<typeof inventoryBackup>>,
  destination: string,
  signal: AbortSignal,
  progress: (value: BackupProgress) => void,
) {
  let completed = 0;
  const verifySpecial = async () => {
    for (const entry of inventory.specialSources) {
      signal.throwIfAborted();
      const stat = await fs.lstat(entry.source);
      if (
        stat.dev !== entry.device ||
        stat.ino !== entry.inode ||
        stat.ctimeMs !== entry.ctime ||
        stat.mtimeMs !== entry.mtime ||
        (entry.target === undefined ? !stat.isSocket() : !stat.isSymbolicLink() || (await fs.readlink(entry.source)) !== entry.target) ||
        (await fs.realpath(path.dirname(entry.source))) !== path.dirname(entry.source)
      )
        throw new BackupRequirementError('Backup source changed. Retry after current writes finish.');
      const after = await fs.lstat(entry.source);
      if (
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.ctimeMs !== stat.ctimeMs ||
        after.mtimeMs !== stat.mtimeMs ||
        (entry.target !== undefined && (await fs.readlink(entry.source)) !== entry.target)
      )
        throw new BackupRequirementError('Backup source changed. Retry after current writes finish.');
    }
  };
  await verifySpecial();
  const manifest: { name: string; bytes: number; sha256: string; mode: number; uid: number; gid: number; mtime: number }[] = [];
  for (const directory of inventory.directories) await fs.mkdir(path.join(destination, directory.name), { recursive: true, mode: 0o700 });
  progress({ stage: 'copying', completedBytes: 0, totalBytes: inventory.totalBytes });
  for (const file of inventory.files) {
    signal.throwIfAborted();
    const target = path.join(destination, file.name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const input = await fs.open(file.source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const before = await input.stat();
      const unchanged = (stat: typeof before) =>
        stat.isFile() &&
        stat.size === file.bytes &&
        stat.mtimeMs === file.mtime &&
        stat.ctimeMs === file.ctime &&
        stat.dev === file.device &&
        stat.ino === file.inode;
      if (!unchanged(before) || (await fs.realpath(file.source)) !== path.resolve(file.source))
        throw new BackupRequirementError('Backup source changed. Retry after current writes finish.');
      output = await fs.open(target, 'wx', 0o600);
      const handle = output;
      const hash = createHash('sha256');
      let count = 0;
      await pipeline(
        input.createReadStream({ autoClose: false }),
        async (chunks: AsyncIterable<Buffer>) => {
          for await (const chunk of chunks) {
            signal.throwIfAborted();
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
              if (!bytesWritten) throw new BackupRequirementError('Backup storage could not be written.');
              offset += bytesWritten;
            }
            hash.update(chunk);
            count += chunk.length;
            completed += chunk.length;
            progress({ stage: 'copying', completedBytes: completed, totalBytes: inventory.totalBytes });
          }
        },
        { signal },
      );
      if (!unchanged(await input.stat()) || count !== file.bytes)
        throw new BackupRequirementError('Backup source changed. Retry after current writes finish.');
      manifest.push({ name: file.name, bytes: count, sha256: hash.digest('hex'), mode: file.mode, uid: file.uid, gid: file.gid, mtime: file.mtime });
    } finally {
      await output?.close();
      await input.close();
    }
  }
  await verifySpecial();
  return manifest;
}

export async function archiveBackup(content: string, archive: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const output = await fs.open(archive, 'wx', 0o600);
  const child = spawn(
    'tar',
    ['--format=pax', '--no-xattrs', ...(process.platform === 'darwin' ? ['--no-fflags'] : []), '-czf', '-', '-C', content, '.'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    },
  );
  let hasErrors = false;
  child.stderr.on('data', () => {
    hasErrors = true;
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 && !hasErrors ? resolve() : reject(new Error('The backup archive could not be completed.'))));
  });
  // Attach a handler before streaming so an early process failure is never unhandled.
  const failed = exited.catch((error) => {
    child.stdout.destroy(error);
    throw error;
  });
  failed.catch(() => undefined);
  try {
    await Promise.all([
      pipeline(
        child.stdout,
        async (chunks: AsyncIterable<Buffer>) => {
          for await (const chunk of chunks) {
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
              if (!bytesWritten) throw new BackupRequirementError('The backup archive could not be written.');
              offset += bytesWritten;
            }
          }
        },
        { signal },
      ),
      failed,
    ]);
    await output.sync();
  } finally {
    child.kill();
    await output.close();
  }
}

export async function packageBackup(options: {
  directory: string;
  content: string;
  passphrase: string;
  signal: AbortSignal;
  progress: (value: BackupProgress) => void;
  maximumPlaintextBytes?: number;
}) {
  const archive = path.join(options.directory, `${randomUUID()}.tar.gz`);
  const encrypted = path.join(options.directory, 'backup.orbis');
  try {
    options.progress({ stage: 'archiving', completedBytes: 0, totalBytes: null });
    await archiveBackup(options.content, archive, options.signal);
    if (options.maximumPlaintextBytes !== undefined && (await fs.stat(archive)).size > options.maximumPlaintextBytes)
      throw new BackupRequirementError('This capture exceeds the supported encrypted file size.');
    options.progress({ stage: 'encrypting', completedBytes: 0, totalBytes: (await fs.stat(archive)).size });
    await encryptBackup({
      source: archive,
      destination: encrypted,
      passphrase: options.passphrase,
      signal: options.signal,
      onProgress: (completedBytes, totalBytes) => options.progress({ stage: 'encrypting', completedBytes, totalBytes }),
    });
    return encrypted;
  } finally {
    await fs.rm(archive, { force: true });
  }
}
