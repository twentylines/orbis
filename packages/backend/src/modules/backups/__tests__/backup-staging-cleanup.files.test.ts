import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as maintenance from '@/common/backup-maintenance';
import * as installation from '@/common/installation-mode';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@runtipi/common/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupStagingCleanup } from '../backup-staging-cleanup';

const urn = 'demo:store' as AppUrn;
let root: string;
let data: string;
let records: string;
let cleanup: BackupStagingCleanup;
const logger = { warn: vi.fn() } as unknown as LoggerService;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(await fs.promises.realpath(tmpdir()), 'backup-cleanup-'));
  data = path.join(root, 'data');
  records = path.join(data, 'state', 'backup-staging-cleanup');
  await fs.promises.mkdir(data);
  cleanup = new BackupStagingCleanup(() => data, logger);
  vi.spyOn(maintenance, 'coreCaptureRecoveryRequired').mockReturnValue(false);
  vi.spyOn(maintenance, 'corePreparationRecoveryHeld').mockReturnValue(false);
  vi.spyOn(installation, 'installationMode').mockReturnValue({ phase: 'normal', transactionId: null });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function stage(kind: 'snapshot' | 'restore' | 'partial' = 'snapshot', parent = root) {
  if (kind === 'partial') {
    const file = path.join(data, 'backups/store/demo', `.demo-store-${Date.now()}-${randomUUID()}.partial`);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, 'partial archive fixture', { mode: 0o600 });
    return file;
  }
  const directory = await fs.promises.mkdtemp(path.join(parent, `${urn}${kind === 'restore' ? '-restore' : ''}-`));
  await fs.promises.writeFile(path.join(directory, 'fixture'), 'private staged fixture');
  return directory;
}

async function retain(target: string, kind: 'snapshot' | 'restore' | 'partial' = 'snapshot') {
  const failure = vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('Fixture storage unavailable'));
  await cleanup.dispose(urn, kind, target);
  failure.mockRestore();
  expect(fs.existsSync(target)).toBe(true);
  const names = await fs.promises.readdir(records);
  expect(names).toHaveLength(1);
  const file = path.join(records, names[0] ?? 'missing');
  expect((await fs.promises.stat(records)).mode & 0o777).toBe(0o700);
  expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o600);
  return file;
}

it.each(['snapshot', 'restore', 'partial'] as const)('retries an explicitly disposable %s after a failed removal in a new instance', async (kind) => {
  const target = await stage(kind);
  await retain(target, kind);
  await new BackupStagingCleanup(() => data, logger).recover();
  expect(fs.existsSync(target)).toBe(false);
  expect(await fs.promises.readdir(records)).toEqual([]);
});

it('removes normal staging without creating a cleanup journal', async () => {
  const target = await stage();
  await cleanup.dispose(urn, 'snapshot', target);
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.existsSync(records)).toBe(false);
});

it('preserves unregistered staging, completed backups, and migration/restore recovery material', async () => {
  const target = await stage();
  const recovery = path.join(data, 'state', 'app-restores', urn, 'journal.json');
  const migration = path.join(data, 'state', 'app-updates', urn, 'before.tar.gz');
  const backup = path.join(data, 'backups/store/demo/completed.tar.gz');
  for (const file of [recovery, migration, backup]) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, 'retained evidence');
  }
  await cleanup.recover();
  expect(fs.existsSync(target)).toBe(true);
  for (const file of [recovery, migration, backup]) expect(await fs.promises.readFile(file, 'utf8')).toBe('retained evidence');
});

it.each(['hold', 'resume', 'capture', 'preparation'] as const)('does no cleanup during %s', async (mode) => {
  const target = await stage();
  await retain(target);
  if (mode === 'capture') vi.mocked(maintenance.coreCaptureRecoveryRequired).mockReturnValue(true);
  else if (mode === 'preparation') vi.mocked(maintenance.corePreparationRecoveryHeld).mockReturnValue(true);
  else vi.mocked(installation.installationMode).mockReturnValue({ phase: mode, transactionId: randomUUID() });
  const remove = vi.spyOn(fs.promises, 'rm');
  await cleanup.recover();
  expect(remove).not.toHaveBeenCalled();
  expect(fs.existsSync(target)).toBe(true);
  expect(await fs.promises.readdir(records)).toHaveLength(1);
});

it.each(['directory', 'symlink'] as const)('preserves a replacement %s at the recorded target', async (kind) => {
  const target = await stage();
  await retain(target);
  const original = path.join(root, 'original');
  await fs.promises.rename(target, original);
  if (kind === 'directory') {
    await fs.promises.mkdir(target, { mode: 0o700 });
    await fs.promises.writeFile(path.join(target, 'fixture'), 'replacement');
  } else await fs.promises.symlink(original, target);
  await cleanup.recover();
  expect(await fs.promises.readFile(path.join(original, 'fixture'), 'utf8')).toBe('private staged fixture');
  expect(await fs.promises.readFile(path.join(target, 'fixture'), 'utf8')).toBe(kind === 'directory' ? 'replacement' : 'private staged fixture');
  expect(await fs.promises.readdir(records)).toHaveLength(1);
});

it.each(['malformed', 'utf8', 'large', 'permissive', 'hardlink', 'symlink'] as const)(
  'preserves staging when its cleanup record is %s',
  async (fault) => {
    const target = await stage();
    const record = await retain(target);
    if (fault === 'malformed') await fs.promises.writeFile(record, '{}');
    if (fault === 'utf8') {
      const bytes = await fs.promises.readFile(record);
      const offset = bytes.indexOf('backup-cleanup-');
      expect(offset).toBeGreaterThan(0);
      bytes[offset] = 255;
      await fs.promises.writeFile(record, bytes);
    }
    if (fault === 'large') await fs.promises.writeFile(record, Buffer.alloc(8193));
    if (fault === 'permissive') await fs.promises.chmod(record, 0o644);
    if (fault === 'hardlink') await fs.promises.link(record, path.join(root, 'linked-record'));
    if (fault === 'symlink') {
      await fs.promises.rename(record, path.join(root, 'held-record'));
      await fs.promises.symlink(path.join(root, 'held-record'), record);
    }
    await cleanup.recover();
    expect(fs.existsSync(target)).toBe(true);
    expect(await fs.promises.readdir(records)).toHaveLength(1);
  },
);

it('retains the same receipt if cleanup fails again instead of growing duplicate records', async () => {
  const target = await stage();
  const record = await retain(target);
  const before = await fs.promises.readFile(record);
  vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('Still unavailable'));
  await cleanup.recover();
  expect(await fs.promises.readFile(record)).toEqual(before);
  expect(await fs.promises.readdir(records)).toHaveLength(1);
});

it('does not throw through the completed operation when cleanup logging also fails', async () => {
  const target = await stage();
  vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('Cleanup failed'));
  const failedLogger = {
    warn: () => {
      throw new Error('Logger failed');
    },
  } as unknown as LoggerService;
  await expect(new BackupStagingCleanup(() => data, failedLogger).dispose(urn, 'snapshot', target)).resolves.toBeUndefined();
  expect(fs.existsSync(target)).toBe(true);
  expect(await fs.promises.readdir(records)).toHaveLength(1);
});

it('forgets an already-removed target but keeps unknown temporary record files', async () => {
  const target = await stage();
  await retain(target);
  await fs.promises.rm(target, { recursive: true });
  await fs.promises.writeFile(path.join(records, '.unfinished.tmp'), 'unfinished');
  await cleanup.recover();
  expect(await fs.promises.readdir(records)).toEqual(['.unfinished.tmp']);
});

it('retires a partial-file receipt after its entire backup directory was removed', async () => {
  const target = await stage('partial');
  await retain(target, 'partial');
  await fs.promises.rm(path.dirname(target), { recursive: true });
  await cleanup.recover();
  expect(await fs.promises.readdir(records)).toEqual([]);
});

it('rejects a cleanup receipt that points at a protected restore journal', async () => {
  const target = await stage();
  const file = await retain(target);
  const journal = path.join(data, 'state', 'app-restores', urn, 'journal.json');
  await fs.promises.mkdir(path.dirname(journal), { recursive: true });
  await fs.promises.writeFile(journal, 'protected', { mode: 0o600 });
  const entry = await fs.promises.stat(journal, { bigint: true });
  await fs.promises.writeFile(
    file,
    JSON.stringify({
      version: 1,
      appUrn: urn,
      kind: 'partial',
      target: journal,
      dev: entry.dev.toString(),
      ino: entry.ino.toString(),
      birthtimeNs: entry.birthtimeNs.toString(),
      uid: Number(entry.uid),
    }),
  );
  await cleanup.recover();
  expect(await fs.promises.readFile(journal, 'utf8')).toBe('protected');
  expect(fs.existsSync(target)).toBe(true);
});

it('does not follow a symlinked receipt directory or change its permissions', async () => {
  const target = await stage();
  await retain(target);
  const held = path.join(root, 'held-records');
  await fs.promises.rename(records, held);
  await fs.promises.symlink(held, records);
  await cleanup.recover();
  expect(fs.existsSync(target)).toBe(true);
  expect((await fs.promises.readdir(held)).length).toBe(1);
});

it('leaves a permissive cleanup directory and its staging unchanged', async () => {
  const target = await stage();
  await retain(target);
  await fs.promises.chmod(records, 0o755);
  await cleanup.recover();
  expect(fs.existsSync(target)).toBe(true);
  expect((await fs.promises.stat(records)).mode & 0o777).toBe(0o755);
  expect(await fs.promises.readdir(records)).toHaveLength(1);
});

it('does not classify a permissive partial file as owned disposable staging', async () => {
  const target = await stage('partial');
  await fs.promises.chmod(target, 0o644);
  await cleanup.dispose(urn, 'partial', target);
  expect(fs.existsSync(target)).toBe(true);
  expect(fs.existsSync(records)).toBe(false);
});

it('refuses a symlink inserted into a recorded target ancestor', async () => {
  const parent = path.join(root, 'parent');
  await fs.promises.mkdir(parent);
  const target = await stage('snapshot', parent);
  await retain(target);
  const held = path.join(root, 'held-parent');
  await fs.promises.rename(parent, held);
  await fs.promises.symlink(held, parent);
  await cleanup.recover();
  expect(fs.existsSync(target)).toBe(true);
  expect(await fs.promises.readdir(records)).toHaveLength(1);
});

it.skipIf(process.platform !== 'linux')(
  'removes only the recorded inode through its pinned Linux parent during a directory-name replacement',
  async () => {
    const parent = path.join(root, 'parent');
    await fs.promises.mkdir(parent);
    const target = await stage('snapshot', parent);
    await retain(target);
    const held = path.join(root, 'held-parent');
    const open = fs.promises.open.bind(fs.promises);
    let replaced = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (!replaced && String(args[0]) === parent) {
        replaced = true;
        await fs.promises.rename(parent, held);
        await fs.promises.mkdir(parent);
        await fs.promises.mkdir(target, { mode: 0o700 });
        await fs.promises.writeFile(path.join(target, 'fixture'), 'replacement');
      }
      return handle;
    });
    await cleanup.recover();
    expect(replaced).toBe(true);
    expect(await fs.promises.readFile(path.join(target, 'fixture'), 'utf8')).toBe('replacement');
    expect(fs.existsSync(path.join(held, path.basename(target)))).toBe(false);
    expect(await fs.promises.readdir(records)).toEqual([]);
  },
);
