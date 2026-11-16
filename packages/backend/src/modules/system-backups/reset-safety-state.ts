import { createHash } from 'node:crypto';
import { type } from 'arktype';
import { timeMachinePreferencesSchema } from '@runtipi/common/schemas/time-machine';
import { assertBackupMaintenanceLease, type BackupMaintenanceLease } from '../../common/backup-maintenance-lease';
import { passkeyStateSchema } from '../auth/passkey.store';
import { restoreDestinationSyncSettings } from '../cluster/cluster-sync.store';
import { automaticSchedulePolicySchema } from '../host-updates/automatic-schedule-policy';
import { automaticUpdateSettingsSchema, automaticUpdateStateSchema, systemUpdateStateSchema } from '../host-updates/automatic-updates.model';
import { backupCipherOverhead, backupMetadataBytes } from './backup-crypto';
import { assertResetExportAccess, resetExportPlanSha256, type ResetExportPlan, type SettingsExportAccess } from './settings-export-authorization';

const maximumBytes = 8 * 1024 * 1024;
const fail = () => new Error('The reset safety backup state could not be verified.');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const id = type('number.integer > 0').narrow(Number.isSafeInteger);
const epoch = type('number.integer >= 0').narrow(Number.isSafeInteger);
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const account = type({
  id,
  username: 'string > 0 & string <= 320',
  operator: 'boolean',
  locale: 'string <= 100',
  hasSeenWelcome: 'boolean',
  createdAt: epoch,
  updatedAt: epoch,
});
const link = type({
  id,
  userId: id,
  title: type('string').narrow((value) => [...value].length <= 20),
  url: 'string <= 1048576',
  iconUrl: 'string <= 1048576 | null',
  description: type('string')
    .narrow((value) => [...value].length <= 50)
    .or('null'),
  isVisibleOnGuestDashboard: 'boolean',
  createdAt: epoch,
  updatedAt: epoch,
});
const credential = type({
  userId: id,
  password: {
    format: "'argon2-phc'",
    encoded: type('string <= 2048').narrow((value) =>
      /^\$argon2(?:id|i|d)\$v=(?:16|19)\$m=[1-9][0-9]{0,9},t=[1-9][0-9]{0,5},p=[1-9][0-9]{0,5}\$[A-Za-z0-9+/]{8,128}\$[A-Za-z0-9+/]{16,128}$/.test(
        value,
      ),
    ),
  },
  totp: type({
    enabled: 'boolean',
    secret: type('string >= 16 & string <= 512')
      .narrow((value) => /^[A-Z2-7]+={0,6}$/.test(value))
      .or('null'),
  }).narrow((value) => !value.enabled || value.secret !== null),
});
const credentials = type({
  version: '1',
  users: credential.array().atMostLength(256),
  passkeys: { policy: "'reenroll'", state: passkeyStateSchema },
});
const stateSchema = type({
  format: "'orbis-reset-state'",
  version: '1',
  resetId: uuid,
  accounts: "'keep' | 'remove'",
  selectionSha256: hash,
  users: account.array().atLeastLength(1).atMostLength(256),
  links: link.array().atMostLength(100_000),
  preferences: {
    server: {
      advancedSettings: 'boolean',
      allowAutoThemes: 'boolean',
      allowErrorMonitoring: 'boolean',
      guestDashboard: 'boolean',
      themeBase: 'string <= 1024 | null',
      themeColor: 'string <= 1024 | null',
    },
    automatic: { settings: automaticUpdateSettingsSchema, systemEnabled: 'boolean', policy: automaticSchedulePolicySchema.or('null') },
    timeMachine: timeMachinePreferencesSchema,
  },
  credentials: credentials.or('null'),
  evidence: {
    automatic: { state: automaticUpdateStateSchema, system: systemUpdateStateSchema },
    cluster: {
      hostId: uuid,
      invite: type({ hash, expiresAt: epoch, 'ownerId?': id, 'authVersion?': '2' }).or('null'),
      sync: 'string <= 131072 | null',
    },
  },
}).onDeepUndeclaredKey('reject');
export type ResetSafetyState = typeof stateSchema.infer;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Evidence records are never restore authority. Passkeys require reenrollment; sessions and host secrets have no fields here. */
export function resetSafetyStatePayload(input: unknown): ResetSafetyState {
  try {
    const serialized = JSON.stringify(input);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > maximumBytes) throw fail();
    const value = stateSchema.assert(JSON.parse(serialized));
    const users = new Set(value.users.map((user) => user.id));
    if (
      users.size !== value.users.length ||
      !value.users.some((user) => user.operator) ||
      new Set(value.links.map((link) => link.id)).size !== value.links.length ||
      value.links.some((link) => !users.has(link.userId)) ||
      (value.accounts === 'keep' ? value.credentials !== null : value.credentials === null)
    )
      throw fail();
    value.users.sort((a, b) => a.id - b.id);
    value.links.sort((a, b) => a.id - b.id);
    if (value.credentials) {
      const credentials = value.credentials;
      if (
        credentials.users.length !== users.size ||
        new Set(credentials.users.map((user) => user.userId)).size !== users.size ||
        credentials.users.some((user) => !users.has(user.userId)) ||
        Object.keys(credentials.passkeys.state.users).some((id) => !users.has(Number(id)))
      )
        throw fail();
      const registered = Object.values(credentials.passkeys.state.users).flatMap((user) => user.credentials);
      if (new Set(registered.map((key) => key.id)).size !== registered.length || registered.some((key) => !Number.isSafeInteger(key.counter)))
        throw fail();
      credentials.users.sort((a, b) => a.userId - b.userId);
    }
    const { sync, hostId } = value.evidence.cluster;
    if (sync !== null) restoreDestinationSyncSettings(Buffer.from(sync), hostId);
    return freeze(value);
  } catch {
    throw fail();
  }
}

function binding(value: ResetSafetyState, plan: ResetExportPlan) {
  if (
    value.resetId !== plan.resetId ||
    value.accounts !== plan.accounts ||
    value.selectionSha256 !== resetExportPlanSha256(plan) ||
    JSON.stringify(value.users.map((user) => user.id)) !== JSON.stringify([...plan.users].sort((a, b) => a - b))
  )
    throw fail();
}

async function authority(options: { access: SettingsExportAccess; plan: ResetExportPlan; lease: BackupMaintenanceLease; signal: AbortSignal }) {
  options.signal.throwIfAborted();
  assertBackupMaintenanceLease(options.lease);
  await assertResetExportAccess(options.access, options.plan);
  options.signal.throwIfAborted();
  assertBackupMaintenanceLease(options.lease);
}

export async function encodeResetSafetyState(options: {
  value: unknown;
  plan: ResetExportPlan;
  access: SettingsExportAccess;
  lease: BackupMaintenanceLease;
  passphrase: string;
  signal: AbortSignal;
}) {
  await authority(options);
  const value = resetSafetyStatePayload(options.value);
  binding(value, options.plan);
  const plaintext = Buffer.from(JSON.stringify(value));
  try {
    const payloadSha256 = sha(plaintext);
    const ciphertext = await backupMetadataBytes(plaintext, options.passphrase, false, maximumBytes);
    await authority(options);
    return Object.freeze({ ciphertext, bytes: ciphertext.length, sha256: sha(ciphertext), payloadSha256 });
  } finally {
    plaintext.fill(0);
  }
}

/** Decodes private archive data only. Its caller owns restore authorization, account mapping and destination validation. */
export async function decodeResetSafetyState(options: {
  ciphertext: Buffer;
  bytes: number;
  sha256: string;
  payloadSha256: string;
  plan: ResetExportPlan;
  passphrase: string;
  signal: AbortSignal;
}) {
  let plaintext: Buffer | undefined;
  try {
    options.signal.throwIfAborted();
    if (
      !Buffer.isBuffer(options.ciphertext) ||
      !Number.isSafeInteger(options.bytes) ||
      options.bytes < backupCipherOverhead ||
      options.bytes > maximumBytes + backupCipherOverhead ||
      options.ciphertext.length !== options.bytes ||
      !hash.allows(options.sha256) ||
      !hash.allows(options.payloadSha256)
    )
      throw fail();
    const ciphertext = Buffer.from(options.ciphertext);
    if (sha(ciphertext) !== options.sha256) throw fail();
    plaintext = await backupMetadataBytes(ciphertext, options.passphrase, true, maximumBytes);
    options.signal.throwIfAborted();
    if (sha(plaintext) !== options.payloadSha256) throw fail();
    const value = resetSafetyStatePayload(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
    if (!Buffer.from(JSON.stringify(value)).equals(plaintext)) throw fail();
    binding(value, options.plan);
    return value;
  } catch {
    throw fail();
  } finally {
    plaintext?.fill(0);
  }
}
