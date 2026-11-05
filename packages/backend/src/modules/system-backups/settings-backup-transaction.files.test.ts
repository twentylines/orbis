import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsBackupTransaction } from './settings-backup-transaction';
import { acquireRestoreLease, withRestoreLease } from './backup-restore-lease';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';

let root: string;
let restore: () => void;
const signal = new AbortController().signal;
const store = () => path.join(root, 'backups', 'settings-restores');
const options = () => ({
  dataDir: root,
  ownerId: 7,
  importId: randomUUID(),
  reviewId: randomUUID(),
  archiveSha256: 'a'.repeat(64),
  signal,
  files: [
    { relative: 'desktop/7.json', data: Buffer.from('new desktop') },
    { relative: 'settings.json', data: Buffer.from('new settings') },
    { relative: 'wallpapers/7.image', data: Buffer.from('new selected image') },
  ],
});
async function seed(relative: string, data: string, mode = 0o600) {
  const filename = path.join(root, 'state', relative);
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, data, { mode });
  stabilizeExistingDarwinFixtures(root);
  return filename;
}
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'settings-transaction-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
  await seed('desktop/7.json', 'original desktop');
  await seed('settings.json', 'original settings', 0o644);
});
afterEach(async () => {
  vi.restoreAllMocks();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});

it('durably prepares encrypted previous and incoming state without touching any settings or Docker data', async () => {
  await withRestoreLease(store(), async () => {
    const transaction = await SettingsBackupTransaction.prepare(options());
    expect(transaction.state.phase).toBe('prepared');
    expect(await fs.readFile(path.join(root, 'state/desktop/7.json'), 'utf8')).toBe('original desktop');
    const journal = await fs.readFile(path.join(transaction.directory, 'journal.json'), 'utf8');
    expect(journal.includes('original desktop')).toBe(false);
    expect(journal.includes('new desktop')).toBe(false);
    const before = await fs.readFile(path.join(transaction.directory, 'before-0.orbis'));
    expect(before.includes(Buffer.from('original desktop'))).toBe(false);
    expect((await fs.stat(path.join(store(), 'recovery.key'))).mode & 0o777).toBe(0o600);
    await expect(SettingsBackupTransaction.prepare(options())).rejects.toThrow('recovery');
    await transaction.applyFiles(signal);
    await transaction.complete();
    expect((await SettingsBackupTransaction.active(root))?.state.phase).toBe('complete');
  });
  expect(await fs.readFile(path.join(root, 'state/desktop/7.json'), 'utf8')).toBe('new desktop');
  expect(await fs.readFile(path.join(root, 'state/settings.json'), 'utf8')).toBe('new settings');
  expect((await fs.stat(path.join(root, 'state/settings.json'))).mode & 0o777).toBe(0o600);
});

it('recovers a partial interrupted promotion after reopening the journal, restoring exact prior bytes and permissions', async () => {
  await withRestoreLease(store(), async () => {
    const transaction = await SettingsBackupTransaction.prepare(options());
    const rename = fs.rename.bind(fs);
    const injection = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(root, 'state/settings.json')) throw new Error('Simulated process interruption');
      return rename(from, to);
    });
    await expect(transaction.applyFiles(signal)).rejects.toThrow('interruption');
    injection.mockRestore();
    expect(await fs.readFile(path.join(root, 'state/desktop/7.json'), 'utf8')).toBe('new desktop');
  });
  await withRestoreLease(store(), async () => {
    const recovered = await SettingsBackupTransaction.active(root);
    if (!recovered) throw new Error('Missing durable operation');
    await recovered.rollback(signal);
    expect(recovered.state.phase).toBe('rolled-back');
  });
  expect(await fs.readFile(path.join(root, 'state/desktop/7.json'), 'utf8')).toBe('original desktop');
  expect(await fs.readFile(path.join(root, 'state/settings.json'), 'utf8')).toBe('original settings');
  expect((await fs.stat(path.join(root, 'state/settings.json'))).mode & 0o777).toBe(0o644);
  expect((await fs.readdir(path.join(root, 'state'))).some((name) => name.startsWith('.orbis-settings-'))).toBe(false);
  await expect(fs.stat(path.join(root, 'state/wallpapers/7.image'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses to overwrite a new unrelated value during rollback and retains the recovery hold', async () => {
  await withRestoreLease(store(), async () => {
    const transaction = await SettingsBackupTransaction.prepare(options());
    await transaction.applyFiles(signal);
    await seed('desktop/7.json', 'unrelated later change');
    await expect(transaction.rollback(signal)).rejects.toThrow('recovery');
    expect(transaction.state.phase).toBe('recovery');
    expect(await fs.readFile(path.join(root, 'state/desktop/7.json'), 'utf8')).toBe('unrelated later change');
    expect((await SettingsBackupTransaction.active(root))?.state.phase).toBe('recovery');
  });
});

it('preserves an independent edit made while the replacement is being staged', async () => {
  await withRestoreLease(store(), async () => {
    const transaction = await SettingsBackupTransaction.prepare(options());
    const target = path.join(root, 'state/desktop/7.json');
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (String(file).endsWith(`.orbis-settings-${transaction.state.id}-0.tmp`)) await fs.writeFile(target, 'independent later edit');
      return handle;
    });
    await expect(transaction.applyFiles(signal)).rejects.toThrow('recovery');
    expect(await fs.readFile(target, 'utf8')).toBe('independent later edit');
    await expect(transaction.rollback(signal)).rejects.toThrow('recovery');
    expect(await fs.readFile(target, 'utf8')).toBe('independent later edit');
    expect((await SettingsBackupTransaction.active(root))?.state.phase).toBe('recovery');
  });
});

it('rejects forged target scope, writable parents, symlinks and linked originals before publishing an intent', async () => {
  await expect(SettingsBackupTransaction.prepare({ ...options(), files: [{ relative: '../app-data/media', data: null }] })).rejects.toThrow();
  await expect(SettingsBackupTransaction.prepare({ ...options(), files: [{ relative: 'desktop/8.json', data: null }] })).rejects.toThrow();
  const filename = path.join(root, 'state/desktop/7.json');
  await fs.link(filename, path.join(root, 'linked'));
  await expect(SettingsBackupTransaction.prepare(options())).rejects.toThrow();
  await fs.unlink(path.join(root, 'linked'));
  await fs.rename(filename, path.join(root, 'original'));
  await fs.symlink(path.join(root, 'original'), filename);
  await expect(SettingsBackupTransaction.prepare(options())).rejects.toThrow();
  await fs.unlink(filename);
  await fs.rename(path.join(root, 'original'), filename);
  await fs.chmod(path.join(root, 'state'), 0o777);
  await expect(SettingsBackupTransaction.prepare(options())).rejects.toThrow();
  expect(await SettingsBackupTransaction.active(root)).toBeNull();
});

it('retains recovery after encrypted rollback corruption and refuses a competing process-shared lease', async () => {
  const release = await acquireRestoreLease(store());
  try {
    await expect(acquireRestoreLease(store())).rejects.toThrow();
    const transaction = await SettingsBackupTransaction.prepare(options());
    await transaction.applyFiles(signal);
    await fs.writeFile(path.join(transaction.directory, 'before-0.orbis'), Buffer.from('corrupted encrypted recovery data'), { mode: 0o600 });
    stabilizeExistingDarwinFixtures(root);
    await expect(transaction.rollback(signal)).rejects.toThrow();
    expect(transaction.state.phase).toBe('recovery');
    expect(await fs.readFile(path.join(root, 'state/desktop/7.json'), 'utf8')).toBe('new desktop');
  } finally {
    release();
  }
});

it('requires confirmed capture cleanup before rolling back imported library changes', async () => {
  await withRestoreLease(store(), async () => {
    const capture = { pointId: randomUUID(), createdAt: 1, archiveSha256: 'b'.repeat(64), metadataSha256: 'c'.repeat(64), existed: false };
    const transaction = await SettingsBackupTransaction.prepare({ ...options(), captures: [capture] });
    await transaction.applyFiles(signal);
    await expect(transaction.rollback(signal)).rejects.toThrow('recovery');
    const remove = vi.fn().mockResolvedValue(undefined);
    await transaction.rollback(signal, remove);
    expect(remove).toHaveBeenCalledWith(capture);
    expect(transaction.state.phase).toBe('rolled-back');
  });
});

it('removes only an authenticated partial temporary write during rollback and preserves unrecognized temporary content', async () => {
  await withRestoreLease(store(), async () => {
    const transaction = await SettingsBackupTransaction.prepare(options());
    const temporary = path.join(root, 'state/desktop', `.orbis-settings-${transaction.state.id}-0.tmp`);
    await fs.writeFile(temporary, 'new', { mode: 0o600 });
    stabilizeExistingDarwinFixtures(root);
    await transaction.rollback(signal);
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    const next = await SettingsBackupTransaction.prepare(options());
    const foreign = path.join(root, 'state/desktop', `.orbis-settings-${next.state.id}-0.tmp`);
    await fs.writeFile(foreign, 'unknown private data', { mode: 0o600 });
    stabilizeExistingDarwinFixtures(root);
    await expect(next.rollback(signal)).rejects.toThrow('recovery');
    expect(await fs.readFile(foreign, 'utf8')).toBe('unknown private data');
  });
});
