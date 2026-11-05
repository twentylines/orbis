import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backupMetadataBytes } from './backup-crypto';
import { legacyThemePacks } from '../theme-packs/theme-pack-catalogue';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';
import { readSettingsAssetPart, writeSettingsAssetPart } from './settings-backup-assets';

let root: string;
let restore: () => void;
const passphrase = 'example passphrase';
const signal = new AbortController().signal;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const asset = { id: sha(png), data: png };
const desktop = { appearance: { wallpaperImage: asset.id } };
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Private TMPDIR required');
  root = await fs.mkdtemp(path.join(process.env.TMPDIR, 'settings-assets-'));
  restore = stabilizeDarwinFixtureCreation(() => root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});
async function write() {
  const part = await writeSettingsAssetPart({
    kind: 'wallpapers',
    desktop,
    assets: [asset],
    destination: path.join(root, 'part'),
    passphrase,
    signal,
  });
  stabilizeExistingDarwinFixtures(root);
  return { ...part, passphrase, directory: root, signal };
}
it('round trips authenticated wallpaper without exposing its image or preferences in ciphertext', async () => {
  const part = await write();
  const ciphertext = await fs.readFile(part.file);
  expect(ciphertext.includes(png)).toBe(false);
  expect(ciphertext.includes(Buffer.from(asset.id))).toBe(false);
  expect(await readSettingsAssetPart(part)).toEqual({ version: 1, desktop, assets: [asset] });
  expect((await fs.readdir(root)).sort()).toEqual(['part']);
});
it('rejects incorrect keys, ciphertext corruption and truncation', async () => {
  const part = await write();
  await expect(readSettingsAssetPart({ ...part, passphrase: 'incorrect passphrase' })).rejects.toThrow();
  const ciphertext = await fs.readFile(part.file);
  ciphertext[50] = (ciphertext[50] ?? 0) ^ 1;
  await fs.writeFile(part.file, ciphertext);
  stabilizeExistingDarwinFixtures(root);
  await expect(readSettingsAssetPart({ ...part, sha256: sha(ciphertext) })).rejects.toThrow();
  await fs.writeFile(part.file, ciphertext.subarray(0, -1));
  stabilizeExistingDarwinFixtures(root);
  await expect(readSettingsAssetPart(part)).rejects.toThrow();
});
it('rejects authenticated trailing bytes and malformed asset content', async () => {
  const prefix = Buffer.alloc(12);
  Buffer.from('ORBISSA1').copy(prefix);
  const header = Buffer.from(JSON.stringify({ version: 1, kind: 'wallpapers', desktop, assets: [{ id: asset.id, bytes: png.length }] }));
  prefix.writeUInt32BE(header.length, 8);
  const oversized = Buffer.from(prefix);
  oversized.writeUInt32BE(256 * 1024 + 1, 8);
  const malformedHeader = Buffer.from(JSON.stringify({ version: 1, kind: 'wallpapers', desktop, assets: [], extra: true }));
  const malformedPrefix = Buffer.from(prefix);
  malformedPrefix.writeUInt32BE(malformedHeader.length, 8);
  for (const framed of [
    Buffer.concat([prefix, header, png, Buffer.from('extra')]),
    Buffer.concat([prefix, header, Buffer.alloc(png.length)]),
    Buffer.concat([prefix, header, png.subarray(0, -1)]),
    Buffer.concat([oversized, header]),
    Buffer.concat([malformedPrefix, malformedHeader]),
  ]) {
    const encrypted = await backupMetadataBytes(framed, passphrase, false);
    const file = path.join(root, 'bad');
    await fs.writeFile(file, encrypted, { mode: 0o600 });
    stabilizeExistingDarwinFixtures(root);
    await expect(
      readSettingsAssetPart({ kind: 'wallpapers', file, bytes: encrypted.length, sha256: sha(encrypted), passphrase, directory: root, signal }),
    ).rejects.toThrow();
  }
});
it('rejects missing, extra, mismatched and cross-section data before writing', async () => {
  const base = { kind: 'wallpapers' as const, desktop, assets: [asset], destination: path.join(root, 'part'), passphrase, signal };
  for (const change of [
    { assets: [] },
    { assets: [{ ...asset, id: 'a'.repeat(64) }] },
    { desktop: { appearance: { accent: '#123456' } } },
    { desktop: {}, assets: [asset] },
  ])
    await expect(writeSettingsAssetPart({ ...base, ...change })).rejects.toThrow();
  await expect(fs.stat(base.destination)).rejects.toThrow();
});
it('does not overwrite existing paths, follow symlinks, or proceed after cancellation', async () => {
  const part = await write();
  await expect(
    writeSettingsAssetPart({ kind: 'wallpapers', desktop, assets: [asset], destination: part.file, passphrase, signal }),
  ).rejects.toThrow();
  const link = path.join(root, 'link');
  await fs.symlink(part.file, link);
  await expect(readSettingsAssetPart({ ...part, file: link })).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(readSettingsAssetPart({ ...part, signal: abort.signal })).rejects.toThrow();
  await expect(
    writeSettingsAssetPart({
      kind: 'wallpapers',
      desktop,
      assets: [asset],
      destination: path.join(root, 'cancel'),
      passphrase,
      signal: abort.signal,
    }),
  ).rejects.toThrow();
});

it('round trips registered theme assets and overrides while rejecting missing or extra assets', async () => {
  const manifest = legacyThemePacks.find((item) => item.id === 'alpine' && item.version === '1.1.0');
  const previous = legacyThemePacks.find((item) => item.id === 'alpine' && item.version === '1.0.0');
  if (!previous || previous.wallpaper !== manifest?.wallpaper) throw new Error('Missing previous theme fixture');
  if (!manifest?.assets[0]) throw new Error('Missing theme fixture');
  const data = await fs.readFile(path.resolve(import.meta.dirname, '../../../../frontend/public/wallpapers', manifest.assets[0].path));
  const state = {
    formatVersion: 1 as const,
    selected: { id: manifest.id, version: manifest.version },
    installed: [
      {
        manifest,
        digest: sha(Buffer.from(JSON.stringify(manifest))),
        installedAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        previous: { manifest: previous, digest: sha(Buffer.from(JSON.stringify(previous))) },
      },
    ],
  };
  const themeSettings = {
    formatVersion: 1 as const,
    revision: 2,
    legacyMigration: 'complete' as const,
    settings: { formatVersion: 1 as const, entries: [{ id: 'orbis-builtin', settingsVersion: 1, values: [{ key: 'accent', value: '#123456' }] }] },
  };
  const options = {
    kind: 'themes' as const,
    desktop: { mode: 'dark' },
    state,
    themeSettings,
    assets: [{ id: manifest.wallpaper, data }],
    destination: path.join(root, 'theme'),
    passphrase,
    signal,
  };
  await expect(
    writeSettingsAssetPart({
      ...options,
      themeSettings: { ...themeSettings, settings: { formatVersion: 1, entries: [{ id: 'unknown-theme', settingsVersion: 1, values: [] }] } },
    }),
  ).rejects.toThrow();
  await expect(writeSettingsAssetPart({ ...options, assets: [] })).rejects.toThrow();
  await expect(writeSettingsAssetPart({ ...options, assets: [...options.assets, asset] })).rejects.toThrow();
  const part = await writeSettingsAssetPart(options);
  stabilizeExistingDarwinFixtures(root);
  expect(await readSettingsAssetPart({ ...part, directory: root, passphrase, signal })).toEqual({
    version: 1,
    desktop: options.desktop,
    state,
    themeSettings,
    assets: options.assets,
  });
});

it('round trips an exactly 32 MiB wallpaper whose framed plaintext exceeds the metadata cipher limit', async () => {
  // A valid PNG ancillary tEXt chunk fills the file without changing image dimensions.
  const size = 32 * 1024 ** 2;
  const chunkDataLength = size - png.length - 12;
  const chunk = Buffer.alloc(chunkDataLength + 12);
  chunk.writeUInt32BE(chunkDataLength, 0);
  chunk.write('tEXt', 4, 'ascii');
  chunk.write('Comment', 8, 'ascii');
  const table = Array.from({ length: 256 }, (_, i) => {
    let n = i;
    for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  let crc = 0xffffffff;
  for (let i = 4; i < chunk.length - 4; i++) crc = (table[(crc ^ (chunk[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  const large = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  expect(large.length).toBe(size);
  const largeAsset = { id: sha(large), data: large };
  const selection = { appearance: { wallpaperImage: largeAsset.id } };
  const part = await writeSettingsAssetPart({
    kind: 'wallpapers',
    desktop: selection,
    assets: [largeAsset],
    destination: path.join(root, 'large'),
    passphrase,
    signal,
  });
  expect(part.bytes).toBeGreaterThan(size);
  stabilizeExistingDarwinFixtures(root);
  const restored = await readSettingsAssetPart({ ...part, directory: root, passphrase, signal });
  expect(restored.desktop).toEqual(selection);
  expect(restored.assets).toHaveLength(1);
  expect(restored.assets[0]?.id).toBe(largeAsset.id);
  expect(restored.assets[0]?.data.equals(large)).toBe(true);
  expect(await fs.readdir(root)).toEqual(['large']);
}, 30000);

it('preserves a replacement staging directory and its unknown files', async () => {
  const part = await write();
  const originalOpen = fs.open.bind(fs);
  let replaced = '';
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === part.file && !replaced) {
      const name = (await fs.readdir(root)).find((item) => item.startsWith('.settings-assets-'));
      if (!name) throw new Error('Missing staging directory');
      replaced = path.join(root, name);
      await fs.rename(replaced, path.join(root, 'original-staging'));
      await fs.mkdir(replaced, { mode: 0o700 });
      await fs.writeFile(path.join(replaced, 'unknown'), 'keep', { mode: 0o600 });
    }
    return handle;
  });
  await expect(readSettingsAssetPart(part)).rejects.toThrow();
  spy.mockRestore();
  expect(await fs.readFile(path.join(replaced, 'unknown'), 'utf8')).toBe('keep');
});
