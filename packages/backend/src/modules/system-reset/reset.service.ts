import { credentialWriters } from '../sentinel-recovery/writer-gate';
import { coreCaptureRecoveryRequired } from '@/common/backup-maintenance';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { BadRequestException, ConflictException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
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
  setResetOperationActive,
} from '@/common/backup-maintenance';
import { notifyClientStatusChanged, notifyResetStarted, readOperationStatus } from '@/common/restoration-status';
import { defaultTimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import { TimeMachineService } from '../system-backups/time-machine.service';
import { SystemBackupsService } from '../system-backups/system-backups.service';
import { SettingsBackupsService } from '../system-backups/settings-backups.service';
import { ResetState, type ResetAccounts, type ResetJournal } from './reset-state';
import { resetSensitiveActionBinding } from './reset-contract';
import type { LegacyResetJournal } from './reset-contract';
import { CredentialSynchronization } from '../sentinel-recovery/credential-synchronization.service';
import type { OwnershipWriteLease } from '../sentinel-recovery/ownership-authority';

const invalid = () => new BadRequestException('Confirm resetting Orbis and choose whether to keep accounts.');
export function resetChoice(value: unknown): ResetAccounts {
  if (value !== 'keep' && value !== 'remove') throw invalid();
  return value;
}
export function resetBinding(accounts: ResetAccounts) {
  return resetSensitiveActionBinding(resetChoice(accounts));
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
    private readonly bundles: SettingsBackupsService,
    @Optional() store?: ResetState,
    @Optional() private readonly ownership?: CredentialSynchronization,
  ) {
    this.store = store ?? new ResetState(config.get('directories').dataDir);
  }
  async onModuleInit() {
    if (coreCaptureRecoveryRequired()) return;
    try {
      const journal = await this.store.active();
      if (journal?.version === 2) {
        setResetRecoveryRequired(true);
        return;
      }
      if (journal?.phase === 'complete') await this.completeBackupOwnership(journal);
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
    const stored = await this.store.read();
    if (stored?.version === 2) throw new ConflictException('This reset archive needs local recovery review.');
    const pending = recovery ? stored : null;
    const eligible = (state: string) =>
      recovery ? state === 'resetting' && pending?.phase !== 'complete' && pending?.accounts === accounts : state === 'idle';
    if (this.busy || (recovery ? backupMaintenanceOutsideResetActive() : backupMaintenanceActive()) || !eligible((await readOperationStatus()).state))
      throw new ConflictException('Wait for the current system operation to finish, or recover its original reset choice.');
    this.busy = true;
    let release: (() => void) | undefined;
    let lease: (() => Promise<void>) | undefined;
    let ownership: OwnershipWriteLease | undefined;
    const journalId = pending?.id ?? randomUUID();
    try {
      if (accounts === 'remove') {
        // Root's durable hold spans reconciliation outside this process gate;
        // reconciliation owns a separate backup-mutation scope and can wait
        // for earlier custody work that itself needs credentialWriters.
        await credentialWriters.run(async () => {
          if (!sameActor(before, await this.auth.operatorActionContext(request)))
            throw new ConflictException('Your sign-in changed. Confirm this reset again.');
          if (!this.ownership) throw new ServiceUnavailableException('Account ownership could not be verified. Check recovery before trying again.');
          ownership = await this.ownership.beginOwnership('account-removal', {
            requestId: createHash('sha256').update(`orbis-main-account-removal-v1:${journalId}`).digest('hex'),
            replay: Boolean(pending),
          });
          // Reconciliation can itself mutate ownership. Root's hold must precede
          // it, not just the later SQL deletion. A retry retains earlier writes.
          if (pending) await ownership.verifyCurrent();
          else await ownership.beforeWrite();
        });
        await this.bundles.reconcileResetOwnership(before.userId, request);
        await this.machine.reconcileResetOwnership(before.userId, request);
      }
      release = await acquireBackupMaintenance(AbortSignal.timeout(30_000));
      if (!eligible((await readOperationStatus()).state) || !sameActor(before, await this.auth.operatorActionContext(request)))
        throw new ConflictException('Server state changed. Confirm this reset again.');
      if (ownership) await ownership.verifyCurrent();
      lease = await this.store.acquireLease();
      const users = (await this.db.select({ id: user.id }).from(user)).map((account) => account.id);
      if (!users.includes(before.userId)) throw new ConflictException('Your account changed. Confirm this reset again.');
      const journal: LegacyResetJournal = pending
        ? { ...pending, controller: os.hostname(), phase: 'prepared' }
        : { version: 1, id: journalId, controller: os.hostname(), accounts, users, phase: 'prepared', createdAt: Date.now() };
      if (pending && users.some((id) => !pending.users.includes(id)))
        throw new ConflictException('Accounts changed since this reset. Local recovery review is required.');
      await this.store.preflight(journal);
      await this.keys.snapshot();
      await this.cluster.read();
      await this.machine.preferences();
      await this.backups.settings();
      if (journal.accounts === 'remove') {
        await this.bundles.prepareResetOwnership(journal);
        await this.machine.prepareResetOwnership(journal, users);
      }
      await this.store.save(journal);
      const unlock = release;
      const unlockLease = lease;
      release = undefined;
      lease = undefined;
      setResetOperationActive(true);
      notifyResetStarted();
      let started = false;
      return {
        job: { id: journal.id, state: 'resetting' as const },
        start: () => {
          if (started) return;
          started = true;
          void this.run(journal, ownership).finally(async () => {
            try {
              await unlockLease();
            } catch {
              setResetRecoveryRequired(true);
            }
            this.busy = false;
            unlock();
            setResetOperationActive(false);
            notifyClientStatusChanged();
          });
        },
      };
    } catch (error) {
      if (ownership) {
        if (ownership.outcome.writes === 'not-started') await ownership.cancelUnwritten().catch(() => false);
        else setResetRecoveryRequired(true);
      }
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
    if (journal?.version === 2) {
      setResetRecoveryRequired(true);
      return;
    }
    if (!journal || journal.phase === 'complete') {
      try {
        if (journal) await this.completeBackupOwnership(journal);
        setResetRecoveryRequired(false);
      } catch {
        setResetRecoveryRequired(true);
      }
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
        const complete = { ...journal, phase: 'complete' as const };
        await this.store.save(complete);
        await this.completeBackupOwnership(complete);
        setResetRecoveryRequired(false);
      } catch {
        setResetRecoveryRequired(true);
      }
    } else {
      await this.store.save({ ...journal, phase: 'recovery' }).catch(() => undefined);
      setResetRecoveryRequired(true);
    }
  }
  private async completeBackupOwnership(journal: ResetJournal) {
    if (journal.version === 2) throw new Error('This reset archive needs recovery verification before ownership can change.');
    if (journal.accounts !== 'remove') return;
    let receipt: Promise<boolean> | undefined;
    const verifyReceipt = () => {
      receipt ??= this.db
        .select()
        .from(orbisResetReceipt)
        .where(eq(orbisResetReceipt.id, journal.id))
        .then((receipts) => receipts.some((row) => row.id === journal.id));
      return receipt;
    };
    await this.bundles.completeResetOwnership(journal, verifyReceipt);
    await this.machine.completeResetOwnership(journal, verifyReceipt);
  }
  private async run(journal: LegacyResetJournal, ownership?: OwnershipWriteLease) {
    return credentialWriters.run(async () => {
      try {
        if (journal.accounts === 'remove') {
          if (!ownership) throw new ServiceUnavailableException('Reset ownership requires recovery review.');
          await ownership.verifyCurrent();
        }
        // The durable intent is replayable; app rows, app-store rows and deployment configuration never enter this transaction.
        await this.automatic.resetOrbisPreferences();
        const { version: _version, revision: _revision, ...defaults } = defaultTimeMachinePreferences();
        await this.machine.updatePreferences({ ...defaults, expectedRevision: (await this.machine.preferences()).revision });
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
        const complete = { ...journal, phase: 'complete' as const };
        await this.store.save(complete);
        await this.completeBackupOwnership(complete);
        if (journal.accounts === 'remove') {
          if (!ownership) throw new ServiceUnavailableException('Reset ownership requires recovery review.');
          await ownership.finishCommitted();
        }
        setResetRecoveryRequired(false);
      } catch {
        // Keep the operation authoritative after a partial write. An ordinary reload cannot dismiss it.
        await this.store.save({ ...journal, phase: 'recovery' }).catch(() => undefined);
        setResetRecoveryRequired(true);
      }
    });
  }
}
