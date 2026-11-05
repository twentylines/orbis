import fs, { constants } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { settingsBackupRestoreSelectionSchema } from '@runtipi/common/schemas/settings-backup';
import { settingsBackupRestoreJobSchema } from '@runtipi/common/schemas/settings-backup-import';
import { settingsSchema } from '@/app.dto';
import { ConfigurationService, runtimeUserSettingsSchema } from '@/core/config/configuration.service';
import { acquireBackupDisk } from '@/common/backup-disk';
import { notifyClientStatusChanged } from '@/common/restoration-status';
import { acquireBackupMaintenance, backupMaintenanceActive, setSettingsRestoreRecoveryRequired } from '@/common/backup-maintenance';
import { AuthService } from '../auth/auth.service';
import { DesktopPreferencesService } from '../desktop-preferences/desktop-preferences.service';
import { ThemeSettingsService } from '../theme-settings/theme-settings.service';
import { importCapsule } from '../time-machine-capsules/capsule';
import { verifyCapsuleContents, verifiedCapsuleBinding, type VerifiedCapsuleContents } from '../time-machine-capsules/verify';
import { BackupDatabaseService } from './backup-database.service';
import { acquireRestoreLease } from './backup-restore-lease';
import { readSettingsAssetPart } from './settings-backup-assets';
import { SettingsBackupImportsService } from './settings-backup-imports.service';
import { mergeSettingsPreferences, type SettingsPreferenceSection } from './settings-backup-preferences';
import { SettingsBackupTransaction, type SettingsCaptureIntent } from './settings-backup-transaction';
import { TimeMachineStore } from './time-machine-store';
import { settingsRestoreRequiresRecovery } from './settings-restore-startup';

type Credentials = { password: string; totpCode?: string };
type Selected = Parameters<Parameters<SettingsBackupImportsService['withSelection']>[5]>[0];
const fail = () => new ConflictException('The settings restore could not finish. Review its status before trying again.');
const finished = (phase: string) => phase === 'complete' || phase === 'rolled-back';
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);

@Injectable()
export class SettingsBackupApplyService {
  private closing = false;
  private reserved: string | null = null;
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  constructor(
    private readonly config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly imports: SettingsBackupImportsService,
    private readonly desktop: DesktopPreferencesService,
    private readonly themes: ThemeSettingsService,
    private readonly database: BackupDatabaseService,
  ) {}
  private dataDir() {
    return this.config.get('directories').dataDir;
  }
  private store() {
    return path.join(this.dataDir(), 'backups', 'settings-restores');
  }
  private public(transaction: SettingsBackupTransaction) {
    const state = transaction.state;
    const terminal = finished(state.phase);
    const needsRecovery = !terminal && (state.phase === 'recovery' || (this.active?.id !== state.id && this.reserved !== state.id));
    return settingsBackupRestoreJobSchema.assert({
      id: state.id,
      status:
        state.phase === 'complete' ? 'succeeded' : state.phase === 'rolled-back' ? 'rolled-back' : needsRecovery ? 'recovery-required' : 'running',
      stage: state.phase,
      needsRecovery,
      canRollback: !terminal,
    });
  }
  async prepareStartup() {
    setSettingsRestoreRecoveryRequired(await settingsRestoreRequiresRecovery(this.dataDir()));
  }
  async status(ownerId: number) {
    const transaction = await SettingsBackupTransaction.active(this.dataDir());
    if (!transaction || transaction.state.ownerId !== ownerId) return { job: null };
    return { job: this.public(transaction) };
  }
  async accept(importId: string, ownerId: number, request: Request, credentials: Credentials, selection: unknown, passphrase: string) {
    const selected = settingsBackupRestoreSelectionSchema.assert(structuredClone(selection));
    if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 1024 || !passphrase.trim()) throw fail();
    const summary = await this.imports.confirmSelection(importId, ownerId, request, credentials, selected);
    if (this.closing || this.active || this.reserved || backupMaintenanceActive()) throw fail();
    const release = await acquireRestoreLease(this.store());
    try {
      if (this.closing || this.active || this.reserved || backupMaintenanceActive()) throw fail();
      const transaction = await SettingsBackupTransaction.reserve({
        dataDir: this.dataDir(),
        ownerId,
        importId,
        reviewId: summary.reviewId,
        archiveSha256: summary.archiveSha256,
      });
      this.reserved = transaction.state.id;
      return { job: this.public(transaction), start: () => this.start(transaction, request, credentials, selected, passphrase) };
    } finally {
      release();
    }
  }
  private start(transaction: SettingsBackupTransaction, request: Request, credentials: Credentials, selection: unknown, passphrase: string) {
    if (this.closing || this.active || this.reserved !== transaction.state.id) return;
    this.reserved = null;
    const active = { id: transaction.state.id, abort: new AbortController(), done: Promise.resolve() };
    this.active = active;
    active.done = this.run(transaction, request, credentials, selection, passphrase, active.abort.signal).finally(() => {
      if (this.active === active) this.active = undefined;
    });
  }
  private async restoreRuntime(transaction: SettingsBackupTransaction) {
    const bytes = await transaction.runtimeBefore();
    if (!bytes) return;
    try {
      await this.config.adoptRestoredUserSettingsRuntime(JSON.parse(bytes.toString('utf8')));
    } finally {
      bytes.fill(0);
    }
  }
  private async undo(transaction: SettingsBackupTransaction) {
    const library = new TimeMachineStore(this.dataDir());
    const signal = AbortSignal.timeout(15 * 60_000);
    await transaction.rollback(
      signal,
      async (intent) => {
        await library.removePortableImport(
          transaction.state.ownerId,
          transaction.state.id,
          {
            pointId: intent.pointId,
            createdAt: intent.createdAt,
            archiveSha256: intent.archiveSha256,
            metadataSha256: intent.metadataSha256,
          },
          signal,
        );
      },
      () => this.restoreRuntime(transaction),
    );
  }
  private async run(
    initial: SettingsBackupTransaction,
    request: Request,
    credentials: Credentials,
    selection: unknown,
    passphrase: string,
    abort: AbortSignal,
  ) {
    const signal = AbortSignal.any([abort, AbortSignal.timeout(60 * 60_000)]);
    let transaction = initial;
    let lease: (() => void) | undefined;
    let disk: (() => void) | undefined;
    let maintenance: (() => void) | undefined;
    let staging: string | undefined;
    let stagingSeal: Awaited<ReturnType<typeof fs.stat>> | undefined;
    const capsules: Awaited<ReturnType<typeof importCapsule>>[] = [];
    try {
      lease = await acquireRestoreLease(this.store());
      const current = await SettingsBackupTransaction.active(this.dataDir());
      if (!current || current.state.id !== initial.state.id || current.state.phase !== 'preparing') throw fail();
      await this.imports.withSelection(initial.state.importId, initial.state.ownerId, request, credentials, selection, async (value, recheck) => {
        signal.throwIfAborted();
        disk = acquireBackupDisk();
        staging = path.join(this.store(), `inputs-${randomUUID()}`);
        await fs.mkdir(staging, { mode: 0o700 });
        stagingSeal = await fs.lstat(staging);
        const prepared = await this.incoming(value, passphrase, staging, signal, capsules);
        maintenance = await acquireBackupMaintenance(signal);
        setSettingsRestoreRecoveryRequired(true);
        const files = await this.files(initial.state.ownerId, value, prepared.assets);
        const runtime = prepared.server ? runtimeUserSettingsSchema.assert(structuredClone(this.config.get('userSettings'))) : null;
        const runtimeAfter =
          runtime && prepared.server
            ? runtimeUserSettingsSchema.assert({
                ...runtime,
                ...prepared.server,
                experimental: {
                  ...runtime.experimental,
                  ...(prepared.server.experimental_insecureCookie === undefined
                    ? {}
                    : { insecureCookie: prepared.server.experimental_insecureCookie }),
                },
              })
            : null;
        const intents: SettingsCaptureIntent[] = [];
        const library = new TimeMachineStore(this.dataDir());
        for (const item of prepared.points) {
          let existed = false;
          try {
            const point = await library.load(item.binding.pointId);
            if (
              point.ownerId !== initial.state.ownerId ||
              point.archiveSha256 !== item.binding.archiveSha256 ||
              point.metadataSha256 !== item.binding.metadataSha256 ||
              point.createdAt !== item.binding.createdAt
            )
              throw fail();
            existed = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          intents.push({ ...item.binding, existed });
        }
        const before = runtime ? Buffer.from(JSON.stringify(runtime)) : undefined;
        try {
          transaction = await SettingsBackupTransaction.prepare({
            dataDir: this.dataDir(),
            reservedId: initial.state.id,
            ownerId: initial.state.ownerId,
            importId: initial.state.importId,
            reviewId: initial.state.reviewId,
            archiveSha256: initial.state.archiveSha256,
            files,
            captures: intents,
            runtimeBefore: before,
            signal,
          });
        } finally {
          before?.fill(0);
          for (const file of files) file.data?.fill(0);
        }
        await recheck();
        signal.throwIfAborted();
        await transaction.applyFiles(signal);
        for (const point of prepared.points) await library.importPortablePoint(initial.state.ownerId, point.token, signal, transaction.state.id);
        if (runtimeAfter) await this.config.adoptRestoredUserSettingsRuntime(runtimeAfter);
        await transaction.complete();
      });
      setSettingsRestoreRecoveryRequired(false);
    } catch {
      try {
        if (!lease) throw fail();
        const current = await SettingsBackupTransaction.active(this.dataDir());
        if (!current || current.state.id !== initial.state.id) throw fail();
        transaction = current;
        if (!finished(transaction.state.phase)) await this.undo(transaction);
        setSettingsRestoreRecoveryRequired(false);
      } catch {
        setSettingsRestoreRecoveryRequired(true);
      }
    } finally {
      for (const capsule of capsules) await capsule.dispose().catch(() => undefined);
      if (staging && stagingSeal) {
        const current = await fs.lstat(staging).catch(() => undefined);
        if (
          current?.isDirectory() &&
          !current.isSymbolicLink() &&
          current.dev === stagingSeal.dev &&
          current.ino === stagingSeal.ino &&
          current.uid === stagingSeal.uid &&
          current.mode === stagingSeal.mode
        ) {
          await fs.rmdir(staging).catch(() => undefined);
        }
      }
      maintenance?.();
      disk?.();
      lease?.();
      notifyClientStatusChanged();
    }
  }
  private async incoming(
    value: Selected,
    passphrase: string,
    staging: string,
    signal: AbortSignal,
    opened: Awaited<ReturnType<typeof importCapsule>>[],
  ) {
    const assets = new Map<SettingsPreferenceSection, Awaited<ReturnType<typeof readSettingsAssetPart>>>();
    const points: { token: VerifiedCapsuleContents; binding: Awaited<ReturnType<typeof verifiedCapsuleBinding>> }[] = [];
    let server: Record<string, unknown> | undefined;
    for (const item of value.parts) {
      if (item.part.kind === 'settings') server = item.payload?.server;
      else if (item.part.kind === 'wallpapers' || item.part.kind === 'themes') {
        assets.set(item.part.kind, await readSettingsAssetPart({ ...item.part, kind: item.part.kind, directory: staging, passphrase, signal }));
      } else if (item.part.kind === 'time-machine') {
        let token: VerifiedCapsuleContents | undefined;
        const imported = await importCapsule({
          source: item.part.file,
          stagingParent: staging,
          passphrase,
          expectedSha256: item.part.sha256,
          signal,
          verify: async (manifest, directory, signal) => {
            token = await verifyCapsuleContents({
              manifest,
              directory,
              signal,
              database: this.database,
              target: {
                orbisVersion: process.env.ORBIS_VERSION ?? 'development',
                runtipiVersion: this.config.get('version'),
                architecture: this.config.get('architecture'),
              },
            });
          },
        });
        opened.push(imported);
        if (!token) throw fail();
        const binding = await verifiedCapsuleBinding(token, signal);
        if (binding.pointId !== item.part.id) throw fail();
        points.push({ token, binding });
      }
    }
    return { assets, points, server };
  }
  private async files(ownerId: number, value: Selected, assets: Map<SettingsPreferenceSection, Awaited<ReturnType<typeof readSettingsAssetPart>>>) {
    const files: { relative: string; data: Buffer | null }[] = [];
    const patches: Partial<Record<SettingsPreferenceSection, unknown>> = {};
    for (const item of value.parts) {
      const kind = item.part.kind;
      if (kind === 'settings' || kind === 'dashboard') {
        if (!item.payload) throw fail();
        patches[kind] = item.payload.desktop;
        if (kind === 'settings') {
          const filename = path.join(this.dataDir(), 'state', 'settings.json');
          const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o022 || stat.size > 1048576) throw fail();
            const previous = settingsSchema
              .partial()
              .onDeepUndeclaredKey('reject')
              .assert(JSON.parse(await file.readFile('utf8')));
            const after = settingsSchema
              .partial()
              .onDeepUndeclaredKey('reject')
              .assert({ ...previous, ...item.payload.server });
            files.push({ relative: 'settings.json', data: encode(after) });
          } finally {
            await file.close();
          }
        }
      } else if (kind === 'wallpapers') {
        const payload = assets.get(kind);
        if (!payload) throw fail();
        patches[kind] = payload.desktop;
        files.push(
          { relative: `wallpapers/${ownerId}.image`, data: payload.assets[0]?.data ?? null },
          { relative: `wallpapers/${ownerId}.image.saved`, data: null },
        );
      } else if (kind === 'themes') {
        const payload = assets.get(kind);
        if (!payload?.state || !payload.themeSettings) throw fail();
        patches[kind] = payload.desktop;
        for (const manifest of payload.state.installed.flatMap((record) => [
          record.manifest,
          ...(record.previous ? [record.previous.manifest] : []),
        ])) {
          const image = payload.assets.find((asset) => asset.id === manifest.wallpaper);
          if (!image) throw fail();
          files.push({ relative: `theme-packs/${ownerId}/${manifest.id}/${manifest.version}/${manifest.wallpaper}`, data: image.data });
        }
        const current = await this.themes.backupSnapshot(ownerId);
        if (current.revision >= Number.MAX_SAFE_INTEGER) throw fail();
        files.push(
          { relative: `theme-packs/${ownerId}/registry.json`, data: encode(payload.state) },
          { relative: `theme-settings/${ownerId}.json`, data: encode({ ...payload.themeSettings, revision: current.revision + 1 }) },
        );
      }
    }
    if (Object.keys(patches).length) {
      files.push({
        relative: `desktop/${ownerId}.json`,
        data: encode(mergeSettingsPreferences(await this.desktop.backupSnapshot(ownerId), patches)),
      });
    }
    return files;
  }
  async rollback(id: string, ownerId: number, request: Request, credentials: Credentials) {
    const actor = await this.auth.operatorActionContext(request);
    if (actor.userId !== ownerId) throw fail();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const currentActor = await this.auth.operatorActionContext(request);
    if (
      actor.userId !== currentActor.userId ||
      actor.sessionBinding !== currentActor.sessionBinding ||
      actor.securityBinding !== currentActor.securityBinding
    )
      throw fail();
    this.reserved = this.reserved === id ? null : this.reserved;
    if (this.active?.id === id) {
      this.active.abort.abort();
      await this.active.done;
    }
    if (this.active || this.reserved) throw fail();
    const lease = await acquireRestoreLease(this.store());
    let disk: (() => void) | undefined;
    let maintenance: (() => void) | undefined;
    try {
      const transaction = await SettingsBackupTransaction.active(this.dataDir());
      if (!transaction || transaction.state.id !== id || transaction.state.ownerId !== ownerId) throw fail();
      if (!finished(transaction.state.phase)) {
        disk = acquireBackupDisk();
        maintenance = await acquireBackupMaintenance(AbortSignal.timeout(30_000));
        setSettingsRestoreRecoveryRequired(true);
        await this.undo(transaction);
        setSettingsRestoreRecoveryRequired(false);
      }
      return this.public(transaction);
    } finally {
      maintenance?.();
      disk?.();
      lease();
      notifyClientStatusChanged();
    }
  }
  async onModuleDestroy() {
    this.closing = true;
    this.reserved = null;
    this.active?.abort.abort();
    await this.active?.done;
  }
}
