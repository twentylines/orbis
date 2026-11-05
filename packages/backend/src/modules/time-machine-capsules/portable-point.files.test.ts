import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stabilizeDarwinFixtureCreation } from '../system-backups/darwin-files.fixture';
import { verifiedCapsuleBinding, type VerifiedCapsuleContents } from './verify';
import { sameCapsuleSeal } from './verified-source';
import { portablePointFixture } from './portable-point.fixture';

let root: string;
let restoreCreation: () => void;
const signal = () => new AbortController().signal;
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
};
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portable-point-')));
  await fs.chmod(root, 0o700);
  restoreCreation = stabilizeDarwinFixtureCreation(() => root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  restoreCreation();
  await fs.rm(root, { recursive: true, force: true });
});
const fixture = () => portablePointFixture(root);

it('registers exact ciphers under a new master and owner, preserving preview, proofs, archive access and idempotence', async () => {
  const test = await fixture();
  try {
    const identity = await verifiedCapsuleBinding(test.token, signal());
    expect(identity).toMatchObject({ pointId: test.point.id, archiveSha256: test.point.archiveSha256, metadataSha256: test.point.metadataSha256 });
    expect(JSON.stringify(test.token)).toBe('{}');
    const imported = await test.destination.importPortablePoint(8, test.token, signal());
    expect(imported.created).toBe(true);
    expect(imported.point).toMatchObject({
      id: test.point.id,
      ownerId: 8,
      status: 'sealed',
      createdAt: test.point.createdAt,
      archiveSha256: identity.archiveSha256,
      metadataSha256: identity.metadataSha256,
    });
    expect(imported.point.envelope.keyId).not.toBe(test.point.envelope.keyId);
    const metadata = await test.destination.metadata(imported.point);
    expect(metadata).toEqual(await test.source.metadata(test.point));
    expect(metadata.preview.available && metadata.preview.desktop.serverName).toBe('Saved desktop');
    if (!metadata.preview.available || !metadata.preview.wallpaperAsset.available) throw new Error('Missing wallpaper fixture');
    expect((await test.destination.wallpaper(imported.point, metadata.preview.wallpaperAsset)).data).toEqual(test.png);
    const runtime = await test.destination.verifyRuntime(imported.point, signal());
    expect(runtime.capture.pointId).toBe(test.point.id);
    await test.destination.withArchive(imported.point, signal(), async (stream, key) => {
      expect(key).toBe(test.key);
      for await (const _chunk of stream) {
        /* consume the verified ciphertext */
      }
    });
    await expect(
      test.destination.withArchive({ ...imported.point, ownerId: 3 }, signal(), async (stream) => {
        for await (const _chunk of stream) {
          /* an old owner must not borrow this envelope */
        }
      }),
    ).rejects.toThrow();
    const before = await fs.readFile(path.join(test.destinationRoot, 'backups/time-machine/points', test.point.id, 'point.json'));
    expect((await test.destination.importPortablePoint(8, test.token, signal())).created).toBe(false);
    expect(await fs.readFile(path.join(test.destinationRoot, 'backups/time-machine/points', test.point.id, 'point.json'))).toEqual(before);
    await expect(test.destination.importPortablePoint(3, test.token, signal())).rejects.toThrow();
    expect(await fs.readFile(path.join(test.destinationRoot, 'backups/time-machine/points', test.point.id, 'point.json'))).toEqual(before);
  } finally {
    await test.opened.dispose();
  }
}, 30_000);

it('rejects counterfeit and disposed tokens and unsafe owners without creating library state', async () => {
  const test = await fixture();
  for (const owner of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await expect(test.destination.importPortablePoint(owner, test.token, signal())).rejects.toThrow();
  await expect(test.destination.importPortablePoint(8, {} as VerifiedCapsuleContents, signal())).rejects.toThrow();
  await test.opened.dispose();
  await expect(test.destination.importPortablePoint(8, test.token, signal())).rejects.toThrow();
  expect(await test.destination.list()).toEqual([]);
  await expect(fs.stat(path.join(test.destinationRoot, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 30_000);

it.each(['cipher', 'replace', 'hardlink', 'symlink', 'permissions'] as const)(
  'rejects %s source changes before destination mutation',
  async (change) => {
    const test = await fixture();
    const file = path.join(test.opened.directory, 'backup.orbis');
    const original = await fs.readFile(file);
    if (change === 'cipher') {
      original[0] = (original[0] ?? 0) ^ 1;
      await fs.writeFile(file, original);
    }
    if (change === 'replace' || change === 'symlink') {
      await fs.rename(file, `${file}.previous`);
      if (change === 'replace') await fs.writeFile(file, original, { mode: 0o600 });
      else await fs.symlink(`${file}.previous`, file);
    }
    if (change === 'hardlink') await fs.link(file, `${file}.linked`);
    if (change === 'permissions') await fs.chmod(file, 0o644);
    await expect(test.destination.importPortablePoint(8, test.token, signal())).rejects.toThrow();
    expect(await test.destination.list()).toEqual([]);
    await test.opened.dispose();
  },
  30_000,
);

it('keeps a prepublication failure outside points and preserves an existing point on different ciphertext', async () => {
  const test = await fixture();
  const rename = fs.rename.bind(fs);
  const promotion = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
    if (String(source).includes('/portable-staging/import-') && String(destination).includes('/points/'))
      throw new Error('fixture promotion failure');
    return rename(source, destination);
  });
  await expect(test.destination.importPortablePoint(8, test.token, signal())).rejects.toThrow('fixture promotion failure');
  promotion.mockRestore();
  expect(await test.destination.list()).toEqual([]);
  expect((await fs.readdir(path.join(test.destinationRoot, 'backups/time-machine/portable-staging'))).length).toBe(1);
  const imported = await test.destination.importPortablePoint(8, test.token, signal());
  const stored = path.join(test.destinationRoot, 'backups/time-machine/points', imported.point.id);
  const before = await fs.readFile(path.join(stored, 'point.json'));
  const changed = Buffer.from(await fs.readFile(path.join(stored, 'backup.orbis')));
  changed[0] = (changed[0] ?? 0) ^ 1;
  await fs.writeFile(path.join(stored, 'backup.orbis'), changed);
  await expect(test.destination.importPortablePoint(8, test.token, signal())).rejects.toThrow();
  expect(await fs.readFile(path.join(stored, 'backup.orbis'))).toEqual(changed);
  expect(await fs.readFile(path.join(stored, 'point.json'))).toEqual(before);
  await test.opened.dispose();
}, 30_000);

it('preserves publication provenance after a lost reply and removes only its own exact generation', async () => {
  const test = await fixture();
  const operationId = '11111111-1111-4111-8111-111111111111';
  const otherOperation = '22222222-2222-4222-8222-222222222222';
  const binding = await verifiedCapsuleBinding(test.token, signal());
  const rename = fs.rename.bind(fs);
  const lostReply = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
    await rename(source, destination);
    if (String(source).includes('/portable-staging/import-') && String(destination).includes('/points/'))
      throw new Error('fixture lost publication reply');
  });
  await expect(test.destination.importPortablePoint(8, test.token, signal(), operationId)).rejects.toThrow('fixture lost publication reply');
  lostReply.mockRestore();
  const marker = path.join(test.destinationRoot, 'backups/time-machine/points', binding.pointId, 'portable-import.json');
  const original = await fs.readFile(marker);
  expect(JSON.parse(original.toString()).operationId).toBe(operationId);
  expect((await test.destination.importPortablePoint(8, test.token, signal(), otherOperation)).created).toBe(false);
  expect(await fs.readFile(marker)).toEqual(original);
  await expect(test.destination.removePortableImport(8, otherOperation, binding, signal())).rejects.toThrow();
  await expect(test.destination.removePortableImport(3, operationId, binding, signal())).rejects.toThrow();
  await expect(test.destination.removePortableImport(8, operationId, { ...binding, metadataSha256: 'a'.repeat(64) }, signal())).rejects.toThrow();
  expect(await fs.readFile(marker)).toEqual(original);
  expect(await test.destination.removePortableImport(8, operationId, binding, signal())).toEqual({ removed: true });
  expect(await test.destination.removePortableImport(8, operationId, binding, signal())).toEqual({ removed: false });
  expect(await test.destination.list()).toEqual([]);
  expect((await test.source.load(binding.pointId)).status).toBe('sealed');
  await test.opened.dispose();
}, 30_000);

it('rejects insufficient free space before creating destination keys or staging', async () => {
  const test = await fixture();
  vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0n, bsize: 4096n } as never);
  await expect(test.destination.importPortablePoint(8, test.token, signal())).rejects.toThrow();
  await expect(fs.stat(path.join(test.destinationRoot, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
  await test.opened.dispose();
}, 30_000);

it('rejects a linked destination ancestor before writing through it', async () => {
  const test = await fixture();
  const target = path.join(root, 'alias-target');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, path.join(test.destinationRoot, 'backups'));
  await expect(test.destination.importPortablePoint(8, test.token, signal())).rejects.toThrow();
  expect(await fs.readdir(target)).toEqual([]);
  await test.opened.dispose();
}, 30_000);

it('preserves a full destination library and refuses enrollment before staging', async () => {
  const test = await fixture();
  for (let index = 0; index < 16; index++) await test.destination.create(8);
  const before = await test.destination.list();
  await expect(test.destination.importPortablePoint(8, test.token, signal())).rejects.toThrow();
  expect(await test.destination.list()).toEqual(before);
  await expect(fs.stat(path.join(test.destinationRoot, 'backups/time-machine/portable-staging'))).rejects.toMatchObject({ code: 'ENOENT' });
  await test.opened.dispose();
}, 30_000);

it('accepts a directory timestamp touch while preserving every actual file seal and digest', async () => {
  const test = await fixture();
  const names = await fs.readdir(test.opened.directory);
  const before = await Promise.all(names.map((name) => fs.lstat(path.join(test.opened.directory, name))));
  await fs.utimes(test.opened.directory, new Date(1000), new Date(1000));
  const after = await Promise.all(names.map((name) => fs.lstat(path.join(test.opened.directory, name))));
  expect(before.every((stat, index) => sameCapsuleSeal(stat, required(after[index])))).toBe(true);
  expect((await test.destination.importPortablePoint(8, test.token, signal())).created).toBe(true);
  await test.opened.dispose();
}, 30_000);

it('rejects actual source directory replacement before any destination mutation', async () => {
  const test = await fixture();
  await fs.rename(test.opened.directory, `${test.opened.directory}.previous`);
  await fs.mkdir(test.opened.directory, { mode: 0o700 });
  await expect(test.destination.importPortablePoint(8, test.token, signal())).rejects.toThrow();
  await expect(fs.stat(path.join(test.destinationRoot, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
  await test.opened.dispose();
}, 30_000);
