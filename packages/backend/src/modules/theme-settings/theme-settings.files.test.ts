import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import { DesktopPreferencesService } from '../desktop-preferences/desktop-preferences.service';
import { ThemePacksService } from '../theme-packs/theme-packs.service';
import { ThemeSettingsController } from './theme-settings.controller';
import { ThemeSettingsService } from './theme-settings.service';

let root: string;
let service: ThemeSettingsService;
let packs: ThemePacksService;
let desktop: DesktopPreferencesService;
let config: ConfigurationService;
const builtin = { id: 'orbis-builtin', version: '1.0.0' };
const alpine = { id: 'alpine', version: '1.1.0' };
const file = (id = 7) => path.join(root, 'state', 'theme-settings', `${id}.json`);
const update = (expectedRevision: number, key = 'accent', value: unknown = '#123456', theme = builtin) => ({
  expectedRevision,
  theme,
  values: [{ key, value }],
});
const read = () => fs.readFile(file(), 'utf8');

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-theme-settings-')));
  config = { get: () => ({ dataDir: root }) } as unknown as ConfigurationService;
  packs = new ThemePacksService(config);
  desktop = new DesktopPreferencesService(config);
  service = new ThemeSettingsService(config, packs, desktop);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('separate private per-user theme state', () => {
  it('reads empty state without creating directories or migrating legacy preferences', async () => {
    const snapshot = await service.snapshot(7);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.legacyMigration).toBe('pending');
    expect(snapshot.current.identity).toEqual(builtin);
    expect(snapshot.current.descriptor.kind).toBe('builtin');
    expect(await fs.readdir(root)).toEqual([]);
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(service.snapshot(id)).rejects.toThrow('account');
  });

  it('persists exact validated namespace values with private permissions and isolates accounts', async () => {
    const saved = await service.update(7, update(0));
    expect(saved.revision).toBe(1);
    expect(saved.settings.entries).toEqual([{ id: builtin.id, settingsVersion: 1, values: [{ key: 'accent', value: '#123456' }] }]);
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file()))).mode & 0o777).toBe(0o700);
    expect((await service.snapshot(8)).settings.entries).toEqual([]);
    expect((await new ThemeSettingsService(config, packs, desktop).snapshot(7)).revision).toBe(1);
    expect((await fs.readdir(path.dirname(file()))).sort()).toEqual(['7.json']);
  });

  it('rejects unknown, executable, out-of-range, cross-namespace and uninstalled version writes', async () => {
    for (const invalid of [
      { ...update(0), userId: 8 },
      { ...update(0), script: 'run()' },
      { ...update(0), expectedRevision: -1 },
      update(0, 'panel-blur', 41),
      update(0, 'palette', 'unknown'),
      update(0, 'low-effects', 'true'),
      update(0, 'unknown', null),
      update(0, 'accent', 'url(https://example.invalid)'),
      { ...update(0), theme: { ...builtin, url: 'https://example.invalid' } },
    ])
      await expect(service.update(7, invalid)).rejects.toThrow();
    await expect(service.update(7, update(0, 'accent', '#123456', alpine))).rejects.toThrow('Install');
    await packs.install(7, 'alpine', '1.0.0');
    await expect(service.update(7, update(0, 'accent', '#123456', alpine))).rejects.toThrow('Install');
    expect((await service.snapshot(7)).revision).toBe(0);
    await expect(fs.stat(file())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes same-account concurrent writes and refuses stale revisions without losing values', async () => {
    const outcomes = await Promise.allSettled([service.update(7, update(0)), service.update(7, update(0, 'accent', '#654321'))]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const before = await read();
    await expect(service.update(7, update(0, 'accent', '#999999'))).rejects.toThrow('changed');
    expect(await read()).toBe(before);
    const saved = await service.update(7, update(1, 'panel-blur', 10));
    expect(saved.revision).toBe(2);
    expect(saved.settings.entries[0]?.values).toEqual([{ key: 'panel-blur', value: 10 }]);
  });

  it('derives active selection from the installed-pack service and retains inactive namespaces after removal', async () => {
    await packs.install(7, alpine.id, alpine.version);
    await packs.select(7, alpine);
    const saved = await service.update(7, update(0, 'accent', '#654321', alpine));
    expect(saved.selected).toEqual(alpine);
    expect(saved.current.identity).toEqual(alpine);
    expect(saved.current.values.find((item) => item.key === 'accent')?.value).toBe('#654321');
    expect(saved.builtinFallback.identity).toEqual(builtin);
    await packs.remove(7, alpine.id);
    const removed = await service.snapshot(7);
    expect(removed.current.identity).toEqual(builtin);
    expect(removed.settings.entries.some((entry) => entry.id === alpine.id)).toBe(true);
    await expect(service.update(7, update(1, 'accent', '#111111', alpine))).rejects.toThrow('Install');
  });

  it('retains bounded unsupported namespaces inactive while rejecting invalid known values', async () => {
    await service.update(7, update(0));
    const document = JSON.parse(await read());
    document.settings.entries.push({ id: 'future-theme', settingsVersion: 2, values: [{ key: 'style', value: 'opaque' }] });
    await fs.writeFile(file(), JSON.stringify(document), { mode: 0o600 });
    const saved = await service.update(7, update(1, 'panel-blur', 12));
    expect(saved.settings.entries.find((entry) => entry.id === 'future-theme')).toEqual(document.settings.entries[1]);
    document.settings.entries[0].values = [{ key: 'panel-blur', value: 999 }];
    await fs.writeFile(file(), JSON.stringify(document), { mode: 0o600 });
    const before = await read();
    await expect(service.update(7, update(1))).rejects.toThrow('compatibility');
    expect(await read()).toBe(before);
  });

  it('refreshes the authoritative selection after a settings commit when another tab changes themes', async () => {
    await packs.install(7, alpine.id, alpine.version);
    await packs.select(7, alpine);
    const selected = await packs.snapshot(7);
    vi.spyOn(packs, 'snapshot')
      .mockResolvedValueOnce(selected)
      .mockResolvedValueOnce({ ...selected, state: { ...selected.state, selected: null } });
    const saved = await service.update(7, update(0, 'accent', '#123456', alpine));
    expect(saved.selected).toBeNull();
    expect(saved.current.identity).toEqual(builtin);
    expect(saved.settings.entries[0]?.id).toBe(alpine.id);
  });

  it('bounds inactive namespace growth without deleting existing state', async () => {
    await service.update(7, update(0));
    const document = JSON.parse(await read());
    document.settings.entries = Array.from({ length: 24 }, (_, index) => ({ id: `future-${index}`, settingsVersion: 1, values: [] }));
    await fs.writeFile(file(), JSON.stringify(document), { mode: 0o600 });
    const before = await read();
    await expect(service.update(7, update(1))).rejects.toThrow('namespace limit');
    expect(await read()).toBe(before);
  });

  it('rejects symlink, hardlink, public, oversized and unsupported-format files without replacement', async () => {
    await service.update(7, update(0));
    const original = await read();
    const outside = path.join(root, 'original.json');
    await fs.rename(file(), outside);
    await fs.symlink(outside, file());
    await expect(service.update(7, update(1))).rejects.toThrow('storage review');
    expect(await fs.readFile(outside, 'utf8')).toBe(original);
    await fs.unlink(file());
    await fs.link(outside, file());
    await expect(service.snapshot(7)).rejects.toThrow('storage review');
    await fs.unlink(file());
    await fs.copyFile(outside, file());
    await fs.chmod(file(), 0o644);
    await expect(service.snapshot(7)).rejects.toThrow('storage review');
    await fs.chmod(file(), 0o600);
    for (const contents of ['x'.repeat(131073), '{"formatVersion":2}', '{']) {
      await fs.writeFile(file(), contents);
      await expect(service.update(7, update(1))).rejects.toThrow('storage review');
      expect(await read()).toBe(contents);
    }
    expect((await fs.readdir(path.dirname(file()))).sort()).toEqual(['7.json']);
  });

  it('rejects unsafe settings directories rather than creating or replacing content through them', async () => {
    await fs.mkdir(path.join(root, 'state'), { mode: 0o700 });
    const target = path.join(root, 'outside');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, path.dirname(file()));
    await expect(service.update(7, update(0))).rejects.toThrow('storage review');
    expect(await fs.readdir(target)).toEqual([]);
  });
});

describe('explicit idempotent legacy migration', () => {
  it('refuses unsafe legacy preferences without creating new state or consuming migration', async () => {
    await fs.mkdir(path.join(root, 'state', 'desktop'), { recursive: true, mode: 0o700 });
    const legacy = path.join(root, 'state', 'desktop', '7.json');
    await fs.writeFile(legacy, '{"schemaVersion":99,"appearance":{"accent":"#123456"}}', { mode: 0o600 });
    await expect(service.migrate(7, { expectedRevision: 0 })).rejects.toThrow('safely read');
    await expect(fs.stat(file())).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await service.snapshot(7)).legacyMigration).toBe('pending');
  });

  it('snapshots only supported appearance values into builtin and selected pack without rewriting legacy state', async () => {
    await desktop.write(7, {
      serverName: 'Fixture',
      preset: 'ocean',
      density: 'comfortable',
      appearance: { accent: '#334455', glassBlur: 18, textScale: 150, dockPins: ['local:app'] },
    });
    await packs.install(7, alpine.id, alpine.version);
    await packs.select(7, alpine);
    const legacyFile = path.join(root, 'state', 'desktop', '7.json');
    const packFile = path.join(root, 'state', 'theme-packs', '7', 'registry.json');
    const originals = await Promise.all([fs.readFile(legacyFile, 'utf8'), fs.readFile(packFile, 'utf8')]);
    expect((await service.snapshot(7)).legacyMigration).toBe('pending');
    const migrated = await service.migrate(7, { expectedRevision: 0 });
    expect(migrated.revision).toBe(1);
    expect(migrated.legacyMigration).toBe('complete');
    expect(migrated.current.values.find((item) => item.key === 'accent')?.value).toBe('#334455');
    expect(migrated.builtinFallback.values.find((item) => item.key === 'palette')?.value).toBe('ocean');
    expect(migrated.settings.entries).toHaveLength(2);
    expect(JSON.stringify(migrated.settings)).not.toContain('dockPins');
    expect(JSON.stringify(migrated.settings)).not.toContain('textScale');
    expect(await Promise.all([fs.readFile(legacyFile, 'utf8'), fs.readFile(packFile, 'utf8')])).toEqual(originals);
    const before = await read();
    expect((await service.migrate(7, { expectedRevision: 0 })).revision).toBe(1);
    expect(await read()).toBe(before);
  });

  it('preserves prior per-theme changes and never copies another account values', async () => {
    await desktop.write(7, { serverName: 'Fixture', preset: 'frost', density: 'comfortable', appearance: { accent: '#112233', chromeBlur: 22 } });
    await service.update(7, update(0, 'accent', '#abcdef'));
    const migrated = await service.migrate(7, { expectedRevision: 1 });
    expect(migrated.current.values.find((item) => item.key === 'accent')?.value).toBe('#abcdef');
    expect(migrated.current.values.find((item) => item.key === 'chrome-blur')?.value).toBe(22);
    expect((await service.migrate(8, { expectedRevision: 0 })).current.values.find((item) => item.key === 'accent')?.value).toBeNull();
    await expect(service.migrate(9, { expectedRevision: 10 })).rejects.toThrow('changed');
    await expect(fs.stat(file(9))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('per-user browser-session endpoint admission', () => {
  it('uses AuthGuard with real origin checks and accepts ordinary users while denying CLI and unauthenticated requests', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ThemeSettingsController)).toContain(AuthGuard);
    const logger = { debug: vi.fn() } as unknown as LoggerService;
    const auth = new AuthGuard(logger);
    const controller = new ThemeSettingsController(service);
    const response = { setHeader: vi.fn() } as unknown as Response;
    const ordinary = {
      user: { id: 7, operator: false },
      authMethod: 'session',
      method: 'PUT',
      url: '/theme-settings',
      protocol: 'http',
      headers: { host: 'orbis.example', origin: 'http://orbis.example' },
    } as unknown as Request;
    const context = (req: Request) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;
    expect(await auth.canActivate(context(ordinary))).toBe(true);
    expect((await controller.update(ordinary, response, update(0))).revision).toBe(1);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    for (const origin of [undefined, 'http://other.example']) {
      await expect(auth.canActivate(context({ ...ordinary, headers: { ...ordinary.headers, origin } } as Request))).rejects.toThrow('request origin');
    }
    for (const authMethod of ['api-key', 'forward-auth', undefined]) {
      expect(() => controller.snapshot({ ...ordinary, authMethod } as Request, response)).toThrow('signed-in browser');
    }
    expect(() => controller.snapshot({ ...ordinary, user: undefined } as Request, response)).toThrow();
    await expect(auth.canActivate(context({ ...ordinary, user: undefined } as Request))).rejects.toThrow();
    expect((await controller.snapshot({ ...ordinary, user: { id: 8, operator: false } } as Request, response)).settings.entries).toEqual([]);
  });
});
