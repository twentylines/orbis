import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pinBackupSource, validateBackupSource } from './backup-restore-source';
import { makeReviewedBackupFixture, type ReviewedBackupFixture, type ReviewedBackupFixtureOptions } from './backup-restore-source.fixture';

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
