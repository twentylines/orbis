import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptBackup, encryptBackup } from './backup-crypto';
import { stabilizeExistingDarwinFixtures } from './darwin-files.fixture';
import { ResetBackupKeyCustody, type ResetBackupKeyBinding } from './reset-backup-key-custody';

let data: string;
let root: string;
let store: ResetBackupKeyCustody;
let b: ResetBackupKeyBinding;
const c = { archiveSha256: 'a'.repeat(64), archiveBytes: 123 };
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project TMPDIR is required.');
  data = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-key-custody-')));
  root = path.join(data, 'backups', 'reset-keys');
  store = new ResetBackupKeyCustody(data);
  b = { resetId: randomUUID(), backupId: randomUUID(), selectionSha256: 'b'.repeat(64), users: [1, 4] };
});
afterEach(async () => {
  await fs.rm(data, { recursive: true, force: true });
});
const secret = () => store.withReserved(b, async (value) => value);
const record = () => path.join(root, b.backupId, 'record.json');
const key = () => path.join(root, 'key', 'record.json');

it('persists a random encrypted secret across restart, idempotent reservation and sealing', async () => {
  const reservation = await store.reserve(b);
  const value = await secret();
  expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(reservation).toEqual({ keyId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await store.reserve(b)).toEqual(reservation);
  store = new ResetBackupKeyCustody(data);
  expect(await secret()).toBe(value);
  expect(await fs.readFile(record(), 'utf8')).not.toContain(value);
  expect(await fs.readFile(key(), 'utf8')).not.toContain(value);
  await expect(store.withSealed(b, c, async () => true)).rejects.toThrow();
  await store.seal(b, c);
  await store.seal(b, c);
  expect(await store.withSealed(b, c, async (value) => value)).toBe(value);
  await expect(store.seal(b, { ...c, archiveBytes: 124 })).rejects.toThrow();
  await expect(store.withSealed(b, { ...c, archiveSha256: 'c'.repeat(64) }, async () => true)).rejects.toThrow();
});

it('validates binding and commitment before mutation', async () => {
  for (const bad of [
    { ...b, users: [4, 1] },
    { ...b, users: [1, 1] },
    { ...b, backupId: '../bad' },
    { ...b, users: [Number.MAX_SAFE_INTEGER + 1] },
  ])
    await expect(store.reserve(bad)).rejects.toThrow();
  await expect(fs.lstat(root)).rejects.toThrow();
  await store.reserve(b);
  await expect(store.reserve({ ...b, resetId: randomUUID() })).rejects.toThrow();
  await expect(store.withReserved({ ...b, selectionSha256: 'c'.repeat(64) }, async () => true)).rejects.toThrow();
  await expect(store.seal(b, { ...c, archiveBytes: 0 })).rejects.toThrow();
  await expect(fs.lstat(path.join(root, b.backupId, 'sealed'))).rejects.toThrow();
});

it('does not regenerate missing or replaced host keys, including a new reservation', async () => {
  await store.reserve(b);
  const original = await fs.readFile(key());
  await fs.unlink(key());
  await fs.rmdir(path.dirname(key()));
  await expect(store.reserve(b)).rejects.toThrow();
  await expect(fs.lstat(key())).rejects.toThrow();
  await fs.mkdir(path.dirname(key()), { mode: 0o700 });
  await fs.writeFile(key(), JSON.stringify({ version: 1, key: randomBytes(32).toString('base64url') }), { mode: 0o600 });
  await expect(store.reserve({ ...b, backupId: randomUUID() })).rejects.toThrow();
  await fs.writeFile(key(), original);
  expect(await secret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

it('rejects envelope and seal tampering', async () => {
  await store.reserve(b);
  await store.seal(b, c);
  const raw = await fs.readFile(record(), 'utf8');
  const envelope = JSON.parse(raw);
  envelope.tag = 'A'.repeat(22);
  await fs.writeFile(record(), JSON.stringify(envelope));
  await expect(secret()).rejects.toThrow();
  await fs.writeFile(record(), raw);
  const sealed = path.join(root, b.backupId, 'sealed', 'record.json');
  const seal = JSON.parse(await fs.readFile(sealed, 'utf8'));
  seal.commitment.archiveBytes++;
  await fs.writeFile(sealed, JSON.stringify(seal));
  await expect(store.withSealed(b, c, async () => true)).rejects.toThrow();
});

describe.each(['symlink', 'hardlink', 'mode', 'oversize'] as const)('unsafe %s', (kind) => {
  it('rejects unsafe envelope files', async () => {
    await store.reserve(b);
    if (kind === 'mode') await fs.chmod(record(), 0o644);
    if (kind === 'oversize') await fs.writeFile(record(), 'x'.repeat(8193));
    if (kind === 'symlink' || kind === 'hardlink') {
      const source = path.join(data, 'copy');
      await fs.rename(record(), source);
      if (kind === 'symlink') await fs.symlink(source, record());
      else await fs.link(source, record());
    }
    await expect(secret()).rejects.toThrow();
  });
});

it('rejects noncanonical roots, unsafe directories and orphan publication data', async () => {
  expect(() => new ResetBackupKeyCustody(`${data}/../${path.basename(data)}`)).toThrow();
  await store.reserve(b);
  await fs.mkdir(path.join(root, '.pending-interrupted'), { mode: 0o700 });
  await expect(store.reserve(b)).rejects.toThrow();
  await fs.rmdir(path.join(root, '.pending-interrupted'));
  await fs.chmod(root, 0o755);
  await expect(secret()).rejects.toThrow();
});

it('serializes concurrent instances without replacing keys, reservations or commitments', async () => {
  const other = new ResetBackupKeyCustody(data);
  const [a, d] = await Promise.all([store.reserve(b), other.reserve(b)]);
  expect(a).toEqual(d);
  const value = await secret();
  await Promise.all([store.seal(b, c), other.seal(b, c)]);
  expect(await other.withSealed(b, c, async (secret) => secret)).toBe(value);
  const results = await Promise.allSettled([store.seal(b, c), other.seal(b, { ...c, archiveBytes: 999 })]);
  expect(results.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
});

it('allows sealing within the secret callback without retaining a queue lock', async () => {
  await store.reserve(b);
  await store.withReserved(b, async (value) => {
    expect(value).toHaveLength(43);
    await store.seal(b, c);
  });
  await expect(store.withSealed(b, c, async () => true)).resolves.toBe(true);
});

it('leaves failed publication unsealed and refuses its orphan on retry', async () => {
  await store.reserve(b);
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated disk failure'));
  try {
    await expect(store.seal(b, c)).rejects.toThrow();
  } finally {
    rename.mockRestore();
  }
  await expect(store.withSealed(b, c, async () => true)).rejects.toThrow();
  await expect(store.reserve(b)).rejects.toThrow();
});

it('preserves an existing empty commitment directory rather than replacing it', async () => {
  await store.reserve(b);
  const location = path.join(root, b.backupId, 'sealed');
  await fs.mkdir(location, { mode: 0o700 });
  const before = await fs.stat(location);
  await expect(store.seal(b, c)).rejects.toThrow();
  expect((await fs.stat(location)).ino).toBe(before.ino);
  expect(await fs.readdir(location)).toEqual([]);
  await expect(store.withSealed(b, c, async () => true)).rejects.toThrow();
});

it('opens a real archive after restart using only the persisted reservation', async () => {
  await store.reserve(b);
  const source = path.join(data, 'source');
  const archive = path.join(data, 'archive');
  const restored = path.join(data, 'restored');
  await fs.writeFile(source, 'reset safety contents', { mode: 0o600 });
  stabilizeExistingDarwinFixtures(source);
  await store.withReserved(b, async (passphrase) => {
    await encryptBackup({ source, destination: archive, passphrase });
  });
  stabilizeExistingDarwinFixtures(archive);
  store = new ResetBackupKeyCustody(data);
  await store.withReserved(b, async (passphrase) => {
    await decryptBackup({ source: archive, destination: restored, passphrase });
  });
  expect(await fs.readFile(restored, 'utf8')).toBe('reset safety contents');
});

it('rejects a symlinked storage ancestor before creating custody files', async () => {
  const outside = path.join(data, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, path.join(data, 'backups'));
  await expect(store.reserve(b)).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
});
