import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { copyBackupFiles, inventoryBackup, packageBackup, privateBackupDirectory, type BackupProgress } from './backup-files';
import { decryptBackup } from './backup-crypto';
import { readTarArchive } from '@/core/archive/tar-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

let root: string;
let restoreDarwinCreation: () => void = () => undefined;
const command = promisify(execFile);
const signal = () => new AbortController().signal;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-export-files-')));
  restoreDarwinCreation = stabilizeDarwinFixtureCreation(() => root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  restoreDarwinCreation();
  await fs.rm(root, { recursive: true, force: true });
});

it('round-trips nested app data, an empty directory and private configuration with measured byte progress', async () => {
  const source = path.join(root, 'original');
  await fs.mkdir(path.join(source, 'empty'), { recursive: true });
  await fs.writeFile(path.join(source, 'data.bin'), Buffer.alloc(1024 * 1024, 31), { mode: 0o640 });
  await fs.writeFile(path.join(source, '.private-config'), 'disposable fixture configuration', { mode: 0o600 });
  stabilizeExistingDarwinFixtures(source);
  const inventory = await inventoryBackup([{ name: 'app-data', source, required: true }], signal());
  const content = path.join(root, 'content');
  await fs.mkdir(content, { mode: 0o700 });
  const progress: BackupProgress[] = [];
  const files = await copyBackupFiles(inventory, content, signal(), (value) => progress.push(value));
  expect(files).toHaveLength(2);
  expect(files.find((file) => file.name.endsWith('data.bin'))?.mode).toBe(0o640);
  expect(progress.at(-1)?.completedBytes).toBe(inventory.totalBytes);
  expect(progress.map((value) => value.completedBytes)).toEqual(progress.map((value) => value.completedBytes).sort((a, b) => a - b));
  if (process.platform === 'darwin')
    await command('/usr/bin/python3', [
      '-c',
      'import os,sys; p=sys.argv[1]; s=os.lstat(p); os.chflags(p,s.st_flags|0x40|0x8000,follow_symlinks=False)',
      path.join(content, 'app-data', 'data.bin'),
    ]);
  const encrypted = await packageBackup({
    directory: root,
    content,
    passphrase: 'disposable-export-passphrase',
    signal: signal(),
    progress: (value) => progress.push(value),
  });
  expect((await fs.stat(encrypted)).mode & 0o777).toBe(0o600);
  const archive = path.join(root, 'restored.tar.gz');
  if (process.platform === 'darwin')
    await command('/usr/bin/python3', [
      '-c',
      'import os,sys; s=os.lstat(sys.argv[1]); os.chflags(sys.argv[1],s.st_flags|0x40|0x8000,follow_symlinks=False)',
      encrypted,
    ]);
  await decryptBackup({ source: encrypted, destination: archive, passphrase: 'disposable-export-passphrase' });
  expect((await readTarArchive(archive, true, signal(), { strict: true })).some((entry) => entry.path.endsWith('data.bin'))).toBe(true);
  const restored = path.join(root, 'restored');
  await fs.mkdir(restored);
  await command('tar', ['-xzf', archive, '-C', restored]);
  expect(await fs.readFile(path.join(restored, 'app-data', 'data.bin'))).toEqual(await fs.readFile(path.join(source, 'data.bin')));
  expect(await fs.readdir(path.join(restored, 'app-data', 'empty'))).toEqual([]);
  expect((await fs.readdir(root)).some((name) => name.endsWith('.partial'))).toBe(false);
});

it('refuses a symbolic link instead of following it into another directory', async () => {
  await fs.mkdir(path.join(root, 'source'));
  await fs.writeFile(path.join(root, 'outside'), 'private fixture');
  await fs.symlink('../outside', path.join(root, 'source', 'link'));
  await expect(inventoryBackup([{ name: 'app-data', source: path.join(root, 'source') }], signal())).rejects.toThrow('links or special files');
});

it('records safe app-data links and sockets without copying or following them, and refuses replacement', async () => {
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'bin'), { recursive: true });
  await fs.writeFile(path.join(source, 'tool'), 'fixture');
  await fs.symlink('../tool', path.join(source, 'bin', 'tool'));
  const server = createServer();
  const previous = process.cwd();
  process.chdir(source);
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen('s', resolve));
    const inventory = await inventoryBackup([{ name: 'app-data', source }], signal(), [], { allowAppDataLinksAndSockets: true });
    expect(inventory.symlinks).toMatchObject([{ name: 'app-data/bin/tool', target: '../tool' }]);
    expect(inventory.excludedRuntimeSockets).toEqual(['app-data/s']);
    const content = path.join(root, 'content');
    await fs.mkdir(content);
    await copyBackupFiles(inventory, content, signal(), () => undefined);
    await expect(fs.lstat(path.join(content, 'app-data/bin/tool'))).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.unlink(path.join(source, 'bin', 'tool'));
    await fs.symlink('../tool', path.join(source, 'bin', 'tool'));
    await expect(copyBackupFiles(inventory, content, signal(), () => undefined)).rejects.toThrow('source changed');
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    process.chdir(previous);
  }
});

it.each(['/etc/passwd', '../../outside', '../missing', '../second'])('rejects unsafe, missing and chained link target %s', async (target) => {
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'bin'), { recursive: true });
  await fs.writeFile(path.join(source, 'tool'), 'fixture');
  await fs.symlink('tool', path.join(source, 'second'));
  await fs.symlink(target, path.join(source, 'bin', 'link'));
  await expect(inventoryBackup([{ name: 'app-data', source }], signal(), [], { allowAppDataLinksAndSockets: true })).rejects.toThrow();
});

it('excludes host reset intent and exact preference staging while retaining ordinary app data', async () => {
  const state = path.join(root, 'state');
  const stage = `.orbis-reset-stage-${randomUUID()}`;
  const journal = path.join(state, 'orbis-reset');
  const staged = path.join(state, 'desktop', stage);
  const ordinary = path.join(state, 'apps', stage);
  for (const directory of [journal, staged, ordinary]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(journal, 'active.json'), 'host-only intent');
  await fs.writeFile(path.join(staged, '7.json'), 'staged preference');
  await fs.writeFile(path.join(ordinary, 'app.txt'), 'app data');
  await fs.writeFile(path.join(state, 'desktop', '8.json'), 'current preference');
  const inventory = await inventoryBackup([{ name: 'data/state', source: state }], signal());
  expect(inventory.files.map((file) => file.name).sort()).toEqual([`data/state/apps/${stage}/app.txt`, 'data/state/desktop/8.json']);
  expect(await fs.readFile(path.join(journal, 'active.json'), 'utf8')).toBe('host-only intent');
  expect(await fs.readFile(path.join(staged, '7.json'), 'utf8')).toBe('staged preference');
});

it('rejects a file replaced between inventory and copying', async () => {
  const source = path.join(root, 'file');
  await fs.writeFile(source, 'first');
  const inventory = await inventoryBackup([{ name: 'data/config', source }], signal());
  await fs.rename(source, `${source}.old`);
  await fs.writeFile(source, 'other');
  const target = path.join(root, 'content');
  await fs.mkdir(target);
  await expect(copyBackupFiles(inventory, target, signal(), () => undefined)).rejects.toThrow('source changed');
});

it('does not silently omit a required missing root or accept duplicate archive names', async () => {
  await expect(inventoryBackup([{ name: 'data/state', source: path.join(root, 'missing'), required: true }], signal())).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await fs.writeFile(path.join(root, 'file'), 'data');
  await expect(
    inventoryBackup(
      [
        { name: 'data/file', source: path.join(root, 'file') },
        { name: 'data/file', source: path.join(root, 'file') },
      ],
      signal(),
    ),
  ).rejects.toThrow('unsupported path');
});

it('omits only exact top-level retained generations while preserving live and nested reserved-looking data', async () => {
  const source = path.join(root, 'source');
  const generation = randomUUID();
  const incoming = path.join(source, `.orbis-restore-${generation}.incoming`);
  const previous = path.join(source, `.orbis-restore-${generation}.previous`);
  const nested = path.join(source, 'apps', `.orbis-restore-${generation}.incoming`);
  await fs.mkdir(incoming, { recursive: true, mode: 0o700 });
  await fs.mkdir(previous, { mode: 0o700 });
  await fs.mkdir(nested, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(source, 'live.txt'), 'current restored data', { mode: 0o600 });
  await fs.writeFile(path.join(previous, 'preserved-original.txt'), 'retained original', { mode: 0o600 });
  await fs.writeFile(path.join(nested, 'app-owned.txt'), 'nested app data', { mode: 0o600 });
  const before = await fs.readFile(path.join(previous, 'preserved-original.txt'));

  const inventory = await inventoryBackup([{ name: 'state', source }], signal(), [incoming, previous]);

  expect(inventory.files.map((file) => file.name).sort()).toEqual([
    `state/apps/.orbis-restore-${generation}.incoming/app-owned.txt`,
    'state/live.txt',
  ]);
  expect(inventory.files.some((file) => file.source.startsWith(`${incoming}${path.sep}`))).toBe(false);
  expect(await fs.readFile(path.join(previous, 'preserved-original.txt'))).toEqual(before);
  expect(await fs.readFile(path.join(nested, 'app-owned.txt'), 'utf8')).toBe('nested app data');
  expect(await fs.readdir(source)).toContain(path.basename(incoming));
  expect(await fs.readdir(source)).toContain(path.basename(previous));
});

it.each(['arbitrary', 'missing', 'duplicate', 'symlink', 'public'] as const)('rejects an unsafe restore exclusion: %s', async (kind) => {
  const source = path.join(root, 'source');
  await fs.mkdir(source, { mode: 0o700 });
  await fs.writeFile(path.join(source, 'live.txt'), 'fixture data', { mode: 0o600 });
  const reserved = path.join(source, `.orbis-restore-${randomUUID()}.previous`);
  let exclusions = [reserved];
  if (kind === 'arbitrary') {
    const arbitrary = path.join(source, 'ordinary');
    await fs.mkdir(arbitrary, { mode: 0o700 });
    exclusions = [arbitrary];
  } else if (kind === 'duplicate') {
    await fs.mkdir(reserved, { mode: 0o700 });
    exclusions = [reserved, reserved];
  } else if (kind === 'symlink') {
    const target = path.join(root, 'target');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, reserved);
  } else if (kind === 'public') {
    await fs.mkdir(reserved, { mode: 0o755 });
    await fs.chmod(reserved, 0o755);
  }

  await expect(inventoryBackup([{ name: 'state', source }], signal(), exclusions)).rejects.toThrow();
});

it('refuses an unrecognized top-level restore generation without an exclusion', async () => {
  const source = path.join(root, 'source');
  await fs.mkdir(source, { mode: 0o700 });
  await fs.mkdir(path.join(source, `.orbis-restore-${randomUUID()}.previous`), { mode: 0o700 });

  await expect(inventoryBackup([{ name: 'state', source }], signal())).rejects.toThrow('need review');
});

it('rejects symlinked or non-private export storage', async () => {
  const publicDir = path.join(root, 'public');
  await fs.mkdir(publicDir, { mode: 0o755 });
  await expect(privateBackupDirectory(publicDir)).rejects.toThrow('private storage');
  const linked = path.join(root, 'linked');
  await fs.symlink(root, linked);
  await expect(privateBackupDirectory(linked)).rejects.toThrow();
});

it('does not publish a completed encrypted file when cancelled before packaging', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(
    packageBackup({ directory: root, content: root, passphrase: 'disposable-export-passphrase', signal: abort.signal, progress: () => undefined }),
  ).rejects.toThrow();
  await expect(fs.stat(path.join(root, 'backup.orbis'))).rejects.toMatchObject({ code: 'ENOENT' });
});
