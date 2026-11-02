import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { capturedWallpaper, snapshotWallpaper, timeMachineBuiltinPhotographs } from './time-machine-assets';
import { historicalHomePreview } from './time-machine-preview';
import type { LocalBackupSnapshot } from './system-backups.service';
import { bundledThemePacks } from '../theme-packs/theme-pack-catalogue';
import { timeMachineAssetLimit } from '@runtipi/common/schemas/time-machine';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64');
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
let directory: string;
let snapshot: LocalBackupSnapshot;
let desktop: Record<string, unknown>;
async function write(name: string, data: Buffer | string) {
  const file = path.join(snapshot.content, name);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, data, { mode: 0o600 });
  snapshot = { ...snapshot, files: [...snapshot.files.filter((item) => item.name !== name), { name, bytes: Buffer.byteLength(data) }] };
}
async function preview() {
  await write('data/state/desktop/1.json', JSON.stringify(desktop));
  return historicalHomePreview(snapshot, 1);
}
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-point-wallpaper-')));
  snapshot = {
    content: path.join(directory, 'copied'),
    createdAt: Date.now(),
    manifestSha256: 'a'.repeat(64),
    software: { orbis: 'fixture', runtipi: 'fixture', architecture: 'arm64' },
    files: [],
    databaseBytes: 0,
    apps: [],
  };
  desktop = {
    serverName: 'Historical fixture',
    preset: 'frost',
    mode: 'dark',
    density: 'comfortable',
    wallpaper: 'sandstone',
    wallpaperMode: 'theme',
  };
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

it('retains only the exact custom wallpaper generation referenced by copied preferences', async () => {
  desktop = { ...desktop, wallpaperMode: 'custom', appearance: { wallpaperImage: digest(png) } };
  await write('data/state/wallpapers/1.image', Buffer.concat([png, Buffer.from('new-generation')]));
  await write('data/state/wallpapers/1.image.saved', png);
  const saved = await snapshotWallpaper(snapshot, await preview(), 1, []);
  expect(saved?.source).toBe('captured-custom');
  expect(saved?.identity).toBe(digest(png));
  expect(saved?.data).toEqual(png);
  await fs.writeFile(path.join(directory, 'unrelated-live-image'), Buffer.concat([png, Buffer.from('different')]));
  expect((await snapshotWallpaper(snapshot, await preview(), 1, []))?.data).toEqual(png);
});

it('never falls back to a builtin/current image when the recorded custom image is missing or has changed', async () => {
  desktop = { ...desktop, wallpaperMode: 'custom', appearance: { wallpaperImage: '0'.repeat(64) } };
  await write('data/state/wallpapers/1.image', png);
  const bundled = path.join(directory, 'bundled');
  await fs.mkdir(bundled);
  await fs.writeFile(path.join(bundled, 'frost-v2.webp'), png);
  expect(await snapshotWallpaper(snapshot, await preview(), 1, [bundled])).toBeNull();
});

it('binds captured builtin bytes to a digest and does not re-resolve a photo after capture', async () => {
  const bundled = path.join(directory, 'bundled');
  await fs.mkdir(bundled);
  await fs.writeFile(path.join(bundled, 'frost-v2.webp'), png);
  const saved = await snapshotWallpaper(snapshot, await preview(), 1, [bundled]);
  expect(saved?.source).toBe('captured-builtin');
  expect(saved?.identity).toBe(digest(png));
  await fs.writeFile(path.join(bundled, 'frost-v2.webp'), Buffer.concat([png, Buffer.from('changed')]));
  expect(saved?.data).toEqual(png);
});

it('selects the captured theme version and checks its real asset hash, dimensions and mime', async () => {
  const pack = bundledThemePacks[0];
  if (!pack?.assets[0]) throw new Error('Missing immutable theme fixture.');
  const photo = await fs.readFile(path.resolve('../frontend/public/wallpapers', pack.assets[0].path));
  const timestamp = new Date().toISOString();
  await write(
    'data/state/theme-packs/1/registry.json',
    JSON.stringify({
      formatVersion: 1,
      selected: { id: pack.id, version: pack.version },
      installed: [{ manifest: pack, digest: digest(JSON.stringify(pack)), installedAt: timestamp, updatedAt: timestamp, previous: null }],
    }),
  );
  const name = `data/state/theme-packs/1/${pack.id}/${pack.version}/${pack.wallpaper}`;
  await write(name, photo);
  const saved = await snapshotWallpaper(snapshot, await preview(), 1, []);
  expect(saved?.identity).toBe(pack.wallpaper);
  expect(saved?.source).toBe('captured-theme');
  await fs.writeFile(path.join(snapshot.content, name), png);
  expect(await snapshotWallpaper(snapshot, await preview(), 1, [])).toBeNull();
});

it('rejects symbolic links and out-of-bound or active image types', async () => {
  desktop = { ...desktop, wallpaperMode: 'custom', appearance: { wallpaperImage: digest(png) } };
  await write('data/state/wallpapers/1.image', png);
  const file = path.join(snapshot.content, 'data/state/wallpapers/1.image');
  const outside = path.join(directory, 'outside');
  await fs.writeFile(outside, png);
  await fs.rm(file);
  await fs.symlink(outside, file);
  expect(await snapshotWallpaper(snapshot, await preview(), 1, [])).toBeNull();
  expect(() => capturedWallpaper(Buffer.from('<svg onload="run()"/>'), 'captured-custom')).toThrow();
  expect(() => capturedWallpaper(Buffer.alloc(timeMachineAssetLimit + 1), 'captured-custom')).toThrow();
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(8001, 16);
  oversized.writeUInt32BE(8000, 20);
  expect(() => capturedWallpaper(oversized, 'captured-custom')).toThrow();
});

it('keeps builtin photo identities aligned with the frontend capture-time selection table', async () => {
  const source = await fs.readFile(path.resolve('../frontend/src/desktop/wallpaper-presets.ts'), 'utf8');
  for (const [preset, name] of Object.entries(timeMachineBuiltinPhotographs)) expect(source).toContain(`${preset}: '/wallpapers/${name}'`);
});
