import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import type { Database } from '@/core/database/database.module';
import { link, user } from '@/core/database/drizzle/schema';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { EncryptionService } from '@/core/encryption/encryption.service';
import { assertBackupMaintenanceLease, type BackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import type { PasskeyStore } from '../auth/passkey.store';
import type { ClusterStateService } from '../cluster/cluster-state.service';
import type { ClusterSyncStore } from '../cluster/cluster-sync.store';
import type { AutomaticUpdatesService } from '../host-updates/automatic-updates.service';
import type { TimeMachineService } from './time-machine.service';
import { resetSafetyStatePayload, type ResetSafetyState } from './reset-safety-state';
import { assertResetExportAccess, resetExportPlanSha256, type ResetExportPlan, type SettingsExportAccess } from './settings-export-authorization';
import type { ResetInventoryAccess } from './settings-export-authorization';
import type { ResetCaptureRecoveryManifest } from './reset-capture-recovery-manifest';

export type ResetSafetySourceOptions = {
  plan: ResetExportPlan;
  access: SettingsExportAccess;
  lease: BackupMaintenanceLease;
  signal: AbortSignal;
  database: Pick<Database, 'transaction'>;
  config: Pick<ConfigurationService, 'get'>;
  automatic: Pick<AutomaticUpdatesService, 'snapshotForReset'>;
  machine: Pick<TimeMachineService, 'withResetPreferencesSnapshot'> & Partial<Pick<TimeMachineService, 'withResetCapturePreferencesSnapshot'>>;
  captureRecovery?: { access: ResetInventoryAccess; manifest: ResetCaptureRecoveryManifest };
  cluster: Pick<ClusterStateService, 'read'>;
  sync: Pick<ClusterSyncStore, 'read'>;
  passkeys: Pick<PasskeyStore, 'snapshot' | 'withReadFence'>;
  encryption: Pick<EncryptionService, 'decrypt'>;
};
export class ResetSafetySourceError extends Error {
  constructor(readonly code: 'cohort' | 'drift' | 'limit' | 'credentials' | 'unreadable') {
    super('The reset safety backup source requires local review.');
  }
}
const fail = (code: ResetSafetySourceError['code']): never => {
  throw new ResetSafetySourceError(code);
};
const maximumBytes = 8 * 1024 * 1024;
const accountColumns = {
  id: user.id,
  username: user.username,
  operator: user.operator,
  locale: user.locale,
  hasSeenWelcome: user.hasSeenWelcome,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
};
const linkColumns = {
  id: link.id,
  userId: link.userId,
  title: link.title,
  url: link.url,
  iconUrl: link.iconUrl,
  description: link.description,
  isVisibleOnGuestDashboard: link.isVisibleOnGuestDashboard,
  createdAt: link.createdAt,
  updatedAt: link.updatedAt,
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function budget(value: { count: string; bytes: string }[] | undefined, countLimit: number) {
  const item = value?.[0];
  if (value?.length !== 1 || !item || !/^\d{1,30}$/.test(item.count) || !/^\d{1,30}$/.test(item.bytes)) return fail('unreadable');
  const count = BigInt(item.count);
  const bytes = BigInt(item.bytes);
  if (count > BigInt(countLimit) || bytes > BigInt(maximumBytes)) fail('limit');
  return { count: Number(count), bytes: Number(bytes) };
}

/** Collects bounded logical state under a temporary read fence. This neither restores data nor authorizes erasure. */
export async function collectResetSafetyState(options: ResetSafetySourceOptions): Promise<ResetSafetyState> {
  return readResetSafetyState(options, async (value) => value, false);
}

/** Keeps the capture/preferences fence open through preparation; a result is released only after the source recheck. */
export async function withResetSafetyState<T>(options: ResetSafetySourceOptions, work: (state: ResetSafetyState) => Promise<T>): Promise<T> {
  return readResetSafetyState(options, work, true);
}

async function readResetSafetyState<T>(
  options: ResetSafetySourceOptions,
  work: (state: ResetSafetyState) => Promise<T>,
  recheckAfter: boolean,
): Promise<T> {
  const plan = structuredClone(options.plan);
  const selectionSha256 = resetExportPlanSha256(plan);
  const users = [...plan.users].sort((a, b) => a - b);
  const context = { plan, access: options.access, lease: options.lease, signal: options.signal };
  const guard = async () => {
    options.signal.throwIfAborted();
    assertBackupMaintenanceLease(options.lease);
    await assertResetExportAccess(options.access, plan);
    options.signal.throwIfAborted();
    assertBackupMaintenanceLease(options.lease);
  };
  await guard();
  const readDatabase = () =>
    options.database.transaction(
      async (tx) => {
        await guard();
        const credentialBytes =
          plan.accounts === 'remove'
            ? sql`octet_length(${user.password}) + coalesce(octet_length(${user.totpSecret}),0) + coalesce(octet_length(${user.salt}),0)`
            : sql`0`;
        const accountsBudget = budget(
          await tx
            .select({
              count: sql<string>`count(*)::text`,
              bytes: sql<string>`coalesce(sum(256 + octet_length(${user.username}) + octet_length(${user.locale}) + ${credentialBytes}),0)::text`,
            })
            .from(user),
          256,
        );
        await guard();
        const linksBudget = budget(
          await tx
            .select({
              count: sql<string>`count(*)::text`,
              bytes: sql<string>`coalesce(sum(256 + octet_length(${link.title}) + octet_length(${link.url}) + coalesce(octet_length(${link.iconUrl}),0) + coalesce(octet_length(${link.description}),0)),0)::text`,
            })
            .from(link),
          100_000,
        );
        if (accountsBudget.bytes + linksBudget.bytes > maximumBytes) fail('limit');
        await guard();
        const accounts =
          plan.accounts === 'remove'
            ? await tx
                .select({ ...accountColumns, password: user.password, totpEnabled: user.totpEnabled, totpSecret: user.totpSecret, salt: user.salt })
                .from(user)
                .orderBy(user.id)
                .limit(257)
            : await tx.select(accountColumns).from(user).orderBy(user.id).limit(257);
        if (accounts.length !== accountsBudget.count || JSON.stringify(accounts.map((value) => value.id)) !== JSON.stringify(users)) fail('cohort');
        await guard();
        const links = await tx.select(linkColumns).from(link).orderBy(link.id).limit(100_001);
        if (links.length !== linksBudget.count || links.some((value) => !users.includes(value.userId))) fail('cohort');
        await guard();
        return { accounts, links };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  const runtime = async () => {
    await guard();
    const settings = options.config.get('userSettings');
    const server = {
      advancedSettings: settings.advancedSettings,
      allowAutoThemes: settings.allowAutoThemes,
      allowErrorMonitoring: settings.allowErrorMonitoring,
      guestDashboard: settings.guestDashboard,
      themeBase: settings.themeBase ?? null,
      themeColor: settings.themeColor ?? null,
    };
    const automatic = await options.automatic.snapshotForReset(context);
    await guard();
    const cluster = await options.cluster.read();
    await guard();
    const sync = await options.sync.read(cluster.id);
    await guard();
    const keys = plan.accounts === 'remove' ? await options.passkeys.snapshot() : null;
    const passkeys = keys
      ? { version: keys.version, users: Object.fromEntries(Object.entries(keys.users).filter(([id]) => users.includes(Number(id)))) }
      : null;
    await guard();
    return {
      server,
      automatic,
      cluster: { hostId: cluster.id, invite: cluster.invite ? structuredClone(cluster.invite) : null, sync: JSON.stringify(sync) },
      clusterIdentity: fingerprint(cluster),
      passkeys,
    };
  };
  const collect = async (timeMachine: TimeMachinePreferences) => {
    await guard();
    const before = await runtime();
    const database = await readDatabase();
    const after = await runtime();
    if (fingerprint(before) !== fingerprint(after)) fail('drift');
    const verifiedDatabase = await readDatabase();
    if (fingerprint(database) !== fingerprint(verifiedDatabase)) fail('drift');
    const credentials =
      plan.accounts === 'keep'
        ? null
        : {
            version: 1,
            users: database.accounts.map((value) => {
              if (!('password' in value) || !('totpEnabled' in value) || !('totpSecret' in value) || !('salt' in value)) return fail('credentials');
              if (typeof value.password !== 'string' || typeof value.totpEnabled !== 'boolean') return fail('credentials');
              let secret: string | null = null;
              if (value.totpSecret !== null) {
                if (typeof value.totpSecret !== 'string' || !value.totpSecret || typeof value.salt !== 'string' || !value.salt)
                  return fail('credentials');
                try {
                  secret = options.encryption.decrypt(value.totpSecret, value.salt);
                } catch {
                  return fail('credentials');
                }
              }
              if (value.totpEnabled && secret === null) return fail('credentials');
              return { userId: value.id, password: { format: 'argon2-phc', encoded: value.password }, totp: { enabled: value.totpEnabled, secret } };
            }),
            passkeys: { policy: 'reenroll', state: before.passkeys },
          };
    const value = resetSafetyStatePayload({
      format: 'orbis-reset-state',
      version: 1,
      resetId: plan.resetId,
      accounts: plan.accounts,
      selectionSha256,
      users: database.accounts.map((value) => ({
        id: value.id,
        username: value.username,
        operator: value.operator,
        locale: value.locale,
        hasSeenWelcome: value.hasSeenWelcome,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      })),
      links: database.links,
      preferences: {
        server: before.server,
        automatic: { settings: before.automatic.state.settings, systemEnabled: before.automatic.system.enabled, policy: before.automatic.policy },
        timeMachine,
      },
      credentials,
      evidence: { automatic: { state: before.automatic.state, system: before.automatic.system }, cluster: before.cluster },
    });
    const final = await runtime();
    if (fingerprint(before) !== fingerprint(final)) fail('drift');
    await guard();
    const result = await work(value);
    if (recheckAfter) {
      const currentDatabase = await readDatabase();
      if (fingerprint(database) !== fingerprint(currentDatabase)) fail('drift');
      const current = await runtime();
      if (fingerprint(before) !== fingerprint(current)) fail('drift');
      await guard();
    }
    return result;
  };
  const snapshot = () => {
    if (options.captureRecovery) {
      if (!options.machine.withResetCapturePreferencesSnapshot) return fail('unreadable');
      return options.machine.withResetCapturePreferencesSnapshot(
        { ...context, inventoryAccess: options.captureRecovery.access, captures: options.captureRecovery.manifest },
        collect,
      );
    }
    return options.machine.withResetPreferencesSnapshot(context, collect);
  };
  return plan.accounts === 'remove' ? options.passkeys.withReadFence(snapshot) : snapshot();
}
