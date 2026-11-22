import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pinBackupSource, validateBackupSource } from './backup-restore-source';
import { makeReviewedBackupFixture, type ReviewedBackupFixture, type ReviewedBackupFixtureOptions } from './backup-restore-source.fixture';
import { hasInstallRequestHold } from '../app-lifecycle/install-request-receipt';
import { createAppUrn } from '@/common/helpers/app-helpers';

let temporaryRoot: string;
const signal = () => new AbortController().signal;

beforeEach(async () => {
  temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-restore-source-')));
  await fs.chmod(temporaryRoot, 0o700);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

const makeFixture = (options: ReviewedBackupFixtureOptions = {}) => makeReviewedBackupFixture(temporaryRoot, options);

async function expectInvalid(fixture: ReviewedBackupFixture) {
  await expect(validateBackupSource({ directory: fixture.directory, expected: fixture.seal, signal: signal() })).rejects.toThrow();
}

it('validates private reviewed content and selects app resumes from the manifest container state', async () => {
  const stoppedInDatabase = await makeFixture({ dbStatus: 'stopped', manifestRunning: true });
  await expect(
    validateBackupSource({ directory: stoppedInDatabase.directory, expected: stoppedInDatabase.seal, signal: signal() }),
  ).resolves.toMatchObject({
    resumeApps: [{ id: 9, appUrn: 'fixture-app:catalogue' }],
  });

  const runningInDatabase = await makeFixture({ dbStatus: 'running', manifestRunning: false });
  await expect(
    validateBackupSource({ directory: runningInDatabase.directory, expected: runningInDatabase.seal, signal: signal() }),
  ).resolves.toMatchObject({
    resumeApps: [],
  });
});

it.each(['provisional', 'pending', 'spent'] as const)(
  'refuses a reviewed archive with a running %s hold before pinning or replay',
  async (installHold) => {
    const fixture = await makeFixture({ dbStatus: 'stopped', installHold });
    const destination = path.join(temporaryRoot, 'pinned');
    const expected = fixture.seal;
    await expect(pinBackupSource({ directory: fixture.directory, destination, expected, signal: signal() })).rejects.toThrow(
      'unfinished install recovery',
    );
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(fixture.content, 'manifest.json'), 'utf8')).resolves.toBe(JSON.stringify(fixture.manifest));
    await expect(hasInstallRequestHold(path.join(fixture.content, 'data'), createAppUrn('fixture-app', 'catalogue'))).resolves.toBe(true);
  },
);

it.each(['provisional', 'pending', 'spent'] as const)(
  'pins an archived %s hold for an already stopped app without scheduling activation',
  async (installHold) => {
    const fixture = await makeFixture({ dbStatus: 'stopped', manifestRunning: false, installHold });
    const pinned = await pinBackupSource({
      directory: fixture.directory,
      destination: path.join(temporaryRoot, 'pinned'),
      expected: fixture.seal,
      signal: signal(),
    });
    expect(pinned.resumeApps).toEqual([]);
    await expect(hasInstallRequestHold(path.join(pinned.directory, 'content', 'data'), createAppUrn('fixture-app', 'catalogue'))).resolves.toBe(true);
    await expect(fs.readFile(path.join(pinned.directory, 'content', 'manifest.json'), 'utf8')).resolves.toBe(JSON.stringify(fixture.manifest));
  },
);

it('keeps the prior action for a running app with an empty settled receipt directory', async () => {
  const fixture = await makeFixture({ installHold: 'settled' });
  await expect(validateBackupSource({ directory: fixture.directory, expected: fixture.seal, signal: signal() })).resolves.toMatchObject({
    resumeApps: [{ id: 9, appUrn: 'fixture-app:catalogue' }],
  });
});

it.each(['namespace mode', 'app mode', 'namespace owner', 'app owner'] as const)(
  'refuses unsafe restored receipt metadata before pinning a running app: %s',
  async (field) => {
    const fixture = await makeFixture({ installHold: 'settled' });
    const receipt = 'data/state/orbis-install-requests';
    const metadata = fixture.manifest.directories.find(({ name }) =>
      field.startsWith('namespace') ? name === receipt : name.startsWith(`${receipt}/`),
    );
    if (!metadata) throw new Error('Fixture receipt metadata missing.');
    if (field.endsWith('mode')) metadata.mode = 0o755;
    else metadata.uid = metadata.uid === 0 ? 1 : 0;
    const bytes = Buffer.from(JSON.stringify(fixture.manifest));
    await fs.writeFile(path.join(fixture.content, 'manifest.json'), bytes);
    fixture.seal.manifest = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const destination = path.join(temporaryRoot, 'pinned');
    await expect(pinBackupSource({ directory: fixture.directory, destination, expected: fixture.seal, signal: signal() })).rejects.toThrow(
      'recovery storage could not be verified',
    );
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    // Extraction deliberately keeps directories private; admission must inspect
    // the archived attributes which materialization would actually restore.
    const extracted = path.join(fixture.content, metadata.name);
    expect((await fs.stat(extracted)).mode & 0o777).toBe(0o700);
  },
);

it.each(['state', 'namespace', 'app'] as const)('refuses a case-aliased %s receipt path before pinning a restart', async (part) => {
  const fixture = await makeFixture({ installHold: 'settled' });
  const namespace = 'data/state/orbis-install-requests';
  const receipt = fixture.manifest.directories.find(({ name }) => name.startsWith(`${namespace}/`))?.name;
  if (!receipt) throw new Error('Fixture receipt metadata missing.');
  const original = part === 'state' ? 'data/state' : part === 'namespace' ? namespace : receipt;
  const alias =
    part === 'state'
      ? 'data/State'
      : part === 'namespace'
        ? 'data/state/Orbis-Install-Requests'
        : receipt.toUpperCase().replace('DATA/STATE/ORBIS-INSTALL-REQUESTS', namespace);
  await fs.rename(path.join(fixture.content, original), path.join(fixture.content, alias));
  for (const entry of [...fixture.manifest.directories, ...fixture.manifest.files]) {
    if (entry.name === original || entry.name.startsWith(`${original}/`)) entry.name = `${alias}${entry.name.slice(original.length)}`;
  }
  const metadata = fixture.manifest.directories.find(({ name }) => name === `${alias}${receipt.slice(original.length)}`);
  if (!metadata) throw new Error('Fixture receipt metadata missing.');
  metadata.mode = 0o755;
  const bytes = Buffer.from(JSON.stringify(fixture.manifest));
  await fs.writeFile(path.join(fixture.content, 'manifest.json'), bytes);
  fixture.seal.manifest = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const destination = path.join(temporaryRoot, 'pinned');
  await expect(pinBackupSource({ directory: fixture.directory, destination, expected: fixture.seal, signal: signal() })).rejects.toThrow();
  await expect(fs.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['manifest', 'recovery', 'database dump'] as const)('rejects tampered reviewed critical content: %s', async (name) => {
  const fixture = await makeFixture();
  const file = path.join(fixture.content, name === 'database dump' ? 'database.dump' : `${name}.json`);
  const bytes = await fs.readFile(file);
  const changed = Buffer.from(bytes);
  changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
  await fs.writeFile(file, changed, { mode: 0o600 });

  await expectInvalid(fixture);
});

it('rejects an equal-length edit to the critical app config whose digest was reviewed', async () => {
  const fixture = await makeFixture();
  const file = path.join(fixture.content, 'data/apps/catalogue/fixture-app/config.json');
  const before = await fs.readFile(file, 'utf8');
  const changed = before.replace('Fixture App', 'Fixture app');
  expect(changed).toHaveLength(before.length);
  await fs.writeFile(file, changed, { mode: 0o600 });

  await expectInvalid(fixture);
});

it('accepts reordered normalized metadata keys and rejects extra or changed count fields', async () => {
  const fixture = await makeFixture();
  const saved = JSON.parse(await fs.readFile(fixture.normalized, 'utf8')) as Record<string, unknown>;
  const reordered = { sha256: saved.sha256, counts: saved.counts, bytes: saved.bytes, version: saved.version };
  await fs.writeFile(fixture.normalized, JSON.stringify(reordered), { mode: 0o600 });
  await expect(validateBackupSource({ directory: fixture.directory, expected: fixture.seal, signal: signal() })).resolves.toBeDefined();

  await fs.writeFile(fixture.normalized, JSON.stringify({ ...reordered, unexpected: true }), { mode: 0o600 });
  await expectInvalid(fixture);

  const counts = { ...(saved.counts as Record<string, number>), app: 0 };
  await fs.writeFile(fixture.normalized, JSON.stringify({ ...reordered, counts }), { mode: 0o600 });
  await expectInvalid(fixture);
});

it('seals the version 2 migration projection without changing the older seal shape', async () => {
  const fixture = await makeFixture({ migrationIds: ['001-schema'] });
  await expect(validateBackupSource({ directory: fixture.directory, expected: fixture.seal, signal: signal() })).resolves.toBeDefined();
  const saved = JSON.parse(await fs.readFile(fixture.normalized, 'utf8')) as Record<string, unknown>;
  expect(saved).toMatchObject({ version: 2, counts: { app_migration: 1 }, migrationSha256: fixture.seal.normalized.migrationSha256 });
  await fs.writeFile(fixture.normalized, JSON.stringify({ ...saved, version: 1 }), { mode: 0o600 });
  await expectInvalid(fixture);
  await fs.writeFile(fixture.normalized, JSON.stringify({ ...saved, migrationSha256: '0'.repeat(64) }), { mode: 0o600 });
  await expectInvalid(fixture);
});

it('rejects normalized record byte changes even if the JSON summary is unchanged', async () => {
  const fixture = await makeFixture();
  const file = path.join(path.dirname(fixture.normalized), 'records.ndjson');
  const bytes = await fs.readFile(file);
  const changed = Buffer.from(bytes);
  changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
  await fs.writeFile(file, changed, { mode: 0o600 });

  await expectInvalid(fixture);
});

it('rejects a hard-linked normalized database record file', async () => {
  const fixture = await makeFixture();
  const records = path.join(path.dirname(fixture.normalized), 'records.ndjson');
  await fs.link(records, path.join(temporaryRoot, 'records-hardlink'));

  await expectInvalid(fixture);
});

it.each(['symlink', 'hardlink', 'missing', 'extra'] as const)('rejects unsafe or incomplete reviewed content: %s', async (kind) => {
  const fixture = await makeFixture();
  const seed = path.join(fixture.content, 'data/state/seed');
  if (kind === 'symlink') {
    const target = path.join(temporaryRoot, 'outside-seed');
    await fs.writeFile(target, 'fixture-state', { mode: 0o600 });
    await fs.rm(seed);
    await fs.symlink(target, seed);
  } else if (kind === 'hardlink') {
    await fs.link(seed, path.join(temporaryRoot, 'seed-hardlink'));
  } else if (kind === 'missing') {
    await fs.rm(seed);
  } else {
    await fs.writeFile(path.join(fixture.content, 'data/state/extra.txt'), 'extra', { mode: 0o600 });
  }

  await expectInvalid(fixture);
});

it('refuses pin overwrite and leaves both source and existing destination intact', async () => {
  const fixture = await makeFixture();
  const parent = path.join(temporaryRoot, 'pinned');
  const destination = path.join(parent, 'reviewed');
  await fs.mkdir(parent, { mode: 0o700 });
  await fs.mkdir(destination, { mode: 0o700 });
  await fs.writeFile(path.join(destination, 'sentinel'), 'keep existing destination', { mode: 0o600 });

  await expect(pinBackupSource({ directory: fixture.directory, destination, expected: fixture.seal, signal: signal() })).rejects.toThrow();

  await expect(fs.stat(path.join(fixture.content, 'manifest.json'))).resolves.toBeDefined();
  expect(await fs.readFile(path.join(destination, 'sentinel'), 'utf8')).toBe('keep existing destination');
});

it('does not replace a destination that appears before atomic reservation', async () => {
  const fixture = await makeFixture();
  const parent = path.join(temporaryRoot, 'pinned-race');
  const destination = path.join(parent, 'reviewed');
  await fs.mkdir(parent, { mode: 0o700 });
  const actualMkdir = fs.mkdir.bind(fs);
  vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
    if (String(target) === destination) await actualMkdir(destination, { mode: 0o700 });
    return actualMkdir(target, options);
  });

  await expect(pinBackupSource({ directory: fixture.directory, destination, expected: fixture.seal, signal: signal() })).rejects.toThrow();

  await expect(fs.stat(path.join(fixture.content, 'manifest.json'))).resolves.toBeDefined();
  await expect(fs.readdir(destination)).resolves.toEqual([]);
});

it('honors cancellation before atomic pin and preserves the reviewed source', async () => {
  const fixture = await makeFixture();
  const parent = path.join(temporaryRoot, 'pinned');
  const destination = path.join(parent, 'reviewed');
  await fs.mkdir(parent, { mode: 0o700 });
  const abort = new AbortController();
  abort.abort();

  await expect(pinBackupSource({ directory: fixture.directory, destination, expected: fixture.seal, signal: abort.signal })).rejects.toThrow();

  await expect(fs.stat(path.join(fixture.content, 'manifest.json'))).resolves.toBeDefined();
  await expect(fs.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('pins a validated source by same-filesystem rename without replacing the source contents', async () => {
  const fixture = await makeFixture();
  const parent = path.join(temporaryRoot, 'pinned');
  const destination = path.join(parent, 'reviewed');
  await fs.mkdir(parent, { mode: 0o700 });
  const before = await fs.readFile(path.join(fixture.content, 'data/state/seed'));

  const pinned = await pinBackupSource({ directory: fixture.directory, destination, expected: fixture.seal, signal: signal() });

  const payload = path.join(destination, 'payload');
  expect(pinned.directory).toBe(payload);
  expect(pinned.source.file).toBe(path.join(payload, 'database/records.ndjson'));
  expect(await fs.readFile(path.join(payload, 'content/data/state/seed'))).toEqual(before);
  await expect(fs.lstat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['file-as-directory', 'directory-as-file'] as const)('rejects a reviewed content type changed to %s', async (kind) => {
  const fixture = await makeFixture({ manifestRunning: false });
  const target = path.join(fixture.content, kind === 'file-as-directory' ? 'data/state/seed' : 'data/apps');
  await fs.rm(target, { recursive: true });
  if (kind === 'file-as-directory') await fs.mkdir(target, { mode: 0o700 });
  else await fs.writeFile(target, '', { mode: 0o600 });
  await expectInvalid(fixture);
});

it('preserves an inert reservation and source when cancelled immediately after claiming the destination', async () => {
  const fixture = await makeFixture();
  const parent = path.join(temporaryRoot, 'pin-cancel');
  const destination = path.join(parent, 'reviewed');
  await fs.mkdir(parent, { mode: 0o700 });
  const abort = new AbortController();
  const actualMkdir = fs.mkdir.bind(fs);
  vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
    const result = await actualMkdir(target, options);
    if (String(target) === destination) abort.abort();
    return result;
  });
  await expect(pinBackupSource({ directory: fixture.directory, destination, expected: fixture.seal, signal: abort.signal })).rejects.toThrow();
  expect(await fs.readdir(destination)).toEqual([]);
  await expect(fs.stat(path.join(fixture.directory, 'content', 'manifest.json'))).resolves.toBeDefined();
});
