import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backupMetadataBytes } from '../system-backups/backup-crypto';
import { exportCapsule, importCapsule, type CapsuleSource } from './capsule';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from '../system-backups/darwin-files.fixture';
let root: string;
let restoreFixtureCreation: () => void;
let entries: CapsuleSource[];
let expected: Map<string, Buffer>;
const password = 'fixture-capsule-password';
const pointKey = randomBytes(32).toString('base64url');
const pointId = randomUUID();
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'capsule-files-')));
  await fs.chmod(root, 0o700);
  restoreFixtureCreation = stabilizeDarwinFixtureCreation(() => root);
  expected = new Map();
  entries = [];
  for (const name of ['backup.orbis', 'runtime.orbis', 'metadata.orbis'] as const) {
    const value = await backupMetadataBytes(Buffer.alloc(1200, name.charCodeAt(0)), pointKey, false);
    const file = path.join(root, name);
    await fs.writeFile(file, value, { mode: 0o600 });
    expected.set(name, value);
    entries.push({ name, bytes: value.length, sha256: sha(value), file });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  restoreFixtureCreation();
  await fs.rm(root, { recursive: true, force: true });
});
async function exported(name = 'capture.orbis-tm') {
  stabilizeExistingDarwinFixtures(root);
  const destination = path.join(root, name);
  const result = await exportCapsule({
    destination,
    pointId,
    createdAt: 1,
    pointKey,
    entries,
    passphrase: password,
    signal: new AbortController().signal,
    segmentBytes: 1024,
  });
  return { destination, ...result };
}
async function open(source: string, passphrase = password, verify = async () => undefined, signal = new AbortController().signal) {
  return importCapsule({ source, stagingParent: root, passphrase, signal, verify });
}
it('exports and reimports every exact inner cipher without a plaintext point key or source master key', async () => {
  const result = await exported();
  expect(result.segments).toBeGreaterThan(1);
  const bytes = await fs.readFile(result.destination);
  expect(bytes.includes(Buffer.from(pointKey))).toBe(false);
  expect(bytes.includes(Buffer.from('pointKey'))).toBe(false);
  const verify = vi.fn(async (manifest, directory) => {
    expect(manifest.pointKey).toBe(pointKey);
    expect(manifest.pointId).toBe(pointId);
    for (const [name, value] of expected) expect(await fs.readFile(path.join(directory, name))).toEqual(value);
  });
  const imported = await importCapsule({
    source: result.destination,
    stagingParent: root,
    passphrase: password,
    signal: new AbortController().signal,
    verify,
  });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(imported.restoreSupported).toBe(false);
  expect(Object.keys(imported)).not.toContain('pointKey');
  await imported.dispose();
  expect(
    (await fs.readdir(root)).filter((name) => name.startsWith('capsule-') || name.startsWith('.segment-') || name.startsWith('.capsule-')),
  ).toEqual([]);
});
it('rejects wrong passphrases, truncation, extra data and changed ciphertext before verification is published', async () => {
  const { destination } = await exported();
  const original = await fs.readFile(destination);
  const verify = vi.fn();
  await expect(open(destination, 'wrong-fixture-passphrase', verify)).rejects.toThrow();
  for (const [name, value] of [
    ['truncated', original.subarray(0, -1)],
    ['extra', Buffer.concat([original, Buffer.from('x')])],
    ['tamper', Buffer.from(original)],
  ] as const) {
    if (name === 'tamper') value[value.length - 20] = (value[value.length - 20] ?? 0) ^ 1;
    const source = path.join(root, name);
    await fs.writeFile(source, value, { mode: 0o600 });
    await expect(open(source, password, verify)).rejects.toThrow();
  }
  expect(verify).not.toHaveBeenCalled();
  expect((await fs.readdir(root)).some((name) => name.startsWith('capsule-'))).toBe(false);
});
it('rejects reordered authenticated segments even after their public indices are rewritten', async () => {
  const { destination } = await exported();
  const bytes = await fs.readFile(destination);
  const headerBytes = bytes.readUInt32BE(8);
  const header = JSON.parse(bytes.subarray(12, 12 + headerBytes).toString());
  const first = 12 + headerBytes + header.manifestBytes;
  const length = 44 + Number(bytes.readBigUInt64BE(first + 4));
  const firstFrame = Buffer.from(bytes.subarray(first, first + length));
  const secondFrame = Buffer.from(bytes.subarray(first + length, first + 2 * length));
  secondFrame.writeUInt32BE(0);
  firstFrame.writeUInt32BE(1);
  secondFrame.copy(bytes, first);
  firstFrame.copy(bytes, first + length);
  const source = path.join(root, 'reordered');
  await fs.writeFile(source, bytes, { mode: 0o600 });
  await expect(open(source)).rejects.toThrow();
});
it('aborts exports and imports without publishing partial results', async () => {
  const abort = new AbortController();
  const destination = path.join(root, 'aborted');
  await expect(
    exportCapsule({
      destination,
      pointId,
      createdAt: 1,
      pointKey,
      entries,
      passphrase: password,
      signal: abort.signal,
      segmentBytes: 1024,
      progress: () => abort.abort(),
    }),
  ).rejects.toThrow();
  await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  const source = await exported();
  const controller = new AbortController();
  await expect(
    importCapsule({
      source: source.destination,
      stagingParent: root,
      passphrase: password,
      signal: controller.signal,
      verify: async () => {
        controller.abort();
      },
    }),
  ).rejects.toThrow();
  expect((await fs.readdir(root)).some((name) => name.startsWith('capsule-'))).toBe(false);
});
it('fails closed on insufficient disk and removes an output after a simulated write failure', async () => {
  const stat = vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0n, bsize: 1n } as never);
  await expect(exported()).rejects.toThrow();
  stat.mockRestore();
  const original = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]).includes('.capsule-') && String(args[1]) === 'wx')
      vi.spyOn(handle, 'write').mockRejectedValue(Object.assign(new Error('Fixture full disk'), { code: 'ENOSPC' }));
    return handle;
  });
  await expect(exported()).rejects.toThrow();
  expect(
    (await fs.readdir(root)).filter((name) => name.startsWith('.capsule-') || name.startsWith('.segment-') || name === 'capture.orbis-tm'),
  ).toEqual([]);
});
it('rejects linked sources and an invalid per-entry size before writing a capsule', async () => {
  const target = path.join(root, 'linked');
  await fs.symlink(path.join(root, 'runtime.orbis'), target);
  const value = entries[1];
  if (!value) throw new Error('Missing fixture');
  entries[1] = { ...value, file: target, source: undefined } as CapsuleSource;
  await expect(exported()).rejects.toThrow();
  entries[1] = { ...value, bytes: 2 ** 36 + 53 };
  await expect(exported()).rejects.toThrow();
});
it('binds review to the whole uploaded cipher hash before exposing any contents', async () => {
  const source = await exported();
  const verify = vi.fn();
  await expect(
    importCapsule({
      source: source.destination,
      stagingParent: root,
      passphrase: password,
      expectedSha256: '0'.repeat(64),
      signal: new AbortController().signal,
      verify,
    }),
  ).rejects.toThrow();
  expect(verify).not.toHaveBeenCalled();
});

it('preserves an optional encrypted icon bundle alongside existing capsule entry layouts', async () => {
  const value = await backupMetadataBytes(Buffer.from('opaque point-bound icon fixture'), pointKey, false);
  const file = path.join(root, 'icons.orbis');
  await fs.writeFile(file, value, { mode: 0o600 });
  entries.push({ name: 'icons.orbis', bytes: value.length, sha256: sha(value), file });
  const result = await exported();
  const imported = await importCapsule({
    source: result.destination,
    stagingParent: root,
    passphrase: password,
    signal: new AbortController().signal,
    verify: async (_manifest, directory) => {
      expect(await fs.readFile(path.join(directory, 'icons.orbis'))).toEqual(value);
    },
  });
  await imported.dispose();
});
