import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { settingsSchema } from '@/app.dto';
import { BackupRequirementError } from './backup-files';
import { BackupExtractionBudget } from './backup-extraction-budget';
import { fullBackupLimits } from './backup-limits';
import { validateBackupSource, type BackupSourceSeal } from './backup-restore-source';
import type { RestoreFileReview } from './backup-restore-files';

export const restoreTreeNames = ['state', 'apps', 'repos', 'media', 'user-config', 'traefik', 'app-data'] as const;
export type RestoreTreeName = (typeof restoreTreeNames)[number];
export type RestoreSettingsOverride = {
  original: { bytes: number; sha256: string };
  replacement: Uint8Array;
};
export type RestoreMaterializeProgress = {
  stage: 'copying' | 'metadata' | 'prepared';
  completedBytes: number;
  totalBytes: number;
  files: number;
  totalFiles: number;
  directories: number;
  totalDirectories: number;
};
type Attributes = { uid: number; gid: number; mode: number; mtime: number };
const failed = () => new BackupRequirementError('Restore files could not be prepared. Your current server data has not been replaced.');
const inside = (root: string, target: string) => target === root || target.startsWith(`${root}${path.sep}`);
const settingsName = 'data/state/settings.json';
const settingsLimit = 1024 * 1024;

function settingsOverride(value: RestoreSettingsOverride | undefined) {
  if (value === undefined) return undefined;
  if (
    !value ||
    !value.original ||
    !Number.isSafeInteger(value.original.bytes) ||
    value.original.bytes < 0 ||
    typeof value.original.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.original.sha256) ||
    !(value.replacement instanceof Uint8Array) ||
    !value.replacement.byteLength ||
    value.replacement.byteLength > settingsLimit
  )
    throw failed();
  const replacement = Buffer.from(value.replacement);
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(replacement));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    settingsSchema.partial().onUndeclaredKey('reject')(parsed) instanceof type.errors
  )
    throw failed();
  return { original: { ...value.original }, replacement, sha256: createHash('sha256').update(replacement).digest('hex') };
}

async function privateDirectory(directory: string) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || (await fs.realpath(directory)) !== directory) throw failed();
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw failed();
}
function locate(name: string) {
  const parts = name.split('/');
  const root = parts[0] === 'app-data' ? 'app-data' : parts[0] === 'data' ? parts[1] : undefined;
  if (!restoreTreeNames.includes(root as RestoreTreeName)) throw failed();
  return { root: root as RestoreTreeName, relative: parts.slice(root === 'app-data' ? 1 : 2).join('/') };
}
async function attributes(handle: FileHandle, entry: Attributes) {
  const stat = await handle.stat();
  if (stat.uid !== entry.uid || stat.gid !== entry.gid) await handle.chown(entry.uid, entry.gid);
  await handle.chmod(entry.mode);
  await handle.utimes(entry.mtime / 1000, entry.mtime / 1000);
  await handle.sync();
}

async function capacity(
  roots: Record<RestoreTreeName, string>,
  ledger: string,
  files: { name: string; bytes: number }[],
  directories: { name: string }[],
) {
  const volumes = new Map<bigint, { directory: string; bytes: bigint; inodes: bigint; block: bigint }>();
  const volume = async (directory: string) => {
    const { dev } = await fs.lstat(directory, { bigint: true });
    let item = volumes.get(dev);
    if (!item) {
      const stat = await fs.statfs(directory, { bigint: true });
      if (stat.bsize <= 0n || stat.bsize > 16n * 1024n * 1024n) throw failed();
      item = { directory, bytes: 0n, inodes: 0n, block: stat.bsize };
      volumes.set(dev, item);
    }
    return item;
  };
  const byRoot = new Map<RestoreTreeName, Awaited<ReturnType<typeof volume>>>();
  for (const name of restoreTreeNames) byRoot.set(name, await volume(roots[name]));
  for (const entry of files) {
    if (entry.name === 'data/.env') continue;
    const item = byRoot.get(locate(entry.name).root);
    if (!item) throw failed();
    const size = BigInt(entry.bytes);
    item.bytes += ((size + item.block - 1n) / item.block + 1n) * item.block;
    item.inodes++;
  }
  for (const entry of directories) {
    const target = locate(entry.name);
    if (!target.relative) continue;
    const item = byRoot.get(target.root);
    if (!item) throw failed();
    item.bytes += item.block * 2n;
    item.inodes++;
  }
  const journal = await volume(path.dirname(ledger));
  journal.bytes += 64n * 1024n * 1024n;
  journal.inodes++;
  for (const item of volumes.values()) {
    const stat = await fs.statfs(item.directory, { bigint: true });
    if (
      stat.bavail * stat.bsize < item.bytes + BigInt(fullBackupLimits.reserveBytes) ||
      stat.ffree < item.inodes + BigInt(fullBackupLimits.reserveInodes)
    )
      throw new BackupRequirementError(
        'There is not enough free storage or file entries to prepare this restore. Your current server data has not been replaced.',
      );
  }
}

export async function materializeBackupSource(options: {
  directory: string;
  expected: BackupSourceSeal;
  roots: Record<RestoreTreeName, string>;
  ledger: string;
  signal: AbortSignal;
  progress: (value: RestoreMaterializeProgress) => void;
  settingsOverride?: RestoreSettingsOverride;
}) {
  const { signal, roots } = options;
  try {
    const override = settingsOverride(options.settingsOverride);
    const source = await validateBackupSource(options);
    const sourceSettings = source.manifest.files.find((entry) => entry.name === settingsName);
    if (override && (!sourceSettings || sourceSettings.bytes !== override.original.bytes || sourceSettings.sha256 !== override.original.sha256))
      throw failed();
    const names = Object.keys(roots);
    if (names.length !== restoreTreeNames.length || names.some((name) => !restoreTreeNames.includes(name as RestoreTreeName))) throw failed();
    if (!path.isAbsolute(options.ledger) || path.resolve(options.ledger) !== options.ledger || inside(source.directory, options.ledger))
      throw failed();
    await privateDirectory(path.dirname(options.ledger));
    const targets = Object.values(roots);
    for (const directory of targets) {
      await privateDirectory(directory);
      if (
        inside(source.directory, directory) ||
        inside(directory, source.directory) ||
        inside(directory, options.ledger) ||
        targets.some((other) => other !== directory && (inside(other, directory) || inside(directory, other))) ||
        (await fs.readdir(directory)).length
      )
        throw failed();
    }
    if (new Set(targets).size !== restoreTreeNames.length) throw failed();
    const environment = source.manifest.files.find((entry) => entry.name === 'data/.env');
    if (!environment || !source.manifest.files.some((entry) => entry.name === 'data/state/seed')) throw failed();
    const totalBytes = source.manifest.files.reduce((total, entry) => total + entry.bytes, 0);
    if (!Number.isSafeInteger(totalBytes)) throw failed();
    await capacity(
      roots,
      options.ledger,
      source.manifest.files.map((entry) => ({
        name: entry.name,
        bytes: override && entry.name === settingsName ? override.replacement.length : entry.bytes,
      })),
      source.manifest.directories,
    );
    const budgets = Object.fromEntries(restoreTreeNames.map((name) => [name, new BackupExtractionBudget(roots[name])])) as Record<
      RestoreTreeName,
      BackupExtractionBudget
    >;
    const progress: RestoreMaterializeProgress = {
      stage: 'copying',
      completedBytes: 0,
      totalBytes,
      files: 0,
      totalFiles: source.manifest.files.length,
      directories: 0,
      totalDirectories: source.manifest.directories.filter((entry) => locate(entry.name).relative).length,
    };
    options.progress({ ...progress });
    signal.throwIfAborted();
    const ledger = await fs.open(options.ledger, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const review: RestoreFileReview = { bytes: 0, sha256: '', files: 0, directories: 0 };
    const digest = createHash('sha256');
    const writeEntry = async (entry: Record<string, unknown>) => {
      signal.throwIfAborted();
      const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
      review.bytes += bytes.length;
      if (review.bytes > 64 * 1024 * 1024) throw failed();
      await ledger.writeFile(bytes);
      digest.update(bytes);
    };
    const directories = source.manifest.directories
      .map((entry) => ({ ...entry, ...locate(entry.name) }))
      .filter((entry) => entry.relative)
      .sort((a, b) => a.relative.split('/').length - b.relative.split('/').length || a.name.localeCompare(b.name));
    try {
      for (const entry of directories) {
        signal.throwIfAborted();
        await budgets[entry.root].reserve(entry.relative, 'd', 0);
        await fs.mkdir(path.join(roots[entry.root], entry.relative), { mode: 0o700 });
      }
      for (const entry of source.manifest.files) {
        signal.throwIfAborted();
        const inputPath = path.join(source.directory, 'content', entry.name);
        if ((await fs.realpath(inputPath)) !== inputPath) throw failed();
        const input = await fs.open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let output: FileHandle | undefined;
        try {
          const before = await input.stat();
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.mode & 0o077 ||
            before.size !== entry.bytes ||
            (process.getuid && before.uid !== process.getuid())
          )
            throw failed();
          const destination = entry.name === 'data/.env' ? undefined : locate(entry.name);
          const replacement = entry.name === settingsName ? override : undefined;
          const openOutput = async (size: number) => {
            if (!destination) throw failed();
            if (!destination.relative) throw failed();
            await budgets[destination.root].reserve(destination.relative, '-', size);
            const outputPath = path.join(roots[destination.root], destination.relative);
            if ((await fs.realpath(path.dirname(outputPath))) !== path.dirname(outputPath)) throw failed();
            return fs.open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          };
          if (destination && !replacement) output = await openOutput(entry.bytes);
          const hash = createHash('sha256');
          let bytes = 0;
          for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal })) {
            signal.throwIfAborted();
            bytes += chunk.length;
            if (bytes > entry.bytes) throw failed();
            hash.update(chunk);
            await output?.writeFile(chunk);
            if (destination && output) await budgets[destination.root].written(chunk.length);
            progress.completedBytes += chunk.length;
            options.progress({ ...progress });
          }
          const after = await input.stat();
          if (
            bytes !== entry.bytes ||
            hash.digest('hex') !== entry.sha256 ||
            before.ino !== after.ino ||
            before.dev !== after.dev ||
            before.ctimeMs !== after.ctimeMs ||
            before.mtimeMs !== after.mtimeMs ||
            before.size !== after.size
          )
            throw failed();
          if (replacement && destination) {
            signal.throwIfAborted();
            output = await openOutput(replacement.replacement.length);
            signal.throwIfAborted();
            await output.writeFile(replacement.replacement);
            await budgets[destination.root].written(replacement.replacement.length);
          }
          if (output && destination) {
            await attributes(output, entry);
            await writeEntry({
              root: destination.root,
              name: destination.relative,
              kind: 'file',
              uid: entry.uid,
              gid: entry.gid,
              mode: entry.mode,
              mtime: entry.mtime,
              bytes: replacement ? replacement.replacement.length : entry.bytes,
              sha256: replacement ? replacement.sha256 : entry.sha256,
            });
            review.files++;
          }
          progress.files++;
          options.progress({ ...progress });
        } finally {
          try {
            await output?.close();
          } finally {
            await input.close();
          }
        }
      }
      progress.stage = 'metadata';
      options.progress({ ...progress });
      // Restore directory timestamps after creating children; staging roots keep their private target permissions.
      for (const entry of directories.reverse()) {
        signal.throwIfAborted();
        const directory = path.join(roots[entry.root], entry.relative);
        if ((await fs.realpath(directory)) !== directory) throw failed();
        const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await attributes(handle, entry);
        } finally {
          await handle.close();
        }
        await writeEntry({
          root: entry.root,
          name: entry.relative,
          kind: 'directory',
          uid: entry.uid,
          gid: entry.gid,
          mode: entry.mode,
          mtime: entry.mtime,
        });
        review.directories++;
        progress.directories++;
        options.progress({ ...progress });
      }
      await ledger.sync();
      review.sha256 = digest.digest('hex');
    } finally {
      await ledger.close();
    }
    for (const directory of [...targets, path.dirname(options.ledger)]) {
      const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    signal.throwIfAborted();
    progress.stage = 'prepared';
    options.progress({ ...progress });
    return {
      files: review,
      // The source environment is verified, not installed. Target host configuration must be explicitly rebased.
      environment: { file: path.join(source.directory, 'content', environment.name), bytes: environment.bytes, sha256: environment.sha256 },
      resumeApps: source.resumeApps,
    };
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof BackupRequirementError) throw error;
    throw failed();
  }
}
