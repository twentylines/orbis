import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { themePackManifestSchema } from '@runtipi/common/schemas/theme-pack';
import { bundledThemePacks } from './theme-pack-catalogue';
import { ThemePacksService, validateThemeAsset } from './theme-packs.service';
import { ThemePacksController } from './theme-packs.controller';

describe('account theme pack lifecycle with real files', () => {
  let directory: string;
  let service: ThemePacksService;
  let config: ConfigurationService;
  const pack = bundledThemePacks.find((item) => item.id === 'alpine' && item.version === '1.0.0');
  if (!pack) throw new Error('Test catalogue version missing');
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'theme-packs-'));
    config = { get: () => ({ dataDir: directory }) } as unknown as ConfigurationService;
    service = new ThemePacksService(config);
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('installs without applying, persists provenance and serves only this account original hash bytes', async () => {
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
    await service.install(7, pack.id, '1.0.0');
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

  it('rejects asset corruption and unsafe versions without replacing the installed selection', async () => {
    await service.install(7, pack.id, pack.version);
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
    await service.install(7, pack.id, pack.version);
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
    await service.install(7, pack.id, pack.version);
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
    await Promise.all([service.install(7, 'alpine'), service.install(7, 'tideline'), service.install(8, 'alpine')]);
    expect((await service.snapshot(7)).state.installed).toHaveLength(2);
    await service.remove(7, 'alpine');
    expect((await service.snapshot(8)).state.installed).toHaveLength(1);
    expect((await service.snapshot(7)).state.installed.map((item) => item.manifest.id)).toEqual(['tideline']);
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
