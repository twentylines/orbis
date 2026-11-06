import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  materializeBackupSource,
  restoreTreesForManifest,
  restoreTreeNames,
  type RestoreTreeName,
  type RestoreMaterializeProgress,
  type RestoreSettingsOverride,
} from './backup-restore-materialize';
import { makeReviewedBackupFixture, fileMetadata, directoryMetadata, type ReviewedBackupFixture } from './backup-restore-source.fixture';
import { pinBackupSource } from './backup-restore-source';
import { verifyRestoreFiles } from './backup-restore-files';
import { BackupDirectorySwap } from './backup-directory-swap';
import { fullBackupLimits } from './backup-limits';
import { rebaseBackupConfiguration } from './backup-restore-configuration';
import { captureRestoreHostIdentity } from './backup-restore-host-identity';
import { encodeAppImagePins } from '../docker/app-image-pins';

let temporary: string;
const signal = () => new AbortController().signal;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-materialize-')));
  await fs.chmod(temporary, 0o700);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});
async function reseal(source: ReviewedBackupFixture) {
  const bytes = Buffer.from(JSON.stringify(source.manifest));
  await fs.writeFile(path.join(source.content, 'manifest.json'), bytes);
  source.seal.manifest = { bytes: bytes.length, sha256: hash(bytes) };
}
async function fixture() {
  const source = await makeReviewedBackupFixture(temporary);
  for (const name of [
    'app-data',
    'app-data/empty',
    'app-data/sub',
    'app-data/sub/.orbis-restore-app-settings',
    'data/user-config',
    'data/repos',
    'data/media',
    'data/traefik',
  ]) {
    await fs.mkdir(path.join(source.content, name), { mode: 0o700 });
    source.manifest.directories.push({ ...(await directoryMetadata(source.content, name)), mode: 0o750 });
  }
  for (const [name, bytes] of [
    ['data/.env', Buffer.from('ROOT_FOLDER_HOST=/previous-host\nSERVER_PORT=80\n')],
    ['data/state/payload', Buffer.alloc(320 * 1024, 17)],
    ['app-data/document', Buffer.alloc(320 * 1024, 29)],
    ['app-data/empty/zero', Buffer.alloc(0)],
    ['app-data/名.txt', Buffer.from('unicode file data')],
  ] as const) {
    await fs.writeFile(path.join(source.content, name), bytes, { mode: 0o600 });
    await fs.utimes(path.join(source.content, name), 1_700_000_000.123, 1_700_000_000.123);
    source.manifest.files.push({ ...(await fileMetadata(source.content, name)), mode: 0o640 });
  }
  await reseal(source);
  const roots = {} as Record<RestoreTreeName, string>;
  for (const name of restoreTreeNames) {
    roots[name] = path.join(temporary, `incoming-${name}`);
    await fs.mkdir(roots[name], { mode: 0o700 });
  }
  return { source, roots, ledger: path.join(temporary, 'files.ndjson') };
}
async function run(
  test: Awaited<ReturnType<typeof fixture>>,
  progress: (value: RestoreMaterializeProgress) => void = () => undefined,
  abort = signal(),
  settingsOverride?: RestoreSettingsOverride,
) {
  return materializeBackupSource({
    directory: test.source.directory,
    expected: test.source.seal,
    roots: test.roots,
    ledger: test.ledger,
    signal: abort,
    progress,
    settingsOverride,
  });
}

it.skipIf(process.platform !== 'linux')('Linux reconstructs a manifest-only link after files and rejects a later link replacement', async () => {
  const test = await fixture();
  if (test.source.manifest.version === 3) throw new Error('Expected a legacy backup fixture.');
  test.source.manifest = {
    ...test.source.manifest,
    version: 2,
    mediaPolicy: 'included',
    symlinks: [
      { name: 'app-data/sub/tool', target: '../document', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mtime: 1_700_000_000_000 },
    ],
    excludedRuntimeSockets: ['app-data/service.sock'],
  };
  await reseal(test.source);
  const result = await run(test);
  const link = path.join(test.roots['app-data'], 'sub/tool');
  expect(await fs.readlink(link)).toBe('../document');
  expect(await fs.readFile(link)).toEqual(await fs.readFile(path.join(test.roots['app-data'], 'document')));
  await expect(fs.lstat(path.join(test.roots['app-data'], 'service.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
  await verifyRestoreFiles({ roots: test.roots, ledger: test.ledger, expected: result.files, signal: signal() });
  await fs.unlink(link);
  await fs.symlink('../empty/zero', link);
  await expect(verifyRestoreFiles({ roots: test.roots, ledger: test.ledger, expected: result.files, signal: signal() })).rejects.toThrow();
});

it.skipIf(process.platform !== 'linux')('Linux rejects a replaced parent immediately after creating a staged link', async () => {
  const test = await fixture();
  if (test.source.manifest.version === 3) throw new Error('Expected a legacy backup fixture.');
  test.source.manifest = {
    ...test.source.manifest,
    version: 2,
    mediaPolicy: 'included',
    symlinks: [
      { name: 'app-data/sub/tool', target: '../document', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mtime: 1_700_000_000_000 },
    ],
  };
  await reseal(test.source);
  const original = fs.symlink.bind(fs);
  const parent = path.join(test.roots['app-data'], 'sub');
  vi.spyOn(fs, 'symlink').mockImplementation(async (target, file, type) => {
    await original(target, file, type);
    await fs.rename(parent, `${parent}-replaced`);
    await fs.mkdir(parent, { mode: 0o700 });
  });
  await expect(run(test)).rejects.toThrow();
});

it.skipIf(process.platform !== 'linux').each(['symlink', 'lchown', 'lutimes'] as const)(
  'Linux keeps outside staging untouched when the parent is replaced before %s',
  async (operation) => {
    const test = await fixture();
    if (test.source.manifest.version === 3) throw new Error('Expected a legacy backup fixture.');
    test.source.manifest = {
      ...test.source.manifest,
      version: 2,
      mediaPolicy: 'included',
      symlinks: [
        { name: 'app-data/sub/tool', target: '../document', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mtime: 1_700_000_000_000 },
      ],
    };
    await reseal(test.source);
    const outside = path.join(temporary, 'outside-staging');
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(path.join(outside, 'keep'), 'outside sentinel');
    const child = path.join(outside, 'tool');
    const symlink = fs.symlink.bind(fs);
    if (operation !== 'symlink') {
      await symlink('keep', child);
      await fs.lutimes(child, 10, 10);
    }
    const before = operation === 'symlink' ? undefined : await fs.lstat(child);
    const parent = path.join(test.roots['app-data'], 'sub');
    const replaceParent = async () => {
      await fs.rename(parent, `${parent}-held`);
      await symlink(outside, parent, 'dir');
    };
    if (operation === 'symlink') {
      vi.spyOn(fs, 'symlink').mockImplementation(async (target, file, type) => {
        await replaceParent();
        await symlink(target, file, type);
      });
    } else if (operation === 'lchown') {
      const lstat = fs.lstat.bind(fs);
      let forced = false;
      vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (!forced && String(args[0]).endsWith('/tool') && String(args[0]) !== child && stat.isSymbolicLink()) {
          forced = true;
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: Number(stat.uid) + 1 });
        }
        return stat;
      });
      const lchown = fs.lchown.bind(fs);
      vi.spyOn(fs, 'lchown').mockImplementation(async (...args) => {
        await replaceParent();
        await lchown(...args);
      });
    } else {
      const lutimes = fs.lutimes.bind(fs);
      vi.spyOn(fs, 'lutimes').mockImplementation(async (...args) => {
        await replaceParent();
        await lutimes(...args);
      });
    }
    await expect(run(test)).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('outside sentinel');
    if (before) {
      const after = await fs.lstat(child);
      expect({ uid: after.uid, gid: after.gid, mtime: after.mtimeMs, ctime: after.ctimeMs }).toEqual({
        uid: before.uid,
        gid: before.gid,
        mtime: before.mtimeMs,
        ctime: before.ctimeMs,
      });
      expect(await fs.readlink(child)).toBe('keep');
    } else await expect(fs.lstat(child)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it.skipIf(process.platform === 'linux')('fails closed for link reconstruction without a Linux descriptor root', async () => {
  const test = await fixture();
  if (test.source.manifest.version === 3) throw new Error('Expected a legacy backup fixture.');
  test.source.manifest = {
    ...test.source.manifest,
    version: 2,
    mediaPolicy: 'included',
    symlinks: [
      { name: 'app-data/sub/tool', target: '../document', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mtime: 1_700_000_000_000 },
    ],
  };
  await reseal(test.source);
  const create = vi.spyOn(fs, 'symlink');
  await expect(run(test)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  await expect(fs.lstat(path.join(test.roots['app-data'], 'sub/tool'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves existing destination media without materializing or accounting an empty replacement', async () => {
  const test = await fixture();
  expect(restoreTreesForManifest(test.source.manifest)).toContain('media');
  await fs.rm(path.join(test.source.content, 'data/media'), { recursive: true });
  if (test.source.manifest.version === 3) throw new Error('Expected a legacy backup fixture.');
  test.source.manifest = {
    ...test.source.manifest,
    version: 2,
    mediaPolicy: 'preserve-destination',
    directories: test.source.manifest.directories.filter((item) => item.name !== 'data/media'),
  };
  await reseal(test.source);
  const library = path.join(test.roots.media, 'destination-movie.mkv');
  await fs.writeFile(library, 'valuable destination media');
  const before = await fs.stat(library);
  const result = await run(test);
  expect(await fs.readFile(library, 'utf8')).toBe('valuable destination media');
  expect((await fs.stat(library)).ino).toBe(before.ino);
  expect(await fs.readdir(test.roots.media)).toEqual(['destination-movie.mkv']);
  expect(await fs.readFile(test.ledger, 'utf8')).not.toContain('"root":"media"');
  const roots = Object.fromEntries(restoreTreesForManifest(test.source.manifest).map((name) => [name, test.roots[name]]));
  await verifyRestoreFiles({ roots, ledger: test.ledger, expected: result.files, signal: signal() });
});

it('verifies captured proxy bytes without writing into the live proxy tree when preservation is authorized', async () => {
  const test = await fixture();
  await fs.mkdir(path.join(test.source.content, 'data/traefik'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(test.source.content, 'data/traefik/captured.yml'), 'historical', { mode: 0o600 });
  test.source.manifest.files.push(await fileMetadata(test.source.content, 'data/traefik/captured.yml'));
  await reseal(test.source);
  await fs.writeFile(path.join(test.roots.traefik, 'live.yml'), 'live', { mode: 0o600 });
  await materializeBackupSource({
    directory: test.source.directory,
    expected: test.source.seal,
    roots: test.roots,
    ledger: test.ledger,
    signal: signal(),
    progress: () => undefined,
    preserveLiveProxy: true,
  });
  expect(await fs.readdir(test.roots.traefik)).toEqual(['live.yml']);
  expect(await fs.readFile(path.join(test.roots.traefik, 'live.yml'), 'utf8')).toBe('live');
  expect(await fs.readFile(path.join(test.roots.state, 'seed'), 'utf8')).toBeTruthy();
});
it('rejects tampered captured proxy bytes while leaving the live proxy tree untouched', async () => {
  const test = await fixture();
  await fs.mkdir(path.join(test.source.content, 'data/traefik'), { recursive: true, mode: 0o700 });
  const captured = path.join(test.source.content, 'data/traefik/captured.yml');
  await fs.writeFile(captured, 'historical', { mode: 0o600 });
  test.source.manifest.files.push(await fileMetadata(test.source.content, 'data/traefik/captured.yml'));
  await reseal(test.source);
  await fs.writeFile(captured, 'tampered');
  await fs.writeFile(path.join(test.roots.traefik, 'live.yml'), 'live', { mode: 0o600 });
  await expect(
    materializeBackupSource({
      directory: test.source.directory,
      expected: test.source.seal,
      roots: test.roots,
      ledger: test.ledger,
      signal: signal(),
      progress: () => undefined,
      preserveLiveProxy: true,
    }),
  ).rejects.toThrow();
  expect(await fs.readdir(test.roots.traefik)).toEqual(['live.yml']);
  expect(await fs.readFile(path.join(test.roots.traefik, 'live.yml'), 'utf8')).toBe('live');
});
it('records generated retained image pins in the verified file ledger', async () => {
  const test = await fixture();
  const source = { appUrn: 'demo:store', project: 'demo_store', sourceSha256: 'a'.repeat(64) };
  const { data } = encodeAppImagePins(source, {
    version: 1,
    pointId: randomUUID(),
    sourceSha256: source.sourceSha256,
    services: { web: `sha256:${'b'.repeat(64)}` },
  });
  const name = `${createHash('sha256').update(source.appUrn).digest('hex')}.json`;
  const result = await materializeBackupSource({
    directory: test.source.directory,
    expected: test.source.seal,
    roots: test.roots,
    ledger: test.ledger,
    signal: signal(),
    progress: () => undefined,
    retainedPins: [{ name, data }],
  });
  const pin = path.join(test.roots.state, 'time-machine', 'image-pins', name);
  expect(await fs.readFile(pin)).toEqual(data);
  await verifyRestoreFiles({ ledger: test.ledger, expected: result.files, roots: test.roots, signal: signal() });
  await fs.appendFile(pin, ' ');
  await expect(verifyRestoreFiles({ ledger: test.ledger, expected: result.files, roots: test.roots, signal: signal() })).rejects.toThrow();
});

it('replaces captured pin files without leaving stale entries in the restored ledger', async () => {
  const test = await fixture();
  const parent = 'data/state/time-machine';
  const directory = `${parent}/image-pins`;
  await fs.mkdir(path.join(test.source.content, directory), { recursive: true, mode: 0o700 });
  for (const name of [parent, directory]) test.source.manifest.directories.push(await directoryMetadata(test.source.content, name));
  const old = `${directory}/${'c'.repeat(64)}.json`;
  await fs.writeFile(path.join(test.source.content, old), 'previous-pin', { mode: 0o600 });
  test.source.manifest.files.push(await fileMetadata(test.source.content, old));
  await reseal(test.source);
  const source = { appUrn: 'demo:store', project: 'demo_store', sourceSha256: 'a'.repeat(64) };
  const { data } = encodeAppImagePins(source, {
    version: 1,
    pointId: randomUUID(),
    sourceSha256: source.sourceSha256,
    services: { web: `sha256:${'b'.repeat(64)}` },
  });
  const name = `${createHash('sha256').update(source.appUrn).digest('hex')}.json`;
  const result = await materializeBackupSource({
    directory: test.source.directory,
    expected: test.source.seal,
    roots: test.roots,
    ledger: test.ledger,
    signal: signal(),
    progress: () => undefined,
    retainedPins: [{ name, data }],
  });
  const pins = path.join(test.roots.state, 'time-machine', 'image-pins');
  expect(await fs.readdir(pins)).toEqual([name]);
  await verifyRestoreFiles({ ledger: test.ledger, expected: result.files, roots: test.roots, signal: signal() });
});

function rebasedSettings() {
  const target = {
    POSTGRES_HOST: 'target-db',
    POSTGRES_DBNAME: 'target-database',
    POSTGRES_USERNAME: 'target-user',
    POSTGRES_PASSWORD: 'synthetic-database-fixture',
    RABBITMQ_HOST: 'target-queue',
    RABBITMQ_USERNAME: 'target-queue-user',
    RABBITMQ_PASSWORD: 'synthetic-queue-fixture',
    ROOT_FOLDER_HOST: '/srv/target',
    RUNTIPI_APP_DATA_PATH: '/srv/target-data',
    ARCHITECTURE: 'arm64',
    TIPI_VERSION: '4.10.1',
    APPS_REPO_URL: 'https://example.invalid/target.git',
    TZ: 'Asia/Singapore',
    INTERNAL_IP: '192.0.2.10',
    DOMAIN: 'target.example.invalid',
    LOCAL_DOMAIN: 'target.lan',
    RUNTIPI_FORWARD_AUTH_URL: 'http://target:3000/api/auth/traefik',
    NGINX_PORT: '8080',
    NGINX_PORT_SSL: '8443',
    POSTGRES_PORT: '5544',
  };
  return Buffer.from(
    rebaseBackupConfiguration({
      targetEnvironment: Object.entries(target)
        .map(([key, value]) => `${key}='${value}'`)
        .join('\n'),
      databaseName: `orbis_restore_${'b'.repeat(32)}`,
      recovery: { jwtSecret: 'synthetic-account-fixture', userSettings: { timeZone: 'UTC', themeColor: 'purple' } },
    }).settings,
  );
}
async function settingsFixture() {
  const test = await fixture();
  const name = 'data/state/settings.json';
  const file = path.join(test.source.content, name);
  const original = Buffer.from('{"appDataPath":"/old-host","port":80}\n');
  await fs.writeFile(file, original, { mode: 0o600 });
  await fs.utimes(file, 1_700_000_000.123, 1_700_000_000.123);
  const entry = { ...(await fileMetadata(test.source.content, name)), mode: 0o640 };
  test.source.manifest.files.push(entry);
  await reseal(test.source);
  const override: RestoreSettingsOverride = { original: { bytes: entry.bytes, sha256: entry.sha256 }, replacement: rebasedSettings() };
  return { ...test, override, entry, file, original };
}

it('materializes host-rebased settings only after authenticating the original and includes the replacement in the file ledger', async () => {
  const test = await settingsFixture();
  const observed: RestoreMaterializeProgress[] = [];
  const result = await run(test, (p) => observed.push(p), signal(), test.override);
  await verifyRestoreFiles({ ledger: test.ledger, expected: result.files, roots: test.roots, signal: signal() });
  const destination = path.join(test.roots.state, 'settings.json');
  const installed = await fs.readFile(destination);
  expect(installed.equals(test.override.replacement)).toBe(true);
  expect(JSON.parse(installed.toString())).toMatchObject({ appDataPath: '/srv/target-data', port: 8080, timeZone: 'UTC', themeColor: 'purple' });
  expect((await fs.readFile(test.file)).equals(test.original)).toBe(true);
  expect(await fs.readFile(path.join(test.roots.state, 'seed'), 'utf8')).toBe('fixture-state');
  expect(await fs.readFile(path.join(test.roots['app-data'], 'document'))).toEqual(Buffer.alloc(320 * 1024, 29));
  const stat = await fs.stat(destination);
  expect({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 }).toEqual({
    uid: test.entry.uid,
    gid: test.entry.gid,
    mode: test.entry.mode,
  });
  expect(Math.abs(stat.mtimeMs - test.entry.mtime)).toBeLessThanOrEqual(1);
  const ledger = (await fs.readFile(test.ledger, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(ledger.find((entry) => entry.root === 'state' && entry.name === 'settings.json')).toEqual({
    root: 'state',
    name: 'settings.json',
    kind: 'file',
    uid: test.entry.uid,
    gid: test.entry.gid,
    mode: test.entry.mode,
    mtime: test.entry.mtime,
    bytes: installed.length,
    sha256: hash(installed),
  });
  expect(result.files.files).toBe(test.source.manifest.files.length - 1);
  expect(observed.at(-1)?.completedBytes).toBe(test.source.manifest.files.reduce((total, entry) => total + entry.bytes, 0));
  await expect(fs.lstat(path.join(test.roots.state, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('snapshots replacement bytes and their original identity before asynchronous source validation', async () => {
  const test = await settingsFixture();
  const expected = Buffer.from(test.override.replacement);
  const pending = run(test, undefined, signal(), test.override);
  test.override.replacement.fill(0);
  test.override.original.bytes++;
  test.override.original.sha256 = '0'.repeat(64);
  const result = await pending;
  expect((await fs.readFile(path.join(test.roots.state, 'settings.json'))).equals(expected)).toBe(true);
  await verifyRestoreFiles({ ledger: test.ledger, expected: result.files, roots: test.roots, signal: signal() });
});

it('does not create replacement settings when the original file has equal-length tampering', async () => {
  const test = await settingsFixture();
  const tampered = Buffer.from(test.original.toString().replace('old-host', 'bad-host'));
  expect(tampered.length).toBe(test.original.length);
  await fs.writeFile(test.file, tampered);
  await expect(run(test, undefined, signal(), test.override)).rejects.toThrow('could not be prepared');
  await expect(fs.lstat(path.join(test.roots.state, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.readFile(test.file)).equals(tampered)).toBe(true);
});

it('does not create replacement settings when cancelled while authenticating the original settings', async () => {
  const test = await settingsFixture();
  const original = Buffer.from(JSON.stringify({ themeBase: 'x'.repeat(192 * 1024) }));
  await fs.writeFile(test.file, original);
  const entry = { ...(await fileMetadata(test.source.content, test.entry.name)), mode: test.entry.mode };
  test.source.manifest.files = test.source.manifest.files.map((item) => (item.name === entry.name ? entry : item));
  await reseal(test.source);
  test.override.original = { bytes: entry.bytes, sha256: entry.sha256 };
  const precedingBytes = test.source.manifest.files.reduce((total, item) => total + item.bytes, 0) - entry.bytes;
  const abort = new AbortController();
  await expect(
    run(
      test,
      (p) => {
        if (p.completedBytes > precedingBytes) abort.abort();
      },
      abort.signal,
      test.override,
    ),
  ).rejects.toThrow();
  expect(abort.signal.aborted).toBe(true);
  await expect(fs.lstat(path.join(test.roots.state, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.readFile(test.file)).equals(original)).toBe(true);
});

it.each(['missing', 'bytes', 'sha256'] as const)('requires the sealed original settings identity: %s', async (kind) => {
  const test = await settingsFixture();
  if (kind === 'missing') {
    await fs.unlink(test.file);
    test.source.manifest.files = test.source.manifest.files.filter((entry) => entry.name !== test.entry.name);
    await reseal(test.source);
  }
  if (kind === 'bytes') test.override.original.bytes++;
  if (kind === 'sha256') test.override.original.sha256 = '0'.repeat(64);
  await expect(run(test, undefined, signal(), test.override)).rejects.toThrow('could not be prepared');
  await expect(fs.lstat(test.ledger)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const root of Object.values(test.roots)) expect(await fs.readdir(root)).toEqual([]);
});

it.each([
  ['empty', Buffer.alloc(0)],
  ['oversized', Buffer.alloc(1024 * 1024 + 1, 32)],
  ['malformed UTF-8', Buffer.from([0x7b, 0x22, 0x74, 0x68, 0x65, 0x6d, 0x65, 0x42, 0x61, 0x73, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])],
  ['malformed JSON', Buffer.from('{')],
  ['array', Buffer.from('[]')],
  ['null', Buffer.from('null')],
  ['unknown key', Buffer.from('{"unrecognizedSetting":true}')],
  ['invalid type', Buffer.from('{"port":false}')],
  ['invalid port', Buffer.from('{"port":65536}')],
] as const)('rejects %s replacement settings before creating anything', async (_kind, replacement) => {
  const test = await settingsFixture();
  test.override.replacement = replacement;
  await expect(run(test, undefined, signal(), test.override)).rejects.toThrow('could not be prepared');
  await expect(fs.lstat(test.ledger)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const root of Object.values(test.roots)) expect(await fs.readdir(root)).toEqual([]);
  expect((await fs.readFile(test.file)).equals(test.original)).toBe(true);
});

it('reserves capacity for larger replacement settings before writing any staging files', async () => {
  const test = await settingsFixture();
  test.override.replacement = Buffer.from(JSON.stringify({ themeBase: 'x'.repeat(900 * 1024) }));
  const stat = await fs.statfs(temporary, { bigint: true });
  vi.spyOn(fs, 'statfs').mockResolvedValue({ ...stat, bsize: 1n, bavail: BigInt(fullBackupLimits.reserveBytes + 64 * 1024 * 1024 + 800 * 1024) });
  await expect(run(test, undefined, signal(), test.override)).rejects.toThrow('not enough free storage');
  await expect(fs.lstat(test.ledger)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const root of Object.values(test.roots)) expect(await fs.readdir(root)).toEqual([]);
  const result = await run(test);
  expect((await fs.readFile(path.join(test.roots.state, 'settings.json'))).equals(test.original)).toBe(true);
  await verifyRestoreFiles({ ledger: test.ledger, expected: result.files, roots: test.roots, signal: signal() });
});
it('streams all trees and metadata into a verifiable ledger without installing the old host environment', async () => {
  const test = await fixture();
  const observed: RestoreMaterializeProgress[] = [];
  const result = await run(test, (p) => observed.push(p));
  await verifyRestoreFiles({ ledger: test.ledger, expected: result.files, roots: test.roots, signal: signal() });
  expect(await fs.readFile(path.join(test.roots['app-data'], 'document'))).toEqual(Buffer.alloc(320 * 1024, 29));
  expect(await fs.readFile(path.join(test.roots['app-data'], 'empty/zero'))).toHaveLength(0);
  expect(await fs.readFile(path.join(test.roots['app-data'], '名.txt'), 'utf8')).toBe('unicode file data');
  expect(await fs.readdir(test.roots.repos)).toEqual([]);
  expect((await fs.stat(path.join(test.roots['app-data'], 'document'))).mode & 0o777).toBe(0o640);
  expect((await fs.stat(path.join(test.roots['app-data'], 'empty'))).mode & 0o777).toBe(0o750);
  expect((await fs.stat(test.roots['app-data'])).mode & 0o777).toBe(0o700);
  expect(result.files.files).toBe(test.source.manifest.files.length - 1);
  expect(result.files.directories).toBe(test.source.manifest.directories.length - restoreTreeNames.length);
  expect(result.environment.sha256).toBe(hash(await fs.readFile(result.environment.file)));
  expect(result.environment.file).toBe(path.join(test.source.content, 'data/.env'));
  for (const root of Object.values(test.roots)) await expect(fs.lstat(path.join(root, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(observed[0]?.completedBytes).toBe(0);
  expect(observed[0]?.stage).toBe('copying');
  expect(observed.some((p) => p.stage === 'metadata' && p.directories < p.totalDirectories)).toBe(true);
  expect(observed.at(-1)?.stage).toBe('prepared');
  expect(observed.at(-1)?.directories).toBe(observed.at(-1)?.totalDirectories);
  expect(observed.at(-1)?.completedBytes).toBe(test.source.manifest.files.reduce((n, e) => n + e.bytes, 0));
  expect(observed.at(-1)?.files).toBe(test.source.manifest.files.length);
  expect(observed.every((p, i) => p.completedBytes <= p.totalBytes && (!i || p.completedBytes >= (observed[i - 1]?.completedBytes ?? 0)))).toBe(true);
  expect(result.resumeApps).toEqual([{ id: 9, appUrn: 'fixture-app:catalogue' }]);
});
it('pins the reviewed source, stages and verifies real swaps, then rolls back to preserved original trees', async () => {
  const test = await fixture();
  const parent = path.join(temporary, 'pin');
  await fs.mkdir(parent, { mode: 0o700 });
  test.source.directory = (
    await pinBackupSource({
      directory: test.source.directory,
      destination: path.join(parent, 'source'),
      expected: test.source.seal,
      signal: signal(),
    })
  ).directory;
  const swaps: BackupDirectorySwap[] = [];
  const active = {} as Record<RestoreTreeName, string>;
  const journals = path.join(temporary, 'journals');
  await fs.mkdir(journals, { mode: 0o700 });
  const id = randomUUID();
  for (const name of restoreTreeNames) {
    const root = path.join(temporary, `active-${name}`);
    await fs.mkdir(root, { mode: 0o700 });
    await fs.writeFile(path.join(root, 'original'), `original-${name}`);
    const swap = await BackupDirectorySwap.create({ id, root, journal: path.join(journals, name) });
    swaps.push(swap);
    active[name] = root;
    test.roots[name] = swap.incomingDirectory;
  }
  const result = await run(test);
  for (const name of restoreTreeNames) expect(await fs.readFile(path.join(active[name], 'original'), 'utf8')).toBe(`original-${name}`);
  for (const swap of swaps) await swap.seal(signal());
  for (const swap of swaps) await swap.promote(signal());
  await verifyRestoreFiles({ ledger: test.ledger, expected: result.files, roots: active, signal: signal() });
  expect(await fs.readFile(path.join(active.state, 'seed'), 'utf8')).toBe('fixture-state');
  for (const swap of [...swaps].reverse()) await swap.rollback();
  for (const name of restoreTreeNames) expect(await fs.readFile(path.join(active[name], 'original'), 'utf8')).toBe(`original-${name}`);
});
it('rejects equal-length ordinary-data changes despite a metadata-only source match', async () => {
  const test = await fixture();
  await fs.writeFile(path.join(test.source.content, 'app-data/document'), Buffer.alloc(320 * 1024, 30));
  await expect(run(test)).rejects.toThrow('could not be prepared');
  expect(await fs.readFile(path.join(test.source.content, 'data/state/seed'), 'utf8')).toBe('fixture-state');
});
it.each(['symbolic', 'hard'] as const)('rejects a %s source link before writing', async (kind) => {
  const test = await fixture();
  const file = path.join(test.source.content, 'app-data/document');
  if (kind === 'symbolic') {
    await fs.rename(file, path.join(temporary, 'saved'));
    await fs.symlink(path.join(temporary, 'saved'), file);
  } else await fs.link(file, path.join(temporary, 'linked'));
  await expect(run(test)).rejects.toThrow();
  await expect(fs.lstat(test.ledger)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('keeps preparation inert when cancelled during a streamed copy', async () => {
  const test = await fixture();
  const abort = new AbortController();
  await expect(
    run(
      test,
      (p) => {
        if (p.completedBytes >= 65536) abort.abort();
      },
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(await fs.readFile(path.join(test.source.content, 'data/state/seed'), 'utf8')).toBe('fixture-state');
  expect(abort.signal.aborted).toBe(true);
});
it.each(['duplicate', 'nested', 'symbolic', 'nonempty', 'public', 'ledger-inside', 'ledger-exists'] as const)(
  'rejects %s destinations without overwrite',
  async (kind) => {
    const test = await fixture();
    if (kind === 'duplicate') test.roots.apps = test.roots.state;
    if (kind === 'nested') {
      test.roots.apps = path.join(test.roots.state, 'nested');
      await fs.mkdir(test.roots.apps, { mode: 0o700 });
    }
    if (kind === 'symbolic') {
      const target = test.roots.apps;
      test.roots.apps = path.join(temporary, 'alias');
      await fs.symlink(target, test.roots.apps);
    }
    if (kind === 'nonempty') await fs.writeFile(path.join(test.roots.state, 'keep'), 'untouched');
    if (kind === 'public') await fs.chmod(test.roots.state, 0o755);
    if (kind === 'ledger-inside') test.ledger = path.join(test.roots.state, 'ledger');
    if (kind === 'ledger-exists') await fs.writeFile(test.ledger, 'untouched', { mode: 0o600 });
    await expect(run(test)).rejects.toThrow();
    if (kind === 'nonempty') expect(await fs.readFile(path.join(test.roots.state, 'keep'), 'utf8')).toBe('untouched');
    if (kind === 'ledger-exists') expect(await fs.readFile(test.ledger, 'utf8')).toBe('untouched');
  },
);
it.each(['data/.env', 'data/state/seed'])('requires %s before creating files', async (name) => {
  const test = await fixture();
  await fs.unlink(path.join(test.source.content, name));
  test.source.manifest.files = test.source.manifest.files.filter((e) => e.name !== name);
  await reseal(test.source);
  await expect(run(test)).rejects.toThrow();
  await expect(fs.lstat(test.ledger)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('aggregates space across roots on the same filesystem before copying', async () => {
  const test = await fixture();
  const stat = await fs.statfs(temporary, { bigint: true });
  vi.spyOn(fs, 'statfs').mockResolvedValue({ ...stat, bsize: 1n, bavail: BigInt(fullBackupLimits.reserveBytes + 64 * 1024 * 1024 + 500 * 1024) });
  await expect(run(test)).rejects.toThrow('not enough free storage');
  await expect(fs.lstat(test.ledger)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const root of Object.values(test.roots)) expect(await fs.readdir(root)).toEqual([]);
});

async function hostIdentityFixture(empty: boolean) {
  const test = await fixture();
  for (const [name, contents] of [
    ['data/traefik/source-tls', 'source certificate identity'],
    ['data/state/cluster.json', 'source membership'],
    ['data/user-config/tipi-compose.yml', 'source controller override'],
  ] as const) {
    await fs.writeFile(path.join(test.source.content, name), contents, { mode: 0o600 });
    test.source.manifest.files.push(await fileMetadata(test.source.content, name));
  }
  for (const name of ['data/state/secure-access', 'data/state/cluster-sync']) {
    await fs.mkdir(path.join(test.source.content, name), { mode: 0o700 });
    test.source.manifest.directories.push(await directoryMetadata(test.source.content, name));
    const file = `${name}/settings.json`;
    await fs.writeFile(path.join(test.source.content, file), 'source private host configuration', { mode: 0o600 });
    test.source.manifest.files.push(await fileMetadata(test.source.content, file));
  }
  await reseal(test.source);
  const live = {} as Record<RestoreTreeName, string>;
  for (const name of restoreTreeNames) {
    live[name] = path.join(temporary, `live-${name}`);
    await fs.mkdir(live[name], { mode: 0o700 });
  }
  if (!empty) {
    await fs.writeFile(path.join(live.traefik, 'target-tls'), 'destination certificate identity', { mode: 0o640 });
    await fs.mkdir(path.join(live.traefik, 'empty-directory'), { mode: 0o750 });
    await fs.writeFile(path.join(live.state, 'cluster.json'), '{"id":"destination membership"}', { mode: 0o600 });
    await fs.writeFile(path.join(live['user-config'], 'tipi-compose.yml'), 'destination controller override', { mode: 0o600 });
    await fs.mkdir(path.join(live.state, 'secure-access'), { mode: 0o700 });
    await fs.writeFile(path.join(live.state, 'secure-access', 'authority.json'), 'destination authority fixture', { mode: 0o600 });
  }
  const directory = path.join(temporary, 'host-snapshot');
  const id = randomUUID();
  const seal = await captureRestoreHostIdentity({ directory, id, roots: live, signal: signal(), transformClusterSync: (bytes) => bytes });
  return { test, hostIdentity: { directory, id, seal } };
}

it.each([false, true])('applies destination host identity including preserved absence (empty=%s) in the real effective ledger', async (empty) => {
  const { test, hostIdentity } = await hostIdentityFixture(empty);
  const result = await materializeBackupSource({
    directory: test.source.directory,
    expected: test.source.seal,
    roots: test.roots,
    ledger: test.ledger,
    signal: signal(),
    progress: () => undefined,
    hostIdentity,
  });
  await verifyRestoreFiles({ roots: test.roots, ledger: test.ledger, expected: result.files, signal: signal() });
  await expect(fs.lstat(path.join(test.roots.traefik, 'source-tls'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.lstat(path.join(test.roots.state, 'cluster-sync'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(test.roots.state, 'seed'), 'utf8')).toBe('fixture-state');
  expect(await fs.readFile(path.join(test.roots['app-data'], 'document'))).toEqual(Buffer.alloc(320 * 1024, 29));
  if (empty) {
    expect(await fs.readdir(test.roots.traefik)).toEqual([]);
    for (const name of ['cluster.json', 'secure-access'])
      await expect(fs.lstat(path.join(test.roots.state, name))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(test.roots['user-config'], 'tipi-compose.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    expect(await fs.readFile(path.join(test.roots.traefik, 'target-tls'), 'utf8')).toBe('destination certificate identity');
    expect(await fs.readdir(path.join(test.roots.traefik, 'empty-directory'))).toEqual([]);
    expect((await fs.stat(path.join(test.roots.traefik, 'target-tls'))).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(path.join(test.roots['user-config'], 'tipi-compose.yml'), 'utf8')).toBe('destination controller override');
    expect(await fs.readFile(path.join(test.roots.state, 'secure-access', 'authority.json'), 'utf8')).toBe('destination authority fixture');
    await fs.writeFile(path.join(test.roots.traefik, 'target-tls'), 'tampered destination');
    await expect(verifyRestoreFiles({ roots: test.roots, ledger: test.ledger, expected: result.files, signal: signal() })).rejects.toThrow();
  }
});

it('still validates excluded source host files', async () => {
  const { test, hostIdentity } = await hostIdentityFixture(false);
  await fs.writeFile(path.join(test.source.content, 'data/traefik/source-tls'), 'tampered source identity');
  await expect(
    materializeBackupSource({
      directory: test.source.directory,
      expected: test.source.seal,
      roots: test.roots,
      ledger: test.ledger,
      signal: signal(),
      progress: () => undefined,
      hostIdentity,
    }),
  ).rejects.toThrow();
});

it('refuses altered destination snapshot content before it can enter the effective ledger', async () => {
  const { test, hostIdentity } = await hostIdentityFixture(false);
  const files = (await fs.readdir(hostIdentity.directory)).filter((name) => /^\d+$/.test(name));
  const first = files[0];
  if (!first) throw Error('Missing destination snapshot fixture');
  await fs.writeFile(path.join(hostIdentity.directory, first), 'tampered snapshot content');
  await expect(
    materializeBackupSource({
      directory: test.source.directory,
      expected: test.source.seal,
      roots: test.roots,
      ledger: test.ledger,
      signal: signal(),
      progress: () => undefined,
      hostIdentity,
    }),
  ).rejects.toThrow();
});
