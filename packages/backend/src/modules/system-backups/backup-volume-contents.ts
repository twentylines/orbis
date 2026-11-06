import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { inspectDockerVolumeArchive, type BackupVolumeArchive, type BackupVolumeEntry } from './backup-docker-volumes';
import { BackupRequirementError } from './backup-files';
import { fullBackupLimits } from './backup-limits';

const failed = () => new BackupRequirementError('The backup’s app volume data is incomplete or changed. No server data has been replaced.');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type Seal = Awaited<ReturnType<FileHandle['stat']>>;
const same = (a: Seal, b: Seal) =>
  (['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const).every((key) => a[key] === b[key]);

export function backupVolumeContentBudget(manifest: {
  files: readonly { name: string }[];
  directories: readonly { name: string }[];
  symlinks?: readonly { name: string; target: string }[];
  excludedRuntimeSockets?: readonly string[];
}) {
  const entries =
    manifest.files.length + manifest.directories.length + (manifest.symlinks?.length ?? 0) + (manifest.excludedRuntimeSockets?.length ?? 0);
  let pathBytes = 0;
  for (const entry of [...manifest.files, ...manifest.directories, ...(manifest.symlinks ?? [])]) pathBytes += Buffer.byteLength(entry.name);
  for (const entry of manifest.symlinks ?? []) pathBytes += Buffer.byteLength(entry.target);
  for (const name of manifest.excludedRuntimeSockets ?? []) pathBytes += Buffer.byteLength(name);
  return { entries, pathBytes };
}

async function opened(file: string, expected: { bytes: number; sha256: string }, signal: AbortSignal, collect: boolean) {
  signal.throwIfAborted();
  if ((await fs.realpath(file)) !== file) throw failed();
  const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.uid !== process.geteuid?.() || before.size !== expected.bytes)
      throw failed();
    const digest = createHash('sha256');
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < expected.bytes) {
      signal.throwIfAborted();
      const bytes = Buffer.alloc(Math.min(64 * 1024, expected.bytes - offset));
      const { bytesRead } = await input.read(bytes, 0, bytes.length, offset);
      if (!bytesRead) throw failed();
      const chunk = bytes.subarray(0, bytesRead);
      digest.update(chunk);
      if (collect) chunks.push(chunk);
      offset += bytesRead;
    }
    if (digest.digest('hex') !== expected.sha256 || !same(before, await input.stat()) || !same(before, await fs.lstat(file))) throw failed();
    return { input, before, bytes: collect ? Buffer.concat(chunks) : undefined };
  } catch (error) {
    await input.close();
    throw error;
  }
}

export async function verifyBackupVolumeContents(
  content: string,
  volumes: readonly BackupVolumeArchive[],
  signal: AbortSignal,
  baseline = { entries: 0, pathBytes: 0 },
) {
  if (!volumes.length) return { entries: 0, bytes: 0 };
  try {
    const directory = path.join(content, 'volumes');
    if (!path.isAbsolute(content) || path.resolve(content) !== content || (await fs.realpath(directory)) !== directory) throw failed();
    const root = await fs.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077 || root.uid !== process.geteuid?.()) throw failed();
    const expectedNames = volumes.flatMap((volume) => [path.posix.basename(volume.archive.name), path.posix.basename(volume.inventory.name)]);
    if ((await fs.readdir(directory)).sort(compare).join('\n') !== expectedNames.sort(compare).join('\n')) throw failed();
    let entries = 0;
    let paths = baseline.pathBytes;
    if (
      !Number.isSafeInteger(baseline.entries) ||
      baseline.entries < 0 ||
      baseline.entries > fullBackupLimits.entries ||
      !Number.isSafeInteger(paths) ||
      paths < 0 ||
      paths > fullBackupLimits.pathBytes
    )
      throw failed();
    let metadataBytes = 0;
    let bytes = 0;
    for (const volume of volumes) {
      signal.throwIfAborted();
      metadataBytes += volume.inventory.bytes;
      if (metadataBytes > fullBackupLimits.manifestBytes) throw failed();
      const inventoryFile = path.join(content, volume.inventory.name);
      const inventory = await opened(inventoryFile, volume.inventory, signal, true);
      let archive: Awaited<ReturnType<typeof opened>> | undefined;
      try {
        if (!inventory.bytes) throw failed();
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory.bytes));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed();
        const record = value as Record<string, unknown>;
        if (
          Object.keys(record).sort().join(',') !== 'containerId,entries,key,sourceName,version' ||
          record.version !== 1 ||
          record.key !== volume.key ||
          record.sourceName !== volume.sourceName ||
          !volume.mounts.some((mount) => mount.containerId === record.containerId) ||
          !Array.isArray(record.entries)
        )
          throw failed();
        entries += record.entries.length;
        if (entries + baseline.entries > fullBackupLimits.entries) throw failed();
        const archiveFile = path.join(content, volume.archive.name);
        archive = await opened(archiveFile, volume.archive, signal, false);
        const inspected = await inspectDockerVolumeArchive(
          process.platform === 'linux' ? `/proc/self/fd/${archive.input.fd}` : archiveFile,
          volume.archive.root,
          volume.archive.bytes,
          signal,
          record.entries as BackupVolumeEntry[],
        );
        paths += inspected.pathBytes;
        for (const entry of record.entries as BackupVolumeEntry[])
          paths += Buffer.byteLength(entry.name) + (entry.kind === 'symlink' ? Buffer.byteLength(entry.target) : 0);
        if (
          paths > fullBackupLimits.pathBytes ||
          JSON.stringify(inspected.excludedRuntimeSockets) !== JSON.stringify([...volume.excludedRuntimeSockets].sort(compare))
        )
          throw failed();
        if (
          !same(archive.before, await archive.input.stat()) ||
          !same(archive.before, await fs.lstat(archiveFile)) ||
          !same(inventory.before, await inventory.input.stat()) ||
          !same(inventory.before, await fs.lstat(inventoryFile))
        )
          throw failed();
        bytes += volume.archive.bytes + volume.inventory.bytes;
        if (!Number.isSafeInteger(bytes)) throw failed();
      } finally {
        await archive?.input.close();
        await inventory.input.close();
      }
    }
    if (!same(root, await fs.lstat(directory))) throw failed();
    signal.throwIfAborted();
    return { entries, bytes };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof BackupRequirementError) throw error;
    throw failed();
  }
}
