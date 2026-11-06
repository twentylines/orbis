import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectFullBackup, parseFullBackupManifest } from './backup-import';
import { fullBackupFixture, fixturePassphrase } from './backup-import.fixture';
import { addBackupVolumeFixture, volumeFixtureHash } from './backup-volume.fixture';
import { decryptBackup, encryptBackup } from './backup-crypto';
import { makeReviewedBackupFixture } from './backup-restore-source.fixture';
import { validateBackupSource } from './backup-restore-source';
import { restoreTreesForManifest } from './backup-restore-materialize';
import { verifyBackupVolumeContents } from './backup-volume-contents';
import { fullBackupLimits } from './backup-limits';
import { stabilizeExistingDarwinFixtures } from './darwin-files.fixture';

let root: string;
const signal = () => new AbortController().signal;
const target = { orbisVersion: 'v1.0.0', runtipiVersion: '4.10.1', architecture: 'arm64' };
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'volume-import-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const backup = await fullBackupFixture(root);
  const volume = await addBackupVolumeFixture(backup.content, backup.manifest);
  Object.assign(backup.manifest, volume.manifest);
  await backup.write();
  return { ...backup, ...volume };
}
const inspect = (archive: string) =>
  inspectFullBackup({ archive, destination: path.join(root, 'inspected'), signal: signal(), maxExpandedBytes: 16 * 1024 * 1024, target });

it('reviews an encrypted v3 volume backup without extracting its app files or claiming restore support', async () => {
  const f = await fixture();
  const encrypted = path.join(root, 'volume.orbis');
  const archive = path.join(root, 'opened.tar.gz');
  await encryptBackup({ source: f.archive, destination: encrypted, passphrase: fixturePassphrase });
  stabilizeExistingDarwinFixtures(encrypted);
  await decryptBackup({ source: encrypted, destination: archive, passphrase: fixturePassphrase });
  const result = await inspect(archive);
  expect(result.review).toMatchObject({
    formatVersion: 3,
    volumeCount: 1,
    mediaPolicy: 'preserve-destination',
    compatibility: { compatible: false, blockers: ['volume-restore-support'] },
  });
  expect(result.manifest).toMatchObject({ version: 3, volumes: [f.volume] });
  expect(await fs.readdir(path.join(root, 'inspected', 'volumes'))).toEqual(
    expect.arrayContaining([`${f.volume.key}.tar`, `${f.volume.key}.inventory.json`]),
  );
  await expect(fs.lstat(path.join(root, 'inspected', 'config'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(() => restoreTreesForManifest(result.manifest)).toThrow('volume recovery support');
});

it.each(['missing-file', 'changed-file', 'unexpected-file', 'wrong-socket', 'foreign-consumer'])(
  'rejects a cryptographically consistent but incorrect independent inventory: %s',
  async (change) => {
    const f = await fixture();
    if (change === 'missing-file') f.inventory.entries = f.inventory.entries.filter((entry) => entry.name !== 'settings');
    if (change === 'changed-file') {
      const file = f.inventory.entries.find((entry) => entry.name === 'settings');
      if (!file) throw new Error('Missing disposable fixture entry');
      Object.assign(file, { sha256: 'b'.repeat(64) });
    }
    if (change === 'unexpected-file') f.inventory.entries.push({ name: 'missing', kind: 'file', bytes: 1, sha256: volumeFixtureHash('x') });
    if (change === 'wrong-socket') f.volume.excludedRuntimeSockets = [];
    if (change === 'foreign-consumer') f.inventory.containerId = 'c'.repeat(64);
    await fs.writeFile(path.join(f.content, f.volume.inventory.name), JSON.stringify(f.inventory));
    await f.refresh(f.volume.inventory.name);
    await f.write();
    await expect(inspect(f.archive)).rejects.toThrow();
  },
);

it('refuses legacy downgrades and missing v3 catalogs rather than treating volumes as ordinary data', async () => {
  const f = await fixture();
  for (const version of [1, 2]) expect(() => parseFullBackupManifest({ ...f.manifest, version })).toThrow();
  expect(() => parseFullBackupManifest({ ...f.manifest, volumes: undefined })).toThrow();
  expect(() => parseFullBackupManifest({ ...f.manifest, volumes: [] })).toThrow();
});

it('checks complete-backup entry and path budgets as well as each individual volume', async () => {
  const f = await fixture();
  await expect(verifyBackupVolumeContents(f.content, [f.volume], signal(), { entries: fullBackupLimits.entries, pathBytes: 0 })).rejects.toThrow();
  await expect(verifyBackupVolumeContents(f.content, [f.volume], signal(), { entries: 0, pathBytes: fullBackupLimits.pathBytes })).rejects.toThrow();
});

it('rejects a damaged volume tar even when the outer manifest authenticates its bytes', async () => {
  const f = await fixture();
  const file = path.join(f.content, f.volume.archive.name);
  const bytes = await fs.readFile(file);
  bytes[148] = 120;
  await fs.writeFile(file, bytes);
  await f.refresh(f.volume.archive.name);
  await f.write();
  await expect(inspect(f.archive)).rejects.toThrow();
});

it('rechecks opaque volume bytes after a reviewed source is sealed', async () => {
  const f = await makeReviewedBackupFixture(root);
  const added = await addBackupVolumeFixture(f.content, f.manifest);
  const bytes = Buffer.from(JSON.stringify(added.manifest));
  await fs.writeFile(path.join(f.content, 'manifest.json'), bytes);
  f.seal.manifest = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  expect((await validateBackupSource({ directory: f.directory, expected: f.seal, signal: signal() })).manifest.version).toBe(3);
  const file = path.join(f.content, added.volume.archive.name);
  const changed = await fs.readFile(file);
  changed[1024] = (changed[1024] ?? 0) ^ 1;
  await fs.writeFile(file, changed);
  await expect(validateBackupSource({ directory: f.directory, expected: f.seal, signal: signal() })).rejects.toThrow();
});
