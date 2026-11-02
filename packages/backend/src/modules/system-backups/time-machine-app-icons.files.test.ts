import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { historicalIconLimits, historicalIconsAssetSchema } from '@runtipi/common/schemas/time-machine-icons';
import { snapshotAppIcons, verifyAppIcons } from './time-machine-app-icons';
import type { LocalBackupSnapshot } from './system-backups.service';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64');
let root: string;
let snapshot: LocalBackupSnapshot;
const signal = () => new AbortController().signal;
async function write(name: string, bytes: Buffer) {
  const file = path.join(snapshot.content, name);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, bytes, { mode: 0o600 });
  snapshot = { ...snapshot, files: [...snapshot.files, { name, bytes: bytes.length }] };
  return file;
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'historical-icons-')));
  snapshot = {
    content: path.join(root, 'copied'),
    apps: [{ urn: 'notes:store', name: 'Notes', running: true }],
    files: [],
    createdAt: 1,
    manifestSha256: 'a'.repeat(64),
    software: { orbis: 'fixture', runtipi: 'fixture', architecture: 'arm64' },
    databaseBytes: 0,
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it('uses copied installed icon precedence and ignores later live or repository generations', async () => {
  await write('data/apps/store/notes/metadata/logo.jpg', png);
  await write('data/repos/store/apps/notes/metadata/logo.jpg', Buffer.concat([png, Buffer.from('different')]));
  const value = await snapshotAppIcons(snapshot, signal());
  if (!value) throw new Error('Missing copied icon');
  expect(value.icons[0]).toMatchObject({ urn: 'notes:store', source: 'captured-installed', mime: 'image/png' });
  expect(verifyAppIcons(value.data, { ...value, bytes: value.data.length }).icons[0]?.data).toBe(png.toString('base64'));
  await fs.writeFile(path.join(root, 'unrelated-live-icon.jpg'), 'later');
  expect((await snapshotAppIcons(snapshot, signal()))?.identity).toBe(value.identity);
});
it('uses an inventory-bound repository image only when no installed icon was copied', async () => {
  const file = await write('data/repos/store/apps/notes/metadata/logo.jpg', png);
  expect((await snapshotAppIcons(snapshot, signal()))?.icons[0]?.source).toBe('captured-repository');
  snapshot = { ...snapshot, files: [] };
  expect(await snapshotAppIcons(snapshot, signal())).toBeNull();
  expect(await fs.readFile(file)).toEqual(png);
});
it('rejects traversal URNs before any filesystem access and does not capture unrelated app files', async () => {
  await write('data/apps/store/other/metadata/logo.jpg', png);
  expect(await snapshotAppIcons(snapshot, signal())).toBeNull();
  snapshot = { ...snapshot, apps: [{ urn: '../notes:store', name: 'Invalid', running: false }] };
  await expect(snapshotAppIcons(snapshot, signal())).rejects.toThrow();
});
it('never resolves symbolic links, hard links or parent symlinks outside copied content', async () => {
  const file = await write('data/apps/store/notes/metadata/logo.jpg', png);
  const outside = path.join(root, 'keep');
  await fs.writeFile(outside, png);
  await fs.rm(file);
  await fs.symlink(outside, file);
  expect(await snapshotAppIcons(snapshot, signal())).toBeNull();
  await fs.rm(file);
  await fs.link(outside, file);
  expect(await snapshotAppIcons(snapshot, signal())).toBeNull();
  await fs.rm(file);
  await fs.rmdir(path.dirname(file));
  const directory = path.join(root, 'outside');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'logo.jpg'), png);
  await fs.symlink(directory, path.dirname(file));
  expect(await snapshotAppIcons(snapshot, signal())).toBeNull();
  expect(await fs.readFile(outside)).toEqual(png);
});
it('fails closed for active types, oversized images, changed inventory and cancellation', async () => {
  const file = await write('data/apps/store/notes/metadata/logo.jpg', Buffer.from('<svg onload="x()"/>'));
  expect(await snapshotAppIcons(snapshot, signal())).toBeNull();
  await fs.writeFile(file, Buffer.alloc(historicalIconLimits.imageBytes + 1));
  expect(await snapshotAppIcons(snapshot, signal())).toBeNull();
  const abort = new AbortController();
  abort.abort();
  await expect(snapshotAppIcons(snapshot, abort.signal)).rejects.toThrow();
});
it('verifies every icon digest and descriptor against the encrypted-metadata collection', async () => {
  await write('data/apps/store/notes/metadata/logo.jpg', png);
  const value = await snapshotAppIcons(snapshot, signal());
  if (!value) throw new Error('Missing copied icon');
  expect(() => verifyAppIcons(value.data, { ...value, bytes: value.data.length, identity: '0'.repeat(64) })).toThrow();
  const payload = JSON.parse(value.data.toString());
  payload.icons[0].data = Buffer.from('tampered').toString('base64');
  const tampered = Buffer.from(JSON.stringify(payload));
  expect(() =>
    verifyAppIcons(tampered, { ...value, bytes: tampered.length, identity: createHash('sha256').update(tampered).digest('hex') }),
  ).toThrow();
});

it('bounds aggregate retained images and rejects repeated app identities', async () => {
  await write('data/apps/store/notes/metadata/logo.jpg', png);
  const value = await snapshotAppIcons(snapshot, signal());
  if (!value?.icons[0]) throw new Error('Missing copied icon');
  const base = { available: true, bytes: value.data.length, identity: value.identity, cipherSha256: 'a'.repeat(64) };
  expect(
    historicalIconsAssetSchema.allows({
      ...base,
      icons: Array.from({ length: 17 }, (_, index) => ({ ...value.icons[0], urn: `app${index}:store`, bytes: historicalIconLimits.imageBytes })),
    }),
  ).toBe(false);
  expect(historicalIconsAssetSchema.allows({ ...base, icons: [value.icons[0], value.icons[0]] })).toBe(false);
});
