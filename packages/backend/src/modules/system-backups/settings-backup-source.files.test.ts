import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { defaultSettingsBackupSelection } from '@runtipi/common/schemas/settings-backup';
import {
  backupMaintenanceActive,
  setBackupRecoveryRequired,
  setResetRecoveryRequired,
  setRestoreRecoveryRequired,
} from '@/common/backup-maintenance';
import { backupDiskActive } from '@/common/backup-disk';
import { DesktopPreferencesService, DEFAULT_DESKTOP_PREFERENCES } from '../desktop-preferences/desktop-preferences.service';
import { DesktopWallpaperService } from '../desktop-preferences/desktop-wallpaper.service';
import { ThemePacksService } from '../theme-packs/theme-packs.service';
import { ThemeSettingsService } from '../theme-settings/theme-settings.service';
import { SettingsBackupSourceService, type SettingsBackupSourceProgress } from './settings-backup-source.service';
import { openSettingsBackupReview } from './settings-backup-review';
import { readSettingsAssetPart } from './settings-backup-assets';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';

let root: string;
let restore: () => void;
let source: SettingsBackupSourceService;
let desktop: DesktopPreferencesService;
let wallpaper: DesktopWallpaperService;
let packs: ThemePacksService;
let themes: ThemeSettingsService;
const actor = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const machine = { withPortablePoint: vi.fn() };
const request = {} as Request;
const passphrase = 'portable fixture passphrase';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const configuration = vi.fn();
const options = () => ({
  ownerId: 7,
  request,
  credentials: { password: 'fixture account password' },
  selection: defaultSettingsBackupSelection(),
  passphrase,
  directory: root,
  destination: path.join(root, 'saved.orbis-settings'),
  signal: new AbortController().signal,
});
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'settings-source-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
  vi.resetAllMocks();
  setBackupRecoveryRequired(false);
  setResetRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  auth.operatorActionContext.mockResolvedValue(actor);
  auth.verifySensitiveAction.mockResolvedValue({ operator: true });
  configuration.mockImplementation((key) => {
    if (key === 'directories') return { dataDir: root };
    if (key === 'userSettings')
      return { guestDashboard: true, timeZone: 'UTC', themeBase: 'light', themeColor: 'blue', experimental: { insecureCookie: false } };
    if (key === 'version') return 'fixture-1';
    if (key === 'architecture') return 'amd64';
    throw new Error('Unexpected configuration key');
  });
  const config = { get: configuration } as never;
  desktop = new DesktopPreferencesService(config);
  wallpaper = new DesktopWallpaperService(config, desktop);
  packs = new ThemePacksService(config);
  themes = new ThemeSettingsService(config, packs, desktop);
  source = new SettingsBackupSourceService(config, auth as never, desktop, wallpaper, packs, themes, machine as never, {} as never);
});
afterEach(async () => {
  expect(backupDiskActive()).toBe(false);
  expect(backupMaintenanceActive()).toBe(false);
  restore();
  await fs.rm(root, { recursive: true, force: true });
});

it('exports real settings, Home pins, wallpaper and theme overrides without visiting or stopping Docker apps', async () => {
  const image = await wallpaper.upload(7, png);
  await desktop.write(7, {
    ...DEFAULT_DESKTOP_PREFERENCES,
    serverName: 'Saved private dashboard',
    workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, pinnedApps: ['jellyfin:fixture'] },
    wallpaperMode: 'custom',
    appearance: { ...DEFAULT_DESKTOP_PREFERENCES.appearance, wallpaperImage: image.hash, dockPins: ['jellyfin:fixture'] },
  });
  await themes.update(7, { expectedRevision: 0, theme: { id: 'orbis-builtin', version: '1.0.0' }, values: [{ key: 'accent', value: '#123456' }] });
  await fs.mkdir(path.join(root, 'app-data'), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'app-data', 'media'), 'media is not a settings backup');
  const progress: SettingsBackupSourceProgress[] = [];
  const result = await source.write({ ...options(), progress: (value) => progress.push(value) });
  expect(result.verifiedContents.map((part) => part.kind)).toEqual(['settings', 'dashboard', 'wallpapers', 'themes']);
  expect(machine.withPortablePoint).not.toHaveBeenCalled();
  expect(progress.at(-1)).toEqual({ stage: 'complete', completedBytes: result.bytes, totalBytes: result.bytes });
  const bytes = await fs.readFile(options().destination);
  expect(bytes.includes(Buffer.from('Saved private dashboard'))).toBe(false);
  expect(bytes.includes(Buffer.from('media is not a settings backup'))).toBe(false);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.sha256);
  expect((await fs.readdir(root)).some((name) => name.startsWith('.settings-source-'))).toBe(false);
  stabilizeExistingDarwinFixtures(root);
  const review = await openSettingsBackupReview({
    source: options().destination,
    directory: path.join(root, 'review'),
    passphrase,
    signal: options().signal,
    inspect: source.inspectors(passphrase, root),
  });
  try {
    await review.withSelection(
      { version: 1, reviewId: review.summary.reviewId, archiveSha256: result.sha256, contents: result.selection },
      async ({ parts }) => {
        expect(parts.find(({ part }) => part.kind === 'settings')?.payload?.server).toEqual({
          guestDashboard: true,
          timeZone: 'UTC',
          experimental_insecureCookie: false,
        });
        expect(parts.find(({ part }) => part.kind === 'dashboard')?.payload?.desktop.workspace?.pinnedApps).toEqual(['jellyfin:fixture']);
        for (const { part } of parts) {
          if (part.kind !== 'wallpapers' && part.kind !== 'themes') continue;
          const payload = await readSettingsAssetPart({ ...part, kind: part.kind, directory: root, passphrase, signal: options().signal });
          if (part.kind === 'wallpapers') expect(payload.assets[0]?.data.equals(png)).toBe(true);
          else expect(payload.themeSettings?.settings.entries[0]?.values).toEqual([{ key: 'accent', value: '#123456' }]);
        }
      },
    );
  } finally {
    await review.dispose();
  }
  expect(await fs.readFile(path.join(root, 'app-data', 'media'), 'utf8')).toBe('media is not a settings backup');
});

it('reads and exports only selected sections and does not inspect unselected asset storage', async () => {
  const unused = vi.spyOn(packs, 'backupSnapshot').mockRejectedValue(new Error('Unselected themes must not be read'));
  vi.spyOn(wallpaper, 'read').mockRejectedValue(new Error('Unselected wallpapers must not be read'));
  const result = await source.write({
    ...options(),
    selection: { version: 1, settings: false, dashboard: true, wallpapers: false, themes: false, timeMachine: [] },
  });
  expect(result.verifiedContents.map((part) => part.kind)).toEqual(['dashboard']);
  expect(unused).not.toHaveBeenCalled();
  expect(configuration.mock.calls.some(([key]) => key === 'userSettings')).toBe(false);
});

it('rejects credentials, session changes, empty selections and cancellation before creating an archive', async () => {
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Invalid credentials'));
  await expect(source.write(options())).rejects.toThrow();
  auth.operatorActionContext.mockResolvedValueOnce(actor).mockResolvedValueOnce({ ...actor, securityBinding: 'c'.repeat(64) });
  await expect(source.write(options())).rejects.toThrow();
  await expect(
    source.write({ ...options(), selection: { version: 1, settings: false, dashboard: false, wallpapers: false, themes: false, timeMachine: [] } }),
  ).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(source.write({ ...options(), signal: abort.signal })).rejects.toThrow();
  expect(await fs.readdir(root)).toEqual([]);
});

it('refuses malformed or future desktop state instead of silently backing up default preferences', async () => {
  await fs.mkdir(path.join(root, 'state', 'desktop'), { recursive: true, mode: 0o700 });
  const file = path.join(root, 'state', 'desktop', '7.json');
  for (const data of ['invalid json', JSON.stringify({ ...DEFAULT_DESKTOP_PREFERENCES, schemaVersion: 99 })]) {
    await fs.writeFile(file, data, { mode: 0o600 });
    await expect(source.write(options())).rejects.toThrow();
    await expect(fs.stat(options().destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(file, 'utf8')).toBe(data);
  }
});

it('does not overwrite a saved archive and releases its locks when a selected capture cannot be exported', async () => {
  await fs.writeFile(options().destination, 'saved recovery archive', { mode: 0o600 });
  await expect(source.write(options())).rejects.toThrow();
  expect(await fs.readFile(options().destination, 'utf8')).toBe('saved recovery archive');
  machine.withPortablePoint.mockRejectedValue(new Error('Capture cannot be verified'));
  await expect(
    source.write({
      ...options(),
      destination: path.join(root, 'second.orbis-settings'),
      selection: {
        version: 1,
        settings: false,
        dashboard: false,
        wallpapers: false,
        themes: false,
        timeMachine: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      },
    }),
  ).rejects.toThrow();
  expect(machine.withPortablePoint).toHaveBeenCalledOnce();
  expect((await fs.readdir(root)).sort()).toEqual(['saved.orbis-settings']);
});
