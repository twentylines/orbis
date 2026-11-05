import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { acquireBackupDisk } from '@/common/backup-disk';
import {
  acquireBackupMaintenance,
  backupMaintenanceActive,
  setBackupRecoveryRequired,
  setResetRecoveryRequired,
  setRestoreRecoveryRequired,
  setSettingsRestoreRecoveryRequired,
} from '@/common/backup-maintenance';
import { DEFAULT_DESKTOP_PREFERENCES, DesktopPreferencesService } from '../desktop-preferences/desktop-preferences.service';
import { DesktopWallpaperService } from '../desktop-preferences/desktop-wallpaper.service';
import { ThemePacksService } from '../theme-packs/theme-packs.service';
import { ThemeSettingsService } from '../theme-settings/theme-settings.service';
import { SettingsBackupSourceService } from '../system-backups/settings-backup-source.service';
import { SettingsBackupImportsService } from '../system-backups/settings-backup-imports.service';
import { SettingsBackupApplyService } from '../system-backups/settings-backup-apply.service';
import { SettingsBackupTransaction } from '../system-backups/settings-backup-transaction';
import { exportSettingsBundle } from '../system-backups/settings-backup-format';
import { writeSettingsJsonPart } from '../system-backups/settings-backup-json-parts';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from '../system-backups/darwin-files.fixture';
import { portablePointFixture } from './portable-point.fixture';

let root: string;
let restoreCreation: () => void;
let imports: SettingsBackupImportsService | undefined;
let apply: SettingsBackupApplyService | undefined;
const signal = () => new AbortController().signal;
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const request = {} as never;
const credentials = { password: 'fixture operator proof' };
const actor = { userId: 8, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
const auth = { operatorActionContext: async () => actor, verifySensitiveAction: async () => undefined };
const resetRecovery = () => {
  setBackupRecoveryRequired(false);
  setResetRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  setSettingsRestoreRecoveryRequired(false);
};
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'portable-settings-restore-')));
  await fs.chmod(root, 0o700);
  restoreCreation = stabilizeDarwinFixtureCreation(() => root);
  vi.stubEnv('ORBIS_VERSION', 'v1.0.0');
  resetRecovery();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await apply?.onModuleDestroy();
  await imports?.onModuleDestroy();
  apply = undefined;
  imports = undefined;
  resetRecovery();
  expect(backupMaintenanceActive()).toBe(false);
  vi.unstubAllEnvs();
  restoreCreation();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const portable = await portablePointFixture(root);
  const sourceMaster = await fs.readFile(path.join(portable.sourceRoot, 'backups/time-machine/keys/master-v1.key'));
  const sourceRecord = await fs.readFile(path.join(portable.sourceRoot, 'backups/time-machine/points', portable.point.id, 'point.json'));
  const config = Object.assign(Object.create(ConfigurationService.prototype), {
    config: { directories: { dataDir: portable.destinationRoot }, version: '4.10.1', architecture: 'arm64' },
  }) as ConfigurationService;
  const desktop = new DesktopPreferencesService(config);
  const wallpapers = new DesktopWallpaperService(config, desktop);
  const packs = new ThemePacksService(config);
  const themes = new ThemeSettingsService(config, packs, desktop);
  const database = { review: vi.fn().mockResolvedValue(undefined) };
  const source = new SettingsBackupSourceService(config, auth as never, desktop, wallpapers, packs, themes, {} as never, database as never);
  imports = new SettingsBackupImportsService(config, auth as never, source);
  apply = new SettingsBackupApplyService(config, auth as never, imports, desktop, themes, database as never);
  await desktop.write(8, {
    ...DEFAULT_DESKTOP_PREFERENCES,
    serverName: 'Keep current name',
    preset: 'ocean',
    mode: 'dark',
    appearance: { ...DEFAULT_DESKTOP_PREFERENCES.appearance, textScale: 125, accent: '#123456' },
  });
  const currentDesktop = await desktop.read(8);
  const capsuleBytes = await fs.readFile(portable.capsule);
  const dashboard = await writeSettingsJsonPart({
    kind: 'dashboard',
    value: {
      version: 1,
      desktop: {
        density: 'compact',
        workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, pinnedApps: ['jellyfin:fixture'] },
        appearance: { dockPins: ['jellyfin:fixture'], dockPlacement: 'left' },
      },
    },
    destination: path.join(root, 'dashboard.orbis'),
    passphrase: portable.passphrase,
    signal: signal(),
  });
  stabilizeExistingDarwinFixtures(dashboard.file);
  const saved = path.join(root, 'saved.orbis-settings');
  await exportSettingsBundle({
    directory: path.join(root, 'settings-package'),
    destination: saved,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    orbisVersion: portable.target.orbisVersion,
    passphrase: portable.passphrase,
    parts: [
      dashboard,
      { kind: 'time-machine', id: portable.point.id, file: portable.capsule, bytes: capsuleBytes.length, sha256: sha(capsuleBytes) },
    ],
    signal: signal(),
  });
  stabilizeExistingDarwinFixtures(saved);
  const bundle = await fs.readFile(saved);
  const job = await imports.create(8, request, credentials);
  await imports.upload(job.id, 8, Readable.from([bundle]), String(bundle.length), signal());
  const accepted = await imports.review(job.id, 8, request, credentials, portable.passphrase);
  await accepted.start;
  const reviewed = (await imports.list(8)).jobs.find((entry) => entry.id === job.id);
  expect(reviewed?.status).toBe('reviewed');
  if (!reviewed?.review) throw new Error('Expected an independently verified nested capsule');
  expect(reviewed.review.available).toEqual({
    version: 1,
    settings: false,
    dashboard: true,
    wallpapers: false,
    themes: false,
    timeMachine: [portable.point.id],
  });
  expect(reviewed.review.contents.find((part) => part.kind === 'time-machine')).toMatchObject({
    id: portable.point.id,
    pointId: portable.point.id,
    capturedAt: portable.point.createdAt,
    orbisVersion: portable.target.orbisVersion,
  });
  const selection = {
    version: 1,
    reviewId: reviewed.review.reviewId,
    archiveSha256: reviewed.review.archiveSha256,
    contents: reviewed.review.available,
  };
  const importedArchive = path.join(portable.destinationRoot, 'backups/settings-imports', job.id, 'backup.orbis');
  return {
    ...portable,
    desktop,
    currentDesktop,
    database,
    saved,
    bundle,
    capsuleBytes,
    selection,
    importId: job.id,
    importedArchive,
    sourceMaster,
    sourceRecord,
  };
}

async function terminal(id: string) {
  const service = apply;
  if (!service) throw new Error('Missing apply fixture');
  await vi.waitFor(
    async () => {
      expect(['succeeded', 'rolled-back', 'recovery-required']).toContain((await service.status(8)).job?.status);
    },
    { timeout: 30_000 },
  );
  const state = (await service.status(8)).job;
  expect(state?.id).toBe(id);
  return state;
}

async function assertSavedSources(test: Awaited<ReturnType<typeof fixture>>) {
  expect(await fs.readFile(test.saved)).toEqual(test.bundle);
  expect(await fs.readFile(test.importedArchive)).toEqual(test.bundle);
  expect(await fs.readFile(test.capsule)).toEqual(test.capsuleBytes);
  expect(await fs.readFile(path.join(test.sourceRoot, 'backups/time-machine/keys/master-v1.key'))).toEqual(test.sourceMaster);
  expect(await fs.readFile(path.join(test.sourceRoot, 'backups/time-machine/points', test.point.id, 'point.json'))).toEqual(test.sourceRecord);
  await test.source.verifyArchive(test.point, signal());
  const original = await test.source.metadata(test.point);
  if (!original.preview.available || !original.preview.wallpaperAsset.available) throw new Error('Missing original preview fixture');
  expect((await test.source.wallpaper(test.point, original.preview.wallpaperAsset)).data).toEqual(test.png);
}

it('restores a reviewed nested capsule and selected dashboard into the native library while preserving current unrelated preferences', async () => {
  const test = await fixture();
  if (!apply || !imports) throw new Error('Missing service fixture');
  const accepted = await apply.accept(test.importId, 8, request, credentials, test.selection, test.passphrase);
  accepted.start();
  expect((await terminal(accepted.job.id))?.status).toBe('succeeded');
  const point = await test.destination.load(test.point.id);
  expect(point.ownerId).toBe(8);
  expect(point.envelope.keyId).not.toBe(test.point.envelope.keyId);
  expect(await test.destination.metadata(point)).toEqual(await test.source.metadata(test.point));
  const metadata = await test.destination.metadata(point);
  if (!metadata.preview.available || !metadata.preview.wallpaperAsset.available) throw new Error('Missing native preview fixture');
  expect(metadata.preview.desktop.serverName).toBe('Saved desktop');
  expect((await test.destination.wallpaper(point, metadata.preview.wallpaperAsset)).data).toEqual(test.png);
  expect((await test.destination.verifyRuntime(point, signal())).capture.pointId).toBe(test.point.id);
  await test.destination.withArchive(point, signal(), async (stream, key) => {
    expect(key).toBe(test.key);
    for await (const _chunk of stream) {
      /* consume the actual verified archive */
    }
  });
  expect(await test.desktop.read(8)).toMatchObject({
    serverName: test.currentDesktop.serverName,
    preset: test.currentDesktop.preset,
    mode: test.currentDesktop.mode,
    density: 'compact',
    workspace: { pinnedApps: ['jellyfin:fixture'] },
    appearance: { textScale: 125, accent: '#123456', dockPins: ['jellyfin:fixture'], dockPlacement: 'left' },
  });
  expect((await SettingsBackupTransaction.active(test.destinationRoot))?.state.captures).toEqual([
    {
      pointId: test.point.id,
      createdAt: test.point.createdAt,
      archiveSha256: test.point.archiveSha256,
      metadataSha256: test.point.metadataSha256,
      existed: false,
    },
  ]);
  expect(test.database.review.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect((await imports.list(8)).jobs.find((entry) => entry.id === test.importId)?.status).toBe('consumed');
  await assertSavedSources(test);
  expect(backupMaintenanceActive()).toBe(false);
  await test.opened.dispose();
}, 40_000);

it.each([false, true])(
  'rolls back a failed durable commit with preexisting point=%s and preserves saved uploads',
  async (preexisting) => {
    const test = await fixture();
    if (!apply) throw new Error('Missing service fixture');
    const unrelated = await test.destination.create(8);
    const originalOperation = randomUUID();
    if (preexisting) {
      const disk = acquireBackupDisk();
      const maintenance = await acquireBackupMaintenance(signal());
      try {
        await test.destination.importPortablePoint(8, test.token, signal(), originalOperation);
      } finally {
        maintenance();
        disk();
      }
    }
    const before = await test.destination.list();
    const desktopBefore = await fs.readFile(path.join(test.destinationRoot, 'state/desktop/8.json'));
    let publishedMarker: { operationId: string } | undefined;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('/journal.json')) {
        const journal = JSON.parse(await fs.readFile(from, 'utf8'));
        if (journal.phase === 'complete') {
          expect((await test.destination.load(test.point.id)).ownerId).toBe(8);
          publishedMarker = JSON.parse(
            await fs.readFile(path.join(test.destinationRoot, 'backups/time-machine/points', test.point.id, 'portable-import.json'), 'utf8'),
          );
          throw new Error('fixture durable completion failure');
        }
      }
      return rename(from, to);
    });
    const accepted = await apply.accept(test.importId, 8, request, credentials, test.selection, test.passphrase);
    accepted.start();
    expect((await terminal(accepted.job.id))?.status).toBe('rolled-back');
    expect(publishedMarker?.operationId).toBe(preexisting ? originalOperation : accepted.job.id);
    expect((await SettingsBackupTransaction.active(test.destinationRoot))?.state.captures[0]?.existed).toBe(preexisting);
    expect(await test.destination.list()).toEqual(before);
    expect((await test.destination.load(unrelated.point.id)).status).toBe('capturing');
    expect(await fs.readFile(path.join(test.destinationRoot, 'state/desktop/8.json'))).toEqual(desktopBefore);
    if (preexisting) {
      const marker = JSON.parse(
        await fs.readFile(path.join(test.destinationRoot, 'backups/time-machine/points', test.point.id, 'portable-import.json'), 'utf8'),
      );
      expect(marker.operationId).toBe(originalOperation);
      expect(await test.destination.metadata(await test.destination.load(test.point.id))).toEqual(await test.source.metadata(test.point));
    } else await expect(test.destination.load(test.point.id)).rejects.toMatchObject({ code: 'ENOENT' });
    await assertSavedSources(test);
    expect(backupMaintenanceActive()).toBe(false);
    await test.opened.dispose();
  },
  40_000,
);
