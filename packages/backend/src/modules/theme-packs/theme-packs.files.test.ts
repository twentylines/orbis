import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { themePackManifestSchema } from '@runtipi/common/schemas/theme-pack';
import { bundledThemePacks, discoverableThemePacks, legacyThemePacks } from './theme-pack-catalogue';
import { ThemePacksService, validateThemeAsset } from './theme-packs.service';
import { ThemePacksController } from './theme-packs.controller';

describe('account theme pack lifecycle with real files', () => {
  let directory: string;
  let service: ThemePacksService;
  let config: ConfigurationService;
  const pack = bundledThemePacks.find((item) => item.id === 'alpine' && item.version === '1.0.0');
  if (!pack) throw new Error('Test catalogue version missing');
  const seedIdentity = { id: pack.id, version: pack.version };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'theme-packs-'));
    config = { get: () => ({ dataDir: directory }) } as unknown as ConfigurationService;
    service = new ThemePacksService(config);
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function seedLegacyInstallation(userId: number, id = seedIdentity.id, version = seedIdentity.version) {
    const manifest = legacyThemePacks.find((item) => item.id === id && item.version === version);
    if (!manifest?.assets[0]) throw new Error('Missing historical installation fixture');
    const state = (await service.snapshot(userId)).state;
    const folder = path.join(directory, 'state', 'theme-packs', String(userId));
    const assetFolder = path.join(folder, id, version);
    await fs.mkdir(assetFolder, { recursive: true, mode: 0o700 });
    const bytes = await fs.readFile(path.resolve(import.meta.dirname, '../../../../frontend/public/wallpapers', manifest.assets[0].path));
    validateThemeAsset(manifest, bytes);
    await fs.writeFile(path.join(assetFolder, manifest.wallpaper), bytes, { mode: 0o600 });
    state.installed.push({
      manifest,
      digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      installedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      previous: null,
    });
    await fs.writeFile(path.join(folder, 'registry.json'), JSON.stringify(state), { mode: 0o600 });
  }

  it('loads a prior verified installation without applying and serves only this account original hash bytes', async () => {
    await seedLegacyInstallation(7);

    const result = await service.install(7, pack.id, pack.version);
    expect(result.state.selected).toBeNull();
    expect(result.state.installed[0]?.manifest).toEqual(pack);
    expect(result.state.installed[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    const reloaded = new ThemePacksService(config);
    expect((await reloaded.snapshot(7)).state).toEqual(result.state);
    const asset = await reloaded.asset(7, pack.id, pack.version, pack.wallpaper);
    expect(asset.data.length).toBe(pack.assets[0]?.bytes);
    expect(validateThemeAsset(pack, asset.data).sha256).toBe(pack.wallpaper);
    expect((await fs.stat(path.join(directory, 'state/theme-packs/7/registry.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(directory, 'state/theme-packs/7/alpine/1.0.0', pack.wallpaper))).mode & 0o777).toBe(0o600);
    expect((await reloaded.snapshot(8)).state.installed).toEqual([]);
    await expect(reloaded.asset(8, pack.id, pack.version, pack.wallpaper)).rejects.toThrow('not found');
    await expect(reloaded.select(8, { id: pack.id, version: pack.version })).rejects.toThrow('before applying');
  });

  it('updates and rolls back applied version while preserving personal preferences byte for byte', async () => {
    await fs.mkdir(path.join(directory, 'state/desktop'), { recursive: true });
    const personal = JSON.stringify({
      appearance: { accent: '#123456', textScale: 150, wallpaperImage: 'a'.repeat(64), surfaceOpacity: 100, motion: 'reduced', dockSize: 'large' },
      wallpaperMode: 'custom',
      windows: { settings: { x: 99 } },
      workspace: { hidden: ['activity'] },
    });
    const preferences = path.join(directory, 'state/desktop/7.json');
    await fs.writeFile(preferences, personal);
    await seedLegacyInstallation(7, pack.id, '1.0.0');
    await service.select(7, { id: pack.id, version: '1.0.0' });
    const updated = await service.install(7, pack.id, undefined, true);
    expect(updated.state.selected).toEqual({ id: pack.id, version: '1.1.0' });
    expect(updated.state.installed[0]?.previous?.manifest.version).toBe('1.0.0');
    const rolledBack = await service.rollback(7, pack.id);
    expect(rolledBack.state.selected?.version).toBe('1.0.0');
    expect(rolledBack.state.installed[0]?.previous?.manifest.version).toBe('1.1.0');
    expect(await fs.readFile(preferences, 'utf8')).toBe(personal);
    const removed = await service.remove(7, pack.id);
    expect(removed.state).toEqual({ formatVersion: 1, installed: [], selected: null });
    expect(await fs.readFile(preferences, 'utf8')).toBe(personal);
    await expect(fs.stat(path.join(directory, 'state/theme-packs/7/alpine'))).rejects.toThrow();
    expect((await new ThemePacksService(config).snapshot(7)).state.selected).toBeNull();
  });

  it('backs up current and previous theme assets and restores them to a different account without a bundled download', async () => {
    await seedLegacyInstallation(7, pack.id, '1.0.0');
    await service.select(7, { id: pack.id, version: '1.0.0' });
    await service.install(7, pack.id, '1.1.0', true);
    const saved = await service.backupSnapshot(7);
    expect(saved.state.installed[0]?.previous?.manifest.version).toBe('1.0.0');
    expect(saved.assets.map((asset) => asset.id)).toEqual([
      ...new Set(saved.state.installed.flatMap((item) => [item.manifest.wallpaper, ...(item.previous ? [item.previous.manifest.wallpaper] : [])])),
    ]);
    await service.restoreBackupSnapshot(8, saved);
    expect(await service.backupSnapshot(8)).toEqual(saved);
    await service.rollback(8, pack.id);
    expect((await service.snapshot(8)).state.selected?.version).toBe('1.0.0');
    expect((await service.snapshot(7)).state.selected?.version).toBe('1.1.0');
  });

  it('rejects missing, extra, duplicate, corrupt and unregistered backup assets before writing account state', async () => {
    await seedLegacyInstallation(7);
    const saved = await service.backupSnapshot(7);
    const firstAsset = saved.assets[0];
    if (!firstAsset) throw new Error('Missing seeded theme asset');
    for (const assets of [
      [],
      [...saved.assets, firstAsset],
      [{ id: 'a'.repeat(64), data: Buffer.from('unrecognized') }],
      saved.assets.map((asset) => ({ ...asset, data: Buffer.from('corrupt') })),
    ]) {
      await expect(service.restoreBackupSnapshot(8, { state: saved.state, assets })).rejects.toThrow();
      await expect(fs.stat(path.join(directory, 'state/theme-packs/8'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const altered = structuredClone(saved.state);
    const installed = altered.installed[0];
    if (!installed) throw new Error('Missing seeded theme installation');
    installed.manifest.name = 'Changed manifest';
    await expect(service.restoreBackupSnapshot(8, { state: altered, assets: saved.assets })).rejects.toThrow();
    expect((await service.snapshot(8)).state.installed).toEqual([]);
  });

  it('rejects asset corruption and unsafe versions without replacing the installed selection', async () => {
    await seedLegacyInstallation(7);
    await service.select(7, { id: pack.id, version: pack.version });
    const before = (await service.snapshot(7)).state;
    expect(() => service.install(7, '../alpine', pack.version)).toThrow();
    expect(() => service.install(7, pack.id, '../../outside')).toThrow();
    expect(() => service.install(7, pack.id, '99.0.0')).toThrow();
    const file = path.join(directory, 'state/theme-packs/7/alpine/1.0.0', pack.wallpaper);
    await fs.writeFile(file, Buffer.alloc(pack.assets[0]?.bytes ?? 0));
    await expect(service.asset(7, pack.id, pack.version, pack.wallpaper)).rejects.toThrow('integrity');
    await expect(service.select(7, { id: pack.id, version: pack.version })).rejects.toThrow('integrity');
    expect((await service.snapshot(7)).state).toEqual(before);
  });

  it('keeps the active version when a staged update fails verification', async () => {
    await seedLegacyInstallation(7);
    await service.select(7, { id: pack.id, version: pack.version });
    const before = (await service.snapshot(7)).state;
    const target = path.join(directory, 'state/theme-packs/7/alpine/1.1.0');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.writeFile(path.join(target, pack.wallpaper), Buffer.alloc(pack.assets[0]?.bytes ?? 0), { mode: 0o600 });
    await expect(service.install(7, pack.id, undefined, true)).rejects.toThrow('integrity');
    expect((await new ThemePacksService(config).snapshot(7)).state).toEqual(before);
    expect((await service.asset(7, pack.id, pack.version, pack.wallpaper)).hash).toBe(pack.wallpaper);
    expect((await fs.readdir(path.dirname(target))).some((entry) => entry.startsWith('.install-'))).toBe(false);
  });

  it('refuses symlink and public registry storage without reading another account or target', async () => {
    await seedLegacyInstallation(7);
    const registry = path.join(directory, 'state/theme-packs/7/registry.json');
    await fs.chmod(registry, 0o644);
    await expect(service.snapshot(7)).rejects.toThrow('permissions');
    await fs.chmod(registry, 0o600);
    await fs.rename(registry, `${registry}.original`);
    await fs.symlink(`${registry}.original`, registry);
    await expect(service.snapshot(7)).rejects.toThrow('validated');
    const account = path.join(directory, 'state/theme-packs/8');
    await fs.symlink(path.join(directory, 'state/theme-packs/7'), account);
    await expect(service.snapshot(8)).rejects.toThrow('permissions');
  });

  it('serializes account mutations and does not remove another account installation', async () => {
    await seedLegacyInstallation(7, 'alpine', '1.0.0');
    await seedLegacyInstallation(7, 'tideline', '1.0.0');
    await seedLegacyInstallation(8, 'alpine', '1.0.0');
    await Promise.all([
      service.install(7, 'alpine', undefined, true),
      service.install(7, 'tideline', undefined, true),
      service.install(8, 'alpine', undefined, true),
    ]);
    expect((await service.snapshot(7)).state.installed).toHaveLength(2);
    await service.remove(7, 'alpine');
    expect((await service.snapshot(8)).state.installed).toHaveLength(1);
    expect((await service.snapshot(7)).state.installed.map((item) => item.manifest.id)).toEqual(['tideline']);
  });

  it('fresh accounts expose no packs and direct legacy install/update calls create no files', async () => {
    expect(discoverableThemePacks).toEqual([]);
    const controller = new ThemePacksController(service);
    const request = { user: { id: 7 } } as unknown as Request;
    expect(await controller.snapshot(request)).toEqual({ catalogue: [], state: { formatVersion: 1, installed: [], selected: null } });
    for (const manifest of legacyThemePacks) {
      await expect(controller.install(request, { id: manifest.id, version: manifest.version })).rejects.toThrow('not available for installation');
      await expect(controller.install(request, { id: manifest.id })).rejects.toThrow('not available for installation');
      await expect(controller.update(request, manifest.id)).rejects.toThrow('Install this theme first');
    }
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('legacy discovery is limited to verified installed identities and other accounts remain fresh', async () => {
    await seedLegacyInstallation(7);
    expect((await service.snapshot(7)).catalogue.map((item) => `${item.id}@${item.version}`)).toEqual(['alpine@1.0.0', 'alpine@1.1.0']);
    expect((await service.snapshot(8)).catalogue).toEqual([]);
    await expect(service.install(7, 'tideline')).rejects.toThrow('not available for installation');
    await expect(service.install(8, 'alpine')).rejects.toThrow('not available for installation');
    expect((await service.snapshot(7)).state.installed).toHaveLength(1);
  });

  it('removal revokes legacy install eligibility even with a stale earlier catalogue', async () => {
    await seedLegacyInstallation(7);
    const stale = await service.snapshot(7);
    await service.remove(7, 'alpine');
    expect((await service.snapshot(7)).catalogue).toEqual([]);
    const registry = path.join(directory, 'state/theme-packs/7/registry.json');
    const removed = await fs.readFile(registry, 'utf8');
    for (const manifest of stale.catalogue)
      await expect(service.install(7, manifest.id, manifest.version)).rejects.toThrow('not available for installation');
    expect(await fs.readFile(registry, 'utf8')).toBe(removed);
    await expect(fs.stat(path.join(directory, 'state/theme-packs/7/alpine'))).rejects.toThrow();
  });

  it('unverified registry records and orphaned asset directories cannot grant legacy eligibility', async () => {
    await seedLegacyInstallation(7);
    const registry = path.join(directory, 'state/theme-packs/7/registry.json');
    const state = JSON.parse(await fs.readFile(registry, 'utf8'));
    state.installed[0].digest = '0'.repeat(64);
    await fs.writeFile(registry, JSON.stringify(state));
    await expect(service.install(7, 'alpine')).rejects.toThrow('integrity');
    await fs.rm(registry);
    await expect(service.install(7, 'alpine')).rejects.toThrow('not available for installation');
    expect((await service.snapshot(7)).catalogue).toEqual([]);
  });

  it('serializes removal before a stale install so the account cannot regain a removed legacy pack', async () => {
    await seedLegacyInstallation(7);
    const results = await Promise.allSettled([service.remove(7, 'alpine'), service.install(7, 'alpine', '1.1.0')]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('rejected');
    expect(await service.snapshot(7)).toEqual({ catalogue: [], state: { formatVersion: 1, installed: [], selected: null } });
    await expect(fs.stat(path.join(directory, 'state/theme-packs/7/alpine'))).rejects.toThrow();
  });

  it('checks account before controller lifecycle or asset calls', async () => {
    const controller = new ThemePacksController(service);
    const request = {} as Request;
    expect(() => controller.snapshot(request)).toThrow(UnauthorizedException);
    expect(() => controller.install(request, { id: 'alpine' })).toThrow(UnauthorizedException);
    expect(() => controller.select(request, { selected: null })).toThrow(UnauthorizedException);
    expect(() => controller.remove(request, 'alpine')).toThrow(UnauthorizedException);
    await expect(controller.asset(request, {} as never, 'alpine', '1.0.0', pack.wallpaper)).rejects.toThrow(UnauthorizedException);
  });
});

describe('declarative theme manifest boundaries', () => {
  const pack = bundledThemePacks[0];
  if (!pack) throw new Error('Catalogue empty');
  it('validates all bundled versions and rejects executable, remote and unknown input', () => {
    expect(bundledThemePacks.every((item) => themePackManifestSchema.allows(item))).toBe(true);
    for (const invalid of [
      { ...pack, css: 'body { display:none }' },
      { ...pack, script: 'alert(1)' },
      { ...pack, formatVersion: 2 },
      { ...pack, treatment: { ...pack.treatment, corners: '999px' } },
      { ...pack, light: { ...pack.light, accent: 'url(https://tracker.invalid/)' } },
      { ...pack, assets: [{ ...pack.assets[0], path: '../wallpaper.webp' }] },
      { ...pack, assets: [{ ...pack.assets[0], path: 'https://tracker.invalid/wallpaper.webp' }] },
      { ...pack, assets: [{ ...pack.assets[0], bytes: 4_194_305 }] },
      { ...pack, assets: [{ ...pack.assets[0], width: 4096, height: 4096 }] },
      { ...pack, assets: [pack.assets[0], pack.assets[0]] },
      { ...pack, wallpaper: '0'.repeat(64) },
      { ...pack, source: 'https://user:secret@example.invalid/' },
    ])
      expect(themePackManifestSchema.allows(invalid)).toBe(false);
  });
});
