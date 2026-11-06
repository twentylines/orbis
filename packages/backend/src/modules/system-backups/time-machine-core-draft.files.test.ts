import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { normaliseDesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import { TimeMachineStore, type StoredCoreTimeMachinePoint, type TimeMachineCoreDraftMetadata } from './time-machine-store';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
function draft(point: StoredCoreTimeMachinePoint): TimeMachineCoreDraftMetadata {
  return {
    version: 3,
    kind: 'orbis-core',
    coreFormat: 'orbis.time-machine-core.v1',
    id: point.id,
    createdAt: point.createdAt,
    label: 'Core',
    source: 'manual',
    software: { orbis: '1', runtipi: '1', architecture: 'arm64' },
    coverage: {
      database: true,
      configuration: true,
      appearance: true,
      controllerConfiguration: true,
      controllerVersion: true,
      dockerImages: true,
      appData: false,
      cluster: 'local-only',
    },
    restore: { ready: false, blockers: [] },
    preview: { available: false, reason: { code: 'preview-not-captured', message: '' } },
    breakdown: [],
    excludedApps: [],
    restorePolicy: { managedApps: 'preserve-current', proxy: 'preserve-current', recoveryAuthority: 'preserve-current', queue: 'current-drained' },
    compatibility: { os: 'linux', architecture: 'arm64', database: { engine: 'postgresql', major: 17 }, storageFormat: 'physical-pgdata.v1' },
  };
}
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-core-draft-')));
  roots.push(root);
  const store = new TimeMachineStore(root);
  const { point } = await store.create(1, 3);
  return { root, store, point, draft: draft(point), file: path.join(root, 'backups/time-machine/points', point.id, 'capture-draft.orbis') };
}
it('reopens an authenticated draft and reconciles only an identical write', async () => {
  const f = await setup();
  await f.store.saveCoreDraft(f.point, f.draft, signal());
  const before = await fs.readFile(f.file);
  const reopened = new TimeMachineStore(f.root);
  expect(await reopened.readCoreDraft(f.point, signal())).toEqual(f.draft);
  await reopened.saveCoreDraft(f.point, f.draft, signal());
  expect(await fs.readFile(f.file)).toEqual(before);
  await expect(reopened.saveCoreDraft(f.point, { ...f.draft, label: 'different' }, signal())).rejects.toThrow();
  expect(await fs.readFile(f.file)).toEqual(before);
});
it('rejects swapped owner, envelope, id and malformed draft without overwriting', async () => {
  const f = await setup();
  const other = (await f.store.create(2, 3)).point;
  await f.store.saveCoreDraft(f.point, f.draft, signal());
  for (const point of [
    { ...f.point, ownerId: other.ownerId },
    { ...f.point, envelope: other.envelope },
    { ...f.point, id: other.id },
  ])
    await expect(f.store.readCoreDraft(point, signal())).rejects.toThrow();
  await expect(f.store.saveCoreDraft(f.point, { ...f.draft, id: other.id }, signal())).rejects.toThrow();
  await expect(f.store.saveCoreDraft(f.point, { ...f.draft, core: {} } as TimeMachineCoreDraftMetadata, signal())).rejects.toThrow();
});
it('reads after point sealing and rejects creating a draft after sealing', async () => {
  const f = await setup();
  await f.store.saveCoreDraft(f.point, f.draft, signal());
  const hash = 'a'.repeat(64);
  const core = {
    version: 1,
    format: 'orbis.time-machine-core.v1',
    cipherBytes: 52,
    cipherSha256: hash,
    manifestSha256: hash,
    sourceSha256: hash,
    checkpointSha256: hash,
    captureReceiptSha256: hash,
    imageInventorySha256: hash,
    imageCount: 1,
    resourceCount: 1,
  };
  const sealed = { ...f.point, status: 'sealed', archiveBytes: 52, archiveSha256: hash, metadataSha256: hash, core };
  await fs.writeFile(path.join(path.dirname(f.file), 'point.json'), JSON.stringify(sealed));
  const reopened = new TimeMachineStore(f.root);
  const loaded = await reopened.load(f.point.id);
  if (loaded.version !== 3) throw new Error('wrong version');
  expect(await reopened.readCoreDraft(loaded, signal())).toEqual(f.draft);
  await expect(reopened.saveCoreDraft(loaded, f.draft, signal())).rejects.toThrow();
});
it('rejects another point ciphertext even when both point records are valid', async () => {
  const f = await setup();
  const other = (await f.store.create(1, 3)).point;
  await f.store.saveCoreDraft(f.point, f.draft, signal());
  await f.store.saveCoreDraft(other, draft(other), signal());
  const otherFile = path.join(f.root, 'backups/time-machine/points', other.id, 'capture-draft.orbis');
  await fs.copyFile(otherFile, f.file);
  await expect(new TimeMachineStore(f.root).readCoreDraft(f.point, signal())).rejects.toThrow();
});
it('rejects ciphertext tampering and a wrong master key while preserving the file', async () => {
  const f = await setup();
  await f.store.saveCoreDraft(f.point, f.draft, signal());
  const bytes = await fs.readFile(f.file);
  const original = Buffer.from(bytes);
  const last = bytes.at(-1);
  if (last === undefined) throw new Error('The draft fixture is empty.');
  bytes[bytes.length - 1] = last ^ 1;
  await fs.writeFile(f.file, bytes);
  await expect(new TimeMachineStore(f.root).readCoreDraft(f.point, signal())).rejects.toThrow();
  expect(await fs.readFile(f.file)).toEqual(bytes);
  await fs.writeFile(f.file, original);
  const key = path.join(f.root, 'backups/time-machine/keys/master-v1.key');
  await fs.writeFile(key, Buffer.alloc(32, 7));
  await expect(new TimeMachineStore(f.root).readCoreDraft(f.point, signal())).rejects.toThrow();
});
it.each(['symlink', 'permissions', 'hardlink'] as const)('rejects unsafe %s draft file', async (kind) => {
  const f = await setup();
  await f.store.saveCoreDraft(f.point, f.draft, signal());
  if (kind === 'symlink') {
    const target = `${f.file}.target`;
    await fs.rename(f.file, target);
    await fs.symlink(target, f.file);
  }
  if (kind === 'permissions') await fs.chmod(f.file, 0o644);
  if (kind === 'hardlink') await fs.link(f.file, `${f.file}.link`);
  await expect(f.store.readCoreDraft(f.point, signal())).rejects.toThrow();
});
it.each(['wallpaper', 'icons'] as const)('requires advertised %s asset before accepting a draft', async (asset) => {
  const f = await setup();
  const hash = 'a'.repeat(64);
  f.draft.preview = {
    available: true,
    kind: 'historical-home-projection',
    version: 1,
    capturedAt: f.point.createdAt,
    desktop: {
      serverName: 'test',
      preset: 'frost',
      mode: 'light',
      density: 'comfortable',
      wallpaper: 'sandstone',
      wallpaperMode: 'theme',
      wallpaperPreset: null,
      appearance: normaliseDesktopAppearance(undefined),
      workspace: { order: [], hidden: [], wide: [], showAllApps: false, pinnedApps: [] },
    },
    theme: null,
    customWallpaperAvailable: false,
    wallpaperAsset:
      asset === 'wallpaper'
        ? { available: true, identity: hash, cipherSha256: hash, bytes: 1, mime: 'image/png', width: 1, height: 1, source: 'captured-builtin' }
        : { available: false, identity: null, reason: { code: 'historical-assets-unavailable', message: '' } },
    ...(asset === 'icons' ? { appIcons: { available: true as const, identity: hash, cipherSha256: hash, bytes: 1, icons: [] } } : {}),
    screenshot: { available: false, reason: { code: 'screenshot-not-captured', message: '' } },
    resolvedSystemMode: null,
    apps: [],
  };
  const check = vi.spyOn(f.store, asset === 'wallpaper' ? 'wallpaper' : 'appIcons');
  await expect(f.store.saveCoreDraft(f.point, f.draft, signal())).rejects.toThrow();
  expect(check).toHaveBeenCalledOnce();
  await expect(fs.lstat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('honors an already aborted operation without creating evidence', async () => {
  const f = await setup();
  const controller = new AbortController();
  controller.abort();
  await expect(f.store.saveCoreDraft(f.point, f.draft, controller.signal)).rejects.toThrow();
  await expect(fs.lstat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
});
