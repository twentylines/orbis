import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConflictException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { settingsBackupSelectionSchema } from '@runtipi/common/schemas/settings-backup';
import { timeMachineMetadataSchema } from '@runtipi/common/schemas/time-machine';
import { settingsSchema } from '@/app.dto';
import { ConfigurationService } from '@/core/config/configuration.service';
import { acquireBackupDisk } from '@/common/backup-disk';
import { acquireBackupMaintenance, enterBackupMutation } from '@/common/backup-maintenance';
import { AuthService } from '../auth/auth.service';
import { DesktopPreferencesService } from '../desktop-preferences/desktop-preferences.service';
import { DesktopWallpaperService } from '../desktop-preferences/desktop-wallpaper.service';
import { ThemePacksService } from '../theme-packs/theme-packs.service';
import { ThemeSettingsService } from '../theme-settings/theme-settings.service';
import { importCapsule } from '../time-machine-capsules/capsule';
import { exportPortablePoint } from '../time-machine-capsules/portable-point-export';
import { verifyCapsuleContents } from '../time-machine-capsules/verify';
import { BackupDatabaseService } from './backup-database.service';
import { backupMetadataBytes } from './backup-crypto';
import { writeSettingsAssetPart, readSettingsAssetPart } from './settings-backup-assets';
import { exportSettingsBundle } from './settings-backup-format';
import { writeSettingsJsonPart } from './settings-backup-json-parts';
import { splitSettingsPreferences } from './settings-backup-preferences';
import { openSettingsBackupReview, type SettingsBundlePart, type SettingsBundleInspection } from './settings-backup-review';
import { TimeMachineService } from './time-machine.service';

type Credentials = { password: string; totpCode?: string };
export type SettingsBackupSourceProgress = {
  stage: 'preparing' | 'encrypting' | 'captures' | 'packaging' | 'verifying' | 'complete';
  completedBytes: number;
  totalBytes: number | null;
};
const fail = () => new ConflictException('The backup could not be prepared or verified. Your settings and apps were kept.');
const privateDirectory = async (directory: string) => {
  const stat = await fs.lstat(directory);
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.() ||
    (await fs.realpath(directory)) !== directory
  )
    throw fail();
  return stat;
};
const removeOwnedDirectory = async (directory: string, owned: Awaited<ReturnType<typeof fs.stat>>) => {
  const current = await privateDirectory(directory);
  if (current.dev !== owned.dev || current.ino !== owned.ino) throw fail();
  await fs.rm(directory, { recursive: true });
};
const sameActor = (a: Awaited<ReturnType<AuthService['operatorActionContext']>>, b: Awaited<ReturnType<AuthService['operatorActionContext']>>) =>
  a.userId === b.userId && a.sessionBinding === b.sessionBinding && a.securityBinding === b.securityBinding;

/** Builds a portable export. The calling job service owns its durable job, destination and download authorization. */
@Injectable()
export class SettingsBackupSourceService {
  constructor(
    private readonly config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly desktop: DesktopPreferencesService,
    private readonly wallpaper: DesktopWallpaperService,
    private readonly packs: ThemePacksService,
    private readonly themeSettings: ThemeSettingsService,
    private readonly machine: TimeMachineService,
    private readonly database: BackupDatabaseService,
  ) {}

  inspectors(passphrase: string, directory: string) {
    const assets = async (part: SettingsBundlePart, signal: AbortSignal): Promise<SettingsBundleInspection> => {
      if (part.kind !== 'wallpapers' && part.kind !== 'themes') throw fail();
      const value = await readSettingsAssetPart({ ...part, kind: part.kind, passphrase, directory, signal });
      return { items: Object.keys(value.desktop).length + value.assets.length + (value.themeSettings?.settings.entries.length ?? 0) };
    };
    return {
      wallpapers: assets,
      themes: assets,
      'time-machine': async (part: SettingsBundlePart, signal: AbortSignal): Promise<SettingsBundleInspection> => {
        let metadata: ReturnType<typeof timeMachineMetadataSchema.assert> | undefined;
        const verified = await importCapsule({
          source: part.file,
          stagingParent: directory,
          passphrase,
          expectedSha256: part.sha256,
          signal,
          verify: async (manifest, content, signal) => {
            await verifyCapsuleContents({
              manifest,
              directory: content,
              signal,
              database: this.database,
              target: {
                orbisVersion: process.env.ORBIS_VERSION ?? 'development',
                runtipiVersion: this.config.get('version'),
                architecture: this.config.get('architecture'),
              },
            });
            const plain = await backupMetadataBytes(await fs.readFile(path.join(content, 'metadata.orbis')), manifest.pointKey, true);
            try {
              metadata = timeMachineMetadataSchema.assert(JSON.parse(plain.toString('utf8')).metadata);
            } finally {
              plain.fill(0);
            }
          },
        });
        try {
          if (!metadata || part.kind !== 'time-machine' || verified.pointId !== part.id) throw fail();
          return { items: 1, pointId: verified.pointId, capturedAt: metadata.createdAt, orbisVersion: metadata.software.orbis };
        } finally {
          await verified.dispose();
        }
      },
    };
  }

  async write(options: {
    ownerId: number;
    request: Request;
    credentials: Credentials;
    selection: unknown;
    passphrase: string;
    directory: string;
    destination: string;
    signal: AbortSignal;
    progress?: (value: SettingsBackupSourceProgress) => void;
  }) {
    const selection = settingsBackupSelectionSchema.assert(structuredClone(options.selection));
    if (typeof options.passphrase !== 'string' || options.passphrase.length < 8 || !options.passphrase.trim() || options.passphrase.length > 1024)
      throw fail();
    options.signal.throwIfAborted();
    const actor = await this.auth.operatorActionContext(options.request);
    if (actor.userId !== options.ownerId) throw fail();
    await this.auth.verifySensitiveAction(options.ownerId, options.credentials.password, options.credentials.totpCode);
    const recheck = async () => {
      options.signal.throwIfAborted();
      if (!sameActor(actor, await this.auth.operatorActionContext(options.request))) throw fail();
    };
    await recheck();
    await privateDirectory(options.directory);
    if (
      !path.isAbsolute(options.destination) ||
      path.resolve(options.destination) !== options.destination ||
      path.dirname(options.destination) !== options.directory
    )
      throw fail();
    await fs.lstat(options.destination).then(
      () => {
        throw fail();
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    const disk = acquireBackupDisk();
    const work = path.join(options.directory, `.settings-source-${randomUUID()}`);
    let owned: Awaited<ReturnType<typeof fs.stat>> | undefined;
    let release: (() => void) | null = null;
    const progress = (stage: SettingsBackupSourceProgress['stage'], completedBytes = 0, totalBytes: number | null = null) =>
      options.progress?.({ stage, completedBytes, totalBytes });
    try {
      await fs.mkdir(work, { mode: 0o700 });
      owned = await privateDirectory(work);
      progress('preparing');
      const parts: Parameters<typeof exportSettingsBundle>[0]['parts'] = [];
      if (selection.settings || selection.dashboard || selection.wallpapers || selection.themes) {
        release = await acquireBackupMaintenance(options.signal);
        await recheck();
        const preferences = splitSettingsPreferences(await this.desktop.backupSnapshot(options.ownerId));
        for (const kind of ['settings', 'dashboard'] as const) {
          if (!selection[kind]) continue;
          progress('encrypting');
          let server: Record<string, unknown> | undefined;
          if (kind === 'settings') {
            const settings = this.config.get('userSettings');
            server = Object.fromEntries(
              Object.entries({ ...settings, experimental_insecureCookie: settings.experimental?.insecureCookie }).filter(
                ([key, value]) => value !== undefined && key !== 'themeBase' && key !== 'themeColor' && settingsSchema.keyof().allows(key),
              ),
            );
          }
          parts.push(
            await writeSettingsJsonPart({
              kind,
              value: { version: 1, desktop: preferences[kind], ...(kind === 'settings' ? { server } : {}) },
              destination: path.join(work, `${kind}.orbis`),
              passphrase: options.passphrase,
              signal: options.signal,
            }),
          );
        }
        if (selection.wallpapers) {
          const selected = preferences.wallpapers.appearance?.wallpaperImage;
          const asset = selected ? await this.wallpaper.read(options.ownerId, selected) : null;
          parts.push(
            await writeSettingsAssetPart({
              kind: 'wallpapers',
              desktop: preferences.wallpapers,
              assets: asset ? [{ id: asset.hash, data: asset.data }] : [],
              destination: path.join(work, 'wallpapers.orbis'),
              passphrase: options.passphrase,
              signal: options.signal,
              progress: (done, total) => progress('encrypting', done, total),
            }),
          );
        }
        if (selection.themes) {
          const themes = await this.packs.backupSnapshot(options.ownerId);
          const themeSettings = await this.themeSettings.backupSnapshot(options.ownerId);
          parts.push(
            await writeSettingsAssetPart({
              kind: 'themes',
              desktop: preferences.themes,
              ...themes,
              themeSettings,
              destination: path.join(work, 'themes.orbis'),
              passphrase: options.passphrase,
              signal: options.signal,
              progress: (done, total) => progress('encrypting', done, total),
            }),
          );
        }
        release();
        release = null;
      }
      release = enterBackupMutation();
      if (!release) throw fail();
      await recheck();
      for (const pointId of selection.timeMachine) {
        const destination = path.join(work, `${pointId}.orbis-tm`);
        progress('captures');
        const point = await exportPortablePoint({
          machine: this.machine,
          dataDir: this.config.get('directories').dataDir,
          pointId,
          ownerId: options.ownerId,
          request: options.request,
          credentials: options.credentials,
          passphrase: options.passphrase,
          destination,
          signal: options.signal,
          progress: (done, total) => progress('captures', done, total),
        });
        parts.push({ kind: 'time-machine', id: pointId, file: destination, bytes: point.bytes, sha256: point.sha256 });
      }
      await recheck();
      progress('packaging');
      const result = await exportSettingsBundle({
        directory: path.join(work, 'package'),
        destination: options.destination,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        orbisVersion: process.env.ORBIS_VERSION ?? 'development',
        passphrase: options.passphrase,
        parts,
        signal: options.signal,
        progress: (done) =>
          progress(
            'packaging',
            done,
            parts.reduce((sum, part) => sum + part.bytes, 0),
          ),
      });
      progress('verifying');
      const review = await openSettingsBackupReview({
        source: options.destination,
        directory: path.join(work, 'review'),
        passphrase: options.passphrase,
        signal: options.signal,
        inspect: this.inspectors(options.passphrase, work),
      });
      try {
        await recheck();
        if (review.summary.archiveSha256 !== result.sha256) throw fail();
        progress('complete', result.bytes, result.bytes);
        return { ...result, verifiedContents: review.summary.contents, selection: structuredClone(selection) };
      } finally {
        await review.dispose();
      }
    } finally {
      release?.();
      try {
        if (owned) await removeOwnedDirectory(work, owned);
      } finally {
        disk();
      }
    }
  }
}
