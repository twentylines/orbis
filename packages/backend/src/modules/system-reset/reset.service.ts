import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import type { Request } from 'express';
import { eq, inArray, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '@/core/database/database.module';
import { link, orbisResetReceipt, user } from '@/core/database/drizzle/schema';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AuthService } from '../auth/auth.service';
import { PasskeyService } from '../auth/passkey.service';
import { PasskeyStore } from '../auth/passkey.store';
import { SessionManager } from '../auth/session.manager';
import { ClusterStateService } from '../cluster/cluster-state.service';
import { ClusterSyncStore } from '../cluster/cluster-sync.store';
import { AutomaticUpdatesService } from '../host-updates/automatic-updates.service';
import {
  acquireBackupMaintenance,
  backupMaintenanceActive,
  backupMaintenanceOutsideResetActive,
  setResetRecoveryRequired,
} from '@/common/backup-maintenance';
import { readOperationStatus } from '@/common/restoration-status';
import { defaultTimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import { TimeMachineService } from '../system-backups/time-machine.service';
import { SystemBackupsService } from '../system-backups/system-backups.service';
import { ResetState, type ResetAccounts, type ResetJournal } from './reset-state';

const invalid = () => new BadRequestException('Confirm resetting Orbis and choose whether to keep accounts.');
export function resetChoice(value: unknown): ResetAccounts {
  if (value !== 'keep' && value !== 'remove') throw invalid();
  return value;
}
export function resetBinding(accounts: ResetAccounts) {
  return createHash('sha256')
    .update(`orbis-reset-v1\n${resetChoice(accounts)}\napps-and-data-preserved`)
    .digest('hex');
}
const sameActor = (a: Awaited<ReturnType<AuthService['operatorActionContext']>>, b: Awaited<ReturnType<AuthService['operatorActionContext']>>) =>
  a.userId === b.userId && a.sessionBinding === b.sessionBinding && a.securityBinding === b.securityBinding;

@Injectable()
export class ResetService {
  private busy = false;
  private readonly store: ResetState;
  constructor(
    private readonly config: ConfigurationService,
    @Inject(DATABASE) private readonly db: Database,
    private readonly auth: AuthService,
    private readonly passkeys: PasskeyService,
    private readonly keys: PasskeyStore,
    private readonly sessions: SessionManager,
    private readonly cluster: ClusterStateService,
    private readonly sync: ClusterSyncStore,
    private readonly automatic: AutomaticUpdatesService,
    private readonly machine: TimeMachineService,
    private readonly backups: SystemBackupsService,
    @Optional() store?: ResetState,
  ) {
    this.store = store ?? new ResetState(config.get('directories').dataDir);
  }
  async onModuleInit() {
    try {
      const journal = await this.store.active();
      setResetRecoveryRequired(Boolean(journal && journal.phase !== 'complete'));
    } catch {
      setResetRecoveryRequired(true);
    }
  }

  async options(request: Request, body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'accounts') throw invalid();
    const accounts = resetChoice((body as Record<string, unknown>).accounts);
    return this.passkeys.sensitiveOptions(request, resetBinding(accounts));
  }
  async accept(request: Request, body: unknown, recovery = false) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
    const value = body as Record<string, unknown>;
    const accounts = resetChoice(value.accounts);
    const passwordMethod = value.method === 'password';
    const allowed = ['accounts', 'confirmation', 'method', 'totpCode', ...(passwordMethod ? ['password'] : ['challengeId', 'response'])];
    if (
      typeof value.confirmation !== 'string' ||
      !/^reset orbis$/i.test(value.confirmation.trim()) ||
      !['password', 'passkey'].includes(String(value.method)) ||
      Object.keys(value).some((key) => !allowed.includes(key))
    )
      throw invalid();
    if (value.totpCode !== undefined && (typeof value.totpCode !== 'string' || !/^\d{6}$/.test(value.totpCode))) throw invalid();
    const before = await this.auth.operatorActionContext(request);
    if (passwordMethod) {
      if (typeof value.password !== 'string' || !value.password || value.password.length > 1024) throw invalid();
      await this.auth.verifySensitiveAction(before.userId, value.password, value.totpCode as string | undefined);
    } else
      await this.passkeys.verifySensitive(request, resetBinding(accounts), {
        challengeId: value.challengeId,
        response: value.response,
        ...(value.totpCode ? { totpCode: value.totpCode } : {}),
      });
    if (!sameActor(before, await this.auth.operatorActionContext(request)))
      throw new ConflictException('Your sign-in changed. Confirm this reset again.');
    const pending = recovery ? await this.store.read() : null;
    const eligible = (state: string) =>
      recovery ? state === 'resetting' && pending?.phase !== 'complete' && pending?.accounts === accounts : state === 'idle';
    if (this.busy || (recovery ? backupMaintenanceOutsideResetActive() : backupMaintenanceActive()) || !eligible((await readOperationStatus()).state))
      throw new ConflictException('Wait for the current system operation to finish, or recover its original reset choice.');
    this.busy = true;
    let release: (() => void) | undefined;
    let lease: (() => Promise<void>) | undefined;
    try {
      release = await acquireBackupMaintenance(AbortSignal.timeout(30_000));
      if (!eligible((await readOperationStatus()).state) || !sameActor(before, await this.auth.operatorActionContext(request)))
        throw new ConflictException('Server state changed. Confirm this reset again.');
      lease = await this.store.acquireLease();
      const users = (await this.db.select({ id: user.id }).from(user)).map((account) => account.id);
      if (!users.includes(before.userId)) throw new ConflictException('Your account changed. Confirm this reset again.');
      const journal: ResetJournal = pending
        ? { ...pending, controller: os.hostname(), phase: 'prepared' }
        : { version: 1, id: randomUUID(), controller: os.hostname(), accounts, users, phase: 'prepared', createdAt: Date.now() };
      if (pending && users.some((id) => !pending.users.includes(id)))
        throw new ConflictException('Accounts changed since this reset. Local recovery review is required.');
      await this.store.preflight(journal);
      await this.keys.snapshot();
      await this.cluster.read();
      await this.machine.preferences();
      await this.backups.settings();
      await this.store.save(journal);
      const unlock = release;
      const unlockLease = lease;
      release = undefined;
      lease = undefined;
      let started = false;
      return {
        job: { id: journal.id, state: 'resetting' as const },
        start: () => {
          if (started) return;
          started = true;
          void this.run(journal).finally(async () => {
            try {
              await unlockLease();
            } catch {
              setResetRecoveryRequired(true);
            }
            this.busy = false;
            unlock();
          });
        },
      };
    } catch (error) {
      this.busy = false;
      throw error;
    } finally {
      try {
        await lease?.();
      } finally {
        release?.();
      }
    }
  }
  async resumePending() {
    let journal: ResetJournal | null;
    try {
      journal = await this.store.read();
    } catch {
      setResetRecoveryRequired(true);
      return;
    }
    if (!journal || journal.phase === 'complete') {
      setResetRecoveryRequired(false);
      return;
    }
    if ((await readOperationStatus()).state !== 'resetting') {
      setResetRecoveryRequired(true);
      return;
    }
    // Imported journals and interrupted intent never grant permission to mutate this controller.
    // A receipt is committed with the database change, so finishing its journal needs no further reset.
    const [receipt] = await this.db.select().from(orbisResetReceipt).where(eq(orbisResetReceipt.id, journal.id));
    if (receipt) {
      try {
        await this.store.save({ ...journal, phase: 'complete' });
        setResetRecoveryRequired(false);
      } catch {
        setResetRecoveryRequired(true);
      }
    } else {
      await this.store.save({ ...journal, phase: 'recovery' }).catch(() => undefined);
      setResetRecoveryRequired(true);
    }
  }
  private async run(journal: ResetJournal) {
    try {
      // The durable intent is replayable; app rows, app-store rows and deployment configuration never enter this transaction.
      await this.automatic.resetOrbisPreferences();
      const { version: _version, revision: _revision, ...defaults } = defaultTimeMachinePreferences();
      await this.machine.updatePreferences({ ...defaults, expectedRevision: (await this.machine.preferences()).revision });
      const retention = await this.backups.settings();
      await this.backups.updateSettings({ revision: retention.revision, retentionHours: 24 });
      await this.cluster.transaction(async (state) => {
        delete state.invite;
        await this.sync.transaction(state.id, (sync) => {
          sync.revision++;
          sync.receiving = { revision: sync.receiving.revision + 1, userId: null, categories: [], trustRevision: null };
          sync.plans = [];
          sync.receipts = {};
        });
      });
      await this.config.setUserSettings({
        advancedSettings: false,
        allowAutoThemes: true,
        allowErrorMonitoring: false,
        guestDashboard: false,
        themeBase: 'light',
        themeColor: 'blue',
      });
      await this.store.save({ ...journal, phase: 'preferences' });
      await this.store.erasePreferences(journal);
      if (journal.accounts === 'remove') {
        for (const id of journal.users) await this.sessions.destroyAllSessionsByUserId(id);
        await this.keys.change((state) => {
          for (const id of journal.users) delete state.users[id];
        });
      }
      await this.store.save({ ...journal, phase: 'accounts' });
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(7301001)`);
        await tx.delete(link).where(inArray(link.userId, journal.users));
        if (journal.accounts === 'remove') await tx.delete(user).where(inArray(user.id, journal.users));
        else await tx.update(user).set({ hasSeenWelcome: false, locale: 'en' }).where(inArray(user.id, journal.users));
        await tx
          .insert(orbisResetReceipt)
          .values({ id: journal.id, completedAt: Math.floor(Date.now() / 1000) })
          .onConflictDoNothing();
      });
      await this.store.save({ ...journal, phase: 'complete' });
      setResetRecoveryRequired(false);
    } catch {
      // Keep the operation authoritative after a partial write. An ordinary reload cannot dismiss it.
      await this.store.save({ ...journal, phase: 'recovery' }).catch(() => undefined);
      setResetRecoveryRequired(true);
    }
  }
}
