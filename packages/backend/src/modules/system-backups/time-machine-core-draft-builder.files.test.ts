import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as maintenance from '@/common/backup-maintenance';
import * as installation from '@/common/installation-mode';
import { TimeMachineStore } from './time-machine-store';
import { buildCoreCaptureDraft } from './time-machine-core-draft-builder';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64');
const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(maintenance, 'backupMaintenanceActive').mockReturnValue(true);
  vi.spyOn(maintenance, 'coreCaptureRecoveryRequired').mockReturnValue(false);
  vi.spyOn(installation, 'installationMode').mockReturnValue({ phase: 'normal' } as ReturnType<typeof installation.installationMode>);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-draft-builder-')));
  roots.push(root);
  const store = new TimeMachineStore(root);
  const { point } = await store.create(1, 3);
  const options = {
    dataDirectory: root,
    store,
    point,
    label: 'Core',
    software: { orbis: '1', runtipi: '1', architecture: 'arm64' },
    compatibility: {
      os: 'linux' as const,
      architecture: 'arm64' as const,
      database: { engine: 'postgresql' as const, major: 17 },
      storageFormat: 'physical-pgdata.v1' as const,
    },
    apps: [{ urn: 'notes:store', name: 'Notes', running: true }],
    signal: new AbortController().signal,
  };
  const write = async (relative: string, value: Buffer | string) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  };
  return { root, store, point, options, write };
}
it('copies fixed inputs, retains actual assets and reopens the persisted projection', async () => {
  const f = await setup();
  const hash = createHash('sha256').update(png).digest('hex');
  await f.write(
    'state/desktop/1.json',
    JSON.stringify({ serverName: 'Home', preset: 'forest', density: 'compact', wallpaperMode: 'custom', appearance: { wallpaperImage: hash } }),
  );
  await f.write('state/wallpapers/1.image', png);
  await f.write('apps/store/notes/metadata/logo.jpg', png);
  await fs.symlink('/does-not-exist', path.join(f.root, 'app-data'));
  await fs.symlink('/does-not-exist', path.join(f.root, 'media'));
  const result = await buildCoreCaptureDraft(f.options);
  expect(result.preview.available).toBe(true);
  if (!result.preview.available || !result.preview.wallpaperAsset.available || !result.preview.appIcons) throw new Error('missing retained assets');
  expect(result.preview.screenshot.available).toBe(false);
  expect((await f.store.wallpaper(f.point, result.preview.wallpaperAsset)).data).toEqual(png);
  expect((await f.store.appIcons(f.point, result.preview.appIcons)).length).toBeGreaterThan(0);
  expect(await new TimeMachineStore(f.root).readCoreDraft(f.point, f.options.signal)).toEqual(result);
  const entries = await fs.readdir(path.join(f.root, 'backups/time-machine/points', f.point.id));
  expect(entries.some((name) => name.startsWith('preview-'))).toBe(false);
});
it('retains the bundled photograph for a default-theme historical projection', async () => {
  const f = await setup();
  await f.write('state/desktop/1.json', JSON.stringify({ serverName: 'Home', preset: 'forest', density: 'compact' }));
  const result = await buildCoreCaptureDraft(f.options);
  if (!result.preview.available || !result.preview.wallpaperAsset.available) throw new Error('The bundled wallpaper was not retained.');
  expect(result.preview.wallpaperAsset.source).toBe('captured-builtin');
  expect((await f.store.wallpaper(f.point, result.preview.wallpaperAsset)).data.length).toBeGreaterThan(0);
});
it('keeps missing optional inputs truthful and durable', async () => {
  const f = await setup();
  const result = await buildCoreCaptureDraft(f.options);
  expect(result.preview.available).toBe(false);
  expect(result.breakdown).toEqual([]);
  expect(await new TimeMachineStore(f.root).readCoreDraft(f.point, f.options.signal)).toEqual(result);
});
it('keeps unsupported optional image unavailable', async () => {
  const f = await setup();
  await f.write(
    'state/desktop/1.json',
    JSON.stringify({
      serverName: 'Home',
      preset: 'forest',
      density: 'compact',
      wallpaperMode: 'custom',
      appearance: { wallpaperImage: 'a'.repeat(64) },
    }),
  );
  await f.write('state/wallpapers/1.image', 'not-an-image');
  const result = await buildCoreCaptureDraft(f.options);
  expect(result.preview.available && result.preview.wallpaperAsset.available).toBe(false);
});
it.each(['symlink', 'oversize'] as const)('rejects %s fixed input before persisting draft', async (fault) => {
  const f = await setup();
  await fs.mkdir(path.join(f.root, 'state/desktop'), { recursive: true });
  const file = path.join(f.root, 'state/desktop/1.json');
  if (fault === 'symlink') await fs.symlink('/does-not-exist', file);
  else await fs.writeFile(file, Buffer.alloc(128 * 1024 + 1));
  await expect(buildCoreCaptureDraft(f.options)).rejects.toThrow();
  await expect(f.store.readCoreDraft(f.point, f.options.signal)).rejects.toThrow();
});
it('rejects cancellation, changed hold, and a swapped point', async () => {
  const f = await setup();
  const controller = new AbortController();
  controller.abort();
  await expect(buildCoreCaptureDraft({ ...f.options, signal: controller.signal })).rejects.toThrow();
  vi.mocked(maintenance.backupMaintenanceActive).mockReturnValue(false);
  await expect(buildCoreCaptureDraft(f.options)).rejects.toThrow();
  vi.mocked(maintenance.backupMaintenanceActive).mockReturnValue(true);
  await expect(buildCoreCaptureDraft({ ...f.options, point: { ...f.point, ownerId: 2 } })).rejects.toThrow();
});
it.each(['mode', 'capture'] as const)('rejects an unsafe %s guard', async (fault) => {
  const f = await setup();
  if (fault === 'mode')
    vi.mocked(installation.installationMode).mockReturnValue({ phase: 'resume' } as ReturnType<typeof installation.installationMode>);
  else vi.mocked(maintenance.coreCaptureRecoveryRequired).mockReturnValue(true);
  await expect(buildCoreCaptureDraft(f.options)).rejects.toThrow();
});
it('stops before persisting if point identity changes during copying', async () => {
  const f = await setup();
  await f.write('state/desktop/1.json', JSON.stringify({ serverName: 'Home', preset: 'forest', density: 'compact' }));
  const load = vi.spyOn(f.store, 'load');
  load.mockResolvedValueOnce(f.point).mockResolvedValue({ ...f.point, ownerId: 2 });
  await expect(buildCoreCaptureDraft(f.options)).rejects.toThrow();
  load.mockRestore();
  await expect(f.store.readCoreDraft(f.point, f.options.signal)).rejects.toThrow();
});
