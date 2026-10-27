import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { verifyRestoreFiles, type RestoreFileReview } from './backup-restore-files';

type LedgerEntry = {
  root: string;
  name: string;
  kind: 'file' | 'directory';
  uid: number;
  gid: number;
  mode: number;
  mtime: number;
  bytes?: number;
  sha256?: string;
};
type FixtureRoots = {
  state: string;
  'app-data': string;
};
type Fixture = {
  directory: string;
  roots: FixtureRoots;
  ledger: string;
  rows: LedgerEntry[];
  expected: RestoreFileReview;
};

let temporaryRoot: string;
const signal = () => new AbortController().signal;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

beforeEach(async () => {
  temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-restore-files-')));
});
afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

async function entry(root: string, rootName: string, name: string, kind: LedgerEntry['kind']): Promise<LedgerEntry> {
  const file = path.join(root, name);
  const stat = await fs.lstat(file);
  const common = {
    root: rootName,
    name,
    kind,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777,
    mtime: stat.mtimeMs,
  };
  if (kind === 'directory') return common;
  const bytes = await fs.readFile(file);
  return { ...common, bytes: bytes.length, sha256: hash(bytes) };
}

async function writeLedger(fixture: Fixture, rows: LedgerEntry[]) {
  const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  await fs.writeFile(fixture.ledger, bytes, { mode: 0o600 });
  await fs.chmod(fixture.ledger, 0o600);
  fixture.rows = rows;
  fixture.expected = {
    bytes: bytes.length,
    sha256: hash(bytes),
    files: rows.filter((row) => row.kind === 'file').length,
    directories: rows.filter((row) => row.kind === 'directory').length,
  };
}

async function makeFixture(): Promise<Fixture> {
  const directory = path.join(temporaryRoot, 'fixture');
  const roots = {
    state: path.join(directory, 'state'),
    'app-data': path.join(directory, 'app-data'),
  };
  const ledgerDirectory = path.join(directory, 'journal');
  const ledger = path.join(ledgerDirectory, 'applied-files.ndjson');
  await Promise.all([
    fs.mkdir(roots.state, { recursive: true, mode: 0o700 }),
    fs.mkdir(roots['app-data'], { recursive: true, mode: 0o700 }),
    fs.mkdir(ledgerDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await fs.mkdir(path.join(roots.state, 'sub', '.orbis-restore-app-settings'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(roots.state, 'sub', 'config.txt'), 'restored state data', { mode: 0o640 });
  await fs.writeFile(path.join(roots.state, 'sub', '.orbis-restore-app-settings', 'cache.bin'), Buffer.from([3, 1, 4, 1, 5]), {
    mode: 0o600,
  });
  await fs.writeFile(path.join(roots['app-data'], 'settings.yml'), 'app data', { mode: 0o600 });

  const modified = new Date('2025-01-02T03:04:05.678Z');
  await fs.utimes(path.join(roots.state, 'sub', 'config.txt'), modified, modified);
  await fs.utimes(path.join(roots.state, 'sub', '.orbis-restore-app-settings', 'cache.bin'), modified, modified);
  await fs.utimes(path.join(roots['app-data'], 'settings.yml'), modified, modified);
  await fs.chmod(path.join(roots.state, 'sub'), 0o750);
  await fs.chmod(path.join(roots.state, 'sub', '.orbis-restore-app-settings'), 0o700);

  const fixture: Fixture = { directory, roots, ledger, rows: [], expected: { bytes: 0, sha256: hash(''), files: 0, directories: 0 } };
  const rows = [
    await entry(roots.state, 'state', 'sub', 'directory'),
    await entry(roots.state, 'state', 'sub/.orbis-restore-app-settings', 'directory'),
    await entry(roots.state, 'state', 'sub/config.txt', 'file'),
    await entry(roots.state, 'state', 'sub/.orbis-restore-app-settings/cache.bin', 'file'),
    await entry(roots['app-data'], 'app-data', 'settings.yml', 'file'),
  ];
  await writeLedger(fixture, rows);
  return fixture;
}

async function verify(fixture: Fixture, options: { expected?: RestoreFileReview; roots?: Record<string, string>; signal?: AbortSignal } = {}) {
  await verifyRestoreFiles({
    ledger: fixture.ledger,
    expected: options.expected ?? fixture.expected,
    roots: options.roots ?? fixture.roots,
    signal: options.signal ?? signal(),
  });
}

async function expectRejected(fixture: Fixture, options?: Parameters<typeof verify>[1]) {
  await expect(verify(fixture, options)).rejects.toThrow();
}

it('verifies a real multi-root ledger, nested reserved-looking filenames, and ignored top-level generation data without changing the ledger', async () => {
  const fixture = await makeFixture();
  const reserved = path.join(fixture.roots.state, '.orbis-restore-fixture.incoming');
  await fs.mkdir(reserved, { mode: 0o700 });
  await fs.writeFile(path.join(reserved, 'owned-by-next-generation'), 'ignored by this review', { mode: 0o600 });
  const beforeBytes = await fs.readFile(fixture.ledger);
  const before = await fs.stat(fixture.ledger);

  await verify(fixture);

  const afterBytes = await fs.readFile(fixture.ledger);
  const after = await fs.stat(fixture.ledger);
  expect(afterBytes).toEqual(beforeBytes);
  expect({ mode: after.mode, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino }).toEqual({
    mode: before.mode,
    size: before.size,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
    ino: before.ino,
  });
});

it('accepts an empty ledger and empty canonical root', async () => {
  const fixture = await makeFixture();
  for (const root of Object.values(fixture.roots)) await fs.rm(root, { recursive: true });
  const emptyRoots = { state: path.join(fixture.directory, 'empty-state') };
  await fs.mkdir(emptyRoots.state, { mode: 0o700 });
  await writeLedger(fixture, []);

  await verify(fixture, { roots: emptyRoots });
});

it('rejects altered file bytes even when size and modification time are restored', async () => {
  const fixture = await makeFixture();
  const row = fixture.rows.find((item) => item.name === 'sub/config.txt') as LedgerEntry;
  const file = path.join(fixture.roots.state, row.name);
  await fs.writeFile(file, 'different state data');
  await fs.utimes(file, new Date(), new Date(row.mtime));

  await expectRejected(fixture);
});

it('rejects changed content metadata and changed directory metadata', async () => {
  const fixture = await makeFixture();
  await fs.chmod(path.join(fixture.roots.state, 'sub', 'config.txt'), 0o600);
  await expectRejected(fixture);

  const second = await makeFixture();
  await fs.utimes(path.join(second.roots.state, 'sub'), new Date(), new Date(Date.now() - 5000));
  await expectRejected(second);
});

it('rejects a file hash that differs from its restored content', async () => {
  const fixture = await makeFixture();
  const rows = fixture.rows.map((row) => (row.kind === 'file' && row.name === 'sub/config.txt' ? { ...row, sha256: '0'.repeat(64) } : row));
  await writeLedger(fixture, rows);

  await expectRejected(fixture);
});

it('rejects ledger digest, byte count, file count, and directory count mismatches', async () => {
  const fixture = await makeFixture();
  await expectRejected(fixture, { expected: { ...fixture.expected, sha256: '0'.repeat(64) } });
  await expectRejected(fixture, { expected: { ...fixture.expected, bytes: fixture.expected.bytes + 1 } });
  await expectRejected(fixture, { expected: { ...fixture.expected, files: fixture.expected.files + 1 } });
  await expectRejected(fixture, { expected: { ...fixture.expected, directories: fixture.expected.directories + 1 } });
});

it('rejects missing and extra restored files', async () => {
  const missing = await makeFixture();
  await fs.rm(path.join(missing.roots.state, 'sub', 'config.txt'));
  await expectRejected(missing);

  const extra = await makeFixture();
  await fs.writeFile(path.join(extra.roots.state, 'unexpected.txt'), 'extra file', { mode: 0o600 });
  await expectRejected(extra);
});

it('rejects symbolic links and hard-linked restored files', async () => {
  const linked = await makeFixture();
  const file = path.join(linked.roots.state, 'sub', 'config.txt');
  const outside = path.join(linked.directory, 'outside.txt');
  await fs.writeFile(outside, 'outside fixture data');
  await fs.rm(file);
  await fs.symlink(outside, file);
  await expectRejected(linked);

  const hardLinked = await makeFixture();
  const original = path.join(hardLinked.roots.state, 'sub', 'config.txt');
  await fs.link(original, path.join(hardLinked.directory, 'second-link.txt'));
  await expectRejected(hardLinked);
});

it('rejects duplicate ledger entries, traversal names, and unknown roots', async () => {
  const duplicate = await makeFixture();
  await writeLedger(duplicate, [...duplicate.rows, duplicate.rows[0] as LedgerEntry]);
  await expectRejected(duplicate);

  const traversal = await makeFixture();
  await writeLedger(
    traversal,
    traversal.rows.map((row, index) => (index === 2 ? { ...row, name: '../outside.txt' } : row)),
  );
  await expectRejected(traversal);

  const unknownRoot = await makeFixture();
  await writeLedger(
    unknownRoot,
    unknownRoot.rows.map((row, index) => (index === 0 ? { ...row, root: 'unknown' } : row)),
  );
  await expectRejected(unknownRoot);
});

it('rejects noncanonical roots and symlinked roots', async () => {
  const fixture = await makeFixture();
  const noncanonical = { ...fixture.roots, state: `${fixture.directory}/state/../state` };
  await expectRejected(fixture, { roots: noncanonical });

  const linkedRoot = path.join(fixture.directory, 'linked-state');
  await fs.symlink(fixture.roots.state, linkedRoot);
  await expectRejected(fixture, { roots: { ...fixture.roots, state: linkedRoot } });
});

it('honors cancellation while reading the ledger', async () => {
  const fixture = await makeFixture();
  const abort = new AbortController();
  abort.abort();

  await expect(verify(fixture, { signal: abort.signal })).rejects.toThrow();
});

it.each(['permissions', 'symlink', 'hardlink'] as const)('rejects a private-ledger violation: %s', async (violation) => {
  const fixture = await makeFixture();
  if (violation === 'permissions') await fs.chmod(fixture.ledger, 0o644);
  if (violation === 'symlink') {
    const original = `${fixture.ledger}.original`;
    await fs.rename(fixture.ledger, original);
    await fs.symlink(original, fixture.ledger);
  }
  if (violation === 'hardlink') await fs.link(fixture.ledger, `${fixture.ledger}.second-link`);

  await expectRejected(fixture);
});
