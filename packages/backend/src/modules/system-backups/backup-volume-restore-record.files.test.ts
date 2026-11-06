import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalPublicationJson as canonical } from '../host-updates/host-controller-publication';
import { fullBackupFixture } from './backup-import.fixture';
import { addBackupVolumeFixture, volumeFixtureHash } from './backup-volume.fixture';
import { readPreparedVolumeRestoreRecord, withPreparedVolumeRestoreRecord } from './backup-volume-restore-record';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'volume-record-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const base = await fullBackupFixture(root);
  const { manifest, volume } = await addBackupVolumeFixture(base.content, base.manifest);
  const directory = path.join(root, 'store');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, 'lease.sqlite'), '', { mode: 0o600 });
  const identity = { restoreId: randomUUID(), nonce: randomUUID(), imageId: `sha256:${'a'.repeat(64)}`, manifestSha256: 'b'.repeat(64) };
  const generation = randomUUID();
  const attempt = {
    version: 1,
    schema: 'orbis.backup-volume-restore.v1',
    identity,
    generation,
    createdAt: Date.now(),
    phase: 'verified',
    targets: [
      {
        key: volume.key,
        sourceName: volume.sourceName,
        targetName: `orbis-restore-${generation}-${volume.key}`,
        archiveSha256: volume.archive.sha256,
        inventorySha256: volume.inventory.sha256,
        uploaderName: `orbis-volume-restore-${randomUUID()}`,
        uploaderId: 'c'.repeat(64),
        state: 'ready',
        volumeIdentity: 'd'.repeat(64),
        containerIdentity: 'e'.repeat(64),
        verificationSha256: 'f'.repeat(64),
      },
    ],
  };
  const write = async (name: string, value: unknown) => fs.writeFile(path.join(directory, name), canonical(value), { mode: 0o600 });
  const save = async () => {
    await write('origin.json', { version: 1, identity });
    await write(`${generation}.json`, attempt);
    await write('current.json', { version: 1, identity, generation, attemptSha256: volumeFixtureHash(canonical(attempt)) });
  };
  await save();
  const options = { directory, identity, parsedFullBackupManifest: manifest };
  return { directory, identity, generation, attempt, manifest, options, write, save };
}

it('holds the producer lease throughout consumption and releases it after a consumer failure', async () => {
  const f = await fixture();
  const file = path.join(f.directory, 'lease.sqlite');
  const consume = vi.fn(async () => {
    const other = new DatabaseSync(file);
    try {
      expect(() => other.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')).toThrow();
    } finally {
      other.close();
    }
    throw new Error('consumer stopped');
  });
  await expect(withPreparedVolumeRestoreRecord(f.options, consume)).rejects.toThrow('consumer stopped');
  expect(consume).toHaveBeenCalledOnce();
  const released = new DatabaseSync(file);
  try {
    expect(() => released.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')).not.toThrow();
  } finally {
    released.close();
  }
});

it.each(['missing', 'held', 'symlink'] as const)('refuses a %s preparation lease without calling the consumer', async (kind) => {
  const f = await fixture();
  const file = path.join(f.directory, 'lease.sqlite');
  let held: DatabaseSync | undefined;
  if (kind === 'missing') await fs.unlink(file);
  if (kind === 'symlink') {
    await fs.rename(file, `${file}-original`);
    await fs.symlink('lease.sqlite-original', file);
  }
  if (kind === 'held') {
    held = new DatabaseSync(file);
    held.exec('BEGIN EXCLUSIVE');
  }
  const consume = vi.fn();
  try {
    await expect(withPreparedVolumeRestoreRecord(f.options, consume)).rejects.toThrow();
    expect(consume).not.toHaveBeenCalled();
    if (kind === 'missing') await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    held?.close();
  }
});

it('detects replacement of leased storage after consumption', async () => {
  const f = await fixture();
  const file = path.join(f.directory, 'lease.sqlite');
  await expect(
    withPreparedVolumeRestoreRecord(f.options, async () => {
      await fs.rename(file, `${file}-retained`);
      await fs.writeFile(file, '', { mode: 0o600 });
    }),
  ).rejects.toThrow();
  expect((await fs.lstat(`${file}-retained`)).isFile()).toBe(true);
});
it('returns a detached, deeply frozen verified receipt', async () => {
  const f = await fixture();
  const receipt = await readPreparedVolumeRestoreRecord(f.options);
  expect(receipt).toEqual(f.attempt);
  expect(Object.isFrozen(receipt.targets[0])).toBe(true);
  const target = f.attempt.targets[0];
  if (!target) throw new Error('Missing target');
  target.state = 'intent';
  expect(receipt.targets[0]?.state).toBe('ready');
});
it.each(['identity', 'hash', 'foreign', 'manifest', 'phase', 'state', 'extra', 'uploader'] as const)(
  'rejects %s without mutation or retry',
  async (kind) => {
    const f = await fixture();
    const target = f.attempt.targets[0];
    if (!target) throw new Error('Missing target');
    if (kind === 'identity') f.options.identity = { ...f.identity, nonce: randomUUID() };
    if (kind === 'foreign') target.targetName = 'foreign';
    if (kind === 'manifest') target.archiveSha256 = '0'.repeat(64);
    if (kind === 'phase') f.attempt.phase = 'ambiguous';
    if (kind === 'state') target.state = 'uploading';
    if (kind === 'extra') Object.assign(target, { extra: true });
    if (kind === 'uploader') target.uploaderId = '';
    if (kind !== 'identity') await f.save();
    if (kind === 'hash') await f.write('current.json', { version: 1, identity: f.identity, generation: f.generation, attemptSha256: '0'.repeat(64) });
    const before = await fs.readFile(path.join(f.directory, 'current.json'));
    await expect(readPreparedVolumeRestoreRecord(f.options)).rejects.toThrow();
    expect(await fs.readFile(path.join(f.directory, 'current.json'))).toEqual(before);
  },
);
it.each(['symlink', 'hardlink', 'mode', 'directory', 'oversized', 'noncanonical', 'duplicate', 'utf8'] as const)(
  'rejects unsafe %s',
  async (kind) => {
    const f = await fixture();
    const file = path.join(f.directory, 'origin.json');
    if (kind === 'symlink') {
      await fs.rename(file, path.join(f.directory, 'other'));
      await fs.symlink('other', file);
    }
    if (kind === 'hardlink') await fs.link(file, path.join(f.directory, 'other'));
    if (kind === 'mode') await fs.chmod(file, 0o640);
    if (kind === 'directory') await fs.chmod(f.directory, 0o750);
    if (kind === 'oversized') await fs.writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
    if (kind === 'noncanonical') await fs.writeFile(file, `${canonical({ version: 1, identity: f.identity })}\n`);
    if (kind === 'duplicate') await fs.writeFile(file, '{"version":1,"version":1}');
    if (kind === 'utf8') await fs.writeFile(file, Buffer.from([0xff]));
    await expect(readPreparedVolumeRestoreRecord(f.options)).rejects.toThrow();
  },
);
it('rejects a current pointer replaced while the attempt is read', async () => {
  const f = await fixture();
  const original = fs.open.bind(fs);
  let replaced = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (!replaced && String(args[0]).endsWith(`${f.generation}.json`)) {
      replaced = true;
      const replacement = path.join(f.directory, 'new-current');
      await fs.writeFile(replacement, canonical({ version: 1, identity: f.identity, generation: randomUUID(), attemptSha256: '0'.repeat(64) }), {
        mode: 0o600,
      });
      await fs.rename(replacement, path.join(f.directory, 'current.json'));
    }
    return handle;
  });
  await expect(readPreparedVolumeRestoreRecord(f.options)).rejects.toThrow();
  expect(replaced).toBe(true);
});
