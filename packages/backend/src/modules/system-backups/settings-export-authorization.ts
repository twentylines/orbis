import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { settingsBackupSelectionSchema, type SettingsBackupSelection } from '@runtipi/common/schemas/settings-backup';
import { backupRecoveryOutsideResetActive } from '../../common/backup-maintenance';
import { SESSION_COOKIE_NAME } from '../../common/constants';
import { assertBackupMaintenanceLease, type BackupMaintenanceLease } from '../../common/backup-maintenance-lease';
import type { AuthService, OperatorActionRequest } from '../auth/auth.service';
import type { PasskeyService } from '../auth/passkey.service';
import { resetSensitiveActionBinding } from '../system-reset/reset-contract';

export type SettingsExportBinding = { exportId: string; ownerId: number; selection: SettingsBackupSelection };
declare const ticketBrand: unique symbol;
declare const accessBrand: unique symbol;
declare const proofBrand: unique symbol;
declare const inventoryBrand: unique symbol;
export type SettingsExportTicket = Readonly<{ [ticketBrand]: true }>;
export type SettingsExportAccess = Readonly<{ [accessBrand]: true }>;
export type ResetExportProof = Readonly<{ [proofBrand]: true }>;
export type ResetInventoryAccess = Readonly<{ [inventoryBrand]: true }>;
export type ResetInventoryBinding = { resetId: string; accounts: 'keep' | 'remove'; lease: BackupMaintenanceLease; signal: AbortSignal };
export type ResetExportPlan = { resetId: string; accounts: 'keep' | 'remove'; users: number[]; exports: SettingsExportBinding[] };
type Actor = Awaited<ReturnType<AuthService['operatorActionContext']>>;
type Admission = { auth: AuthService; request: OperatorActionRequest; actor: Actor; expires: number };
type Scope = Admission & {
  bindings: SettingsExportBinding[];
  signal: AbortSignal;
  lease?: BackupMaintenanceLease;
  resetPlanSha256?: string;
  inventoryParent?: ResetInventoryAccess;
};
type InventoryScope = Scope & { resetId: string; accounts: 'keep' | 'remove'; lease: BackupMaintenanceLease; planUsed: boolean };
const tickets = new WeakMap<SettingsExportTicket, Admission & { binding: SettingsExportBinding }>();
const proofs = new WeakMap<ResetExportProof, Admission & { accounts: 'keep' | 'remove' }>();
const accesses = new WeakMap<SettingsExportAccess, Scope>();
const inventories = new WeakMap<ResetInventoryAccess, InventoryScope>();
function fail(): never {
  throw new Error('Settings export authorization is not active.');
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const user = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
    allowed.some((key) => !Object.hasOwn(value, key))
  )
    fail();
}
function selection(value: unknown): SettingsBackupSelection {
  settingsBackupSelectionSchema.assert(value);
  const s = value as SettingsBackupSelection;
  return Object.freeze({
    version: 1,
    settings: s.settings,
    dashboard: s.dashboard,
    wallpapers: s.wallpapers,
    themes: s.themes,
    timeMachine: Object.freeze([...s.timeMachine].sort()) as unknown as string[],
  });
}
function binding(value: SettingsExportBinding): SettingsExportBinding {
  keys(value, ['exportId', 'ownerId', 'selection']);
  if (!uuid(value.exportId) || !user(value.ownerId)) fail();
  return Object.freeze({ exportId: value.exportId, ownerId: value.ownerId, selection: selection(value.selection) });
}
function plan(value: ResetExportPlan): ResetExportPlan {
  keys(value, ['resetId', 'accounts', 'users', 'exports']);
  if (
    !uuid(value.resetId) ||
    !['keep', 'remove'].includes(value.accounts) ||
    !Array.isArray(value.users) ||
    !value.users.length ||
    value.users.length > 256 ||
    !value.users.every(user) ||
    new Set(value.users).size !== value.users.length ||
    !Array.isArray(value.exports) ||
    value.exports.length > 4096
  )
    fail();
  const users = [...value.users].sort((a, b) => a - b);
  const exports = value.exports.map(binding).sort((a, b) => a.exportId.localeCompare(b.exportId));
  const points = exports.flatMap((item) => item.selection.timeMachine);
  if (
    new Set(exports.map((item) => item.exportId)).size !== exports.length ||
    new Set(points).size !== points.length ||
    exports.some((item) => !users.includes(item.ownerId)) ||
    users.some(
      (id) =>
        !exports.some(
          (item) => item.ownerId === id && item.selection.settings && item.selection.dashboard && item.selection.wallpapers && item.selection.themes,
        ),
    )
  )
    fail();
  return Object.freeze({
    resetId: value.resetId,
    accounts: value.accounts,
    users: Object.freeze(users) as unknown as number[],
    exports: Object.freeze(exports) as unknown as SettingsExportBinding[],
  });
}
export function resetExportPlanSha256(value: ResetExportPlan): string {
  return createHash('sha256')
    .update(JSON.stringify(plan(value)))
    .digest('hex');
}
function live(state: Admission) {
  if (Date.now() >= state.expires) fail();
}
function scopeLive(state: Scope) {
  live(state);
  state.signal.throwIfAborted();
  if (state.lease) {
    assertBackupMaintenanceLease(state.lease);
    if (backupRecoveryOutsideResetActive()) fail();
  }
  if (state.inventoryParent) {
    const parent = inventories.get(state.inventoryParent);
    if (!parent || parent.lease !== state.lease || parent.signal !== state.signal) fail();
    try {
      scopeLive(parent);
    } catch (error) {
      inventories.delete(state.inventoryParent);
      throw error;
    }
  }
}
async function actor(state: Admission) {
  live(state);
  const current = await state.auth.operatorActionContext(state.request);
  live(state);
  if (
    current.userId !== state.actor.userId ||
    current.sessionBinding !== state.actor.sessionBinding ||
    current.securityBinding !== state.actor.securityBinding
  )
    fail();
}
function proofFields(value: unknown, required: string[], optional: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const fields = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(fields).some((key) => typeof key !== 'string' || ![...required, ...optional].includes(key)) ||
    required.some((key) => !Object.hasOwn(fields, key))
  )
    fail();
  if (fields.totpCode !== undefined && (typeof fields.totpCode !== 'string' || !/^\d{6}$/.test(fields.totpCode))) fail();
  return fields;
}
function passwordFields(value: unknown, method = false) {
  const fields = proofFields(value, method ? ['method', 'password'] : ['password'], ['totpCode']);
  if (typeof fields.password !== 'string' || fields.password.length < 1 || fields.password.length > 1024) fail();
}
function actorRequest(request: Request): OperatorActionRequest {
  return {
    authMethod: request.authMethod,
    user: request.user ? { id: request.user.id, operator: request.user.operator } : undefined,
    cookies: { [SESSION_COOKIE_NAME]: request.cookies?.[SESSION_COOKIE_NAME] },
  };
}
async function passwordAdmission(auth: AuthService, request: Request, credentials: { password: string; totpCode?: string }, lifetime: number) {
  const state = { auth, request: actorRequest(request), actor: await auth.operatorActionContext(request), expires: Date.now() + lifetime };
  await auth.verifySensitiveAction(state.actor.userId, credentials.password, credentials.totpCode);
  await actor(state);
  return state;
}
export async function authorizeSettingsPasswordExport(
  auth: AuthService,
  request: Request,
  credentials: { password: string; totpCode?: string },
  value: SettingsExportBinding,
): Promise<SettingsExportTicket> {
  const item = binding(value);
  passwordFields(credentials);
  const state = await passwordAdmission(auth, request, credentials, 60_000);
  if (state.actor.userId !== item.ownerId) fail();
  const token = Object.freeze({}) as SettingsExportTicket;
  tickets.set(token, { ...state, binding: item });
  return token;
}
async function run<T>(
  state: Admission,
  bindings: SettingsExportBinding[],
  signal: AbortSignal,
  work: (access: SettingsExportAccess) => Promise<T>,
  lease?: BackupMaintenanceLease,
  resetPlanSha256?: string,
  inventoryParent?: ResetInventoryAccess,
): Promise<T> {
  const scope: Scope = { ...state, bindings, signal, lease, resetPlanSha256, inventoryParent };
  scopeLive(scope);
  await actor(scope);
  scopeLive(scope);
  scope.expires = Date.now() + 3_600_000;
  const access = Object.freeze({}) as SettingsExportAccess;
  accesses.set(access, scope);
  try {
    const result = await work(access);
    const first = bindings[0];
    if (!first) fail();
    await assertSettingsExportAccess(access, first);
    return result;
  } finally {
    accesses.delete(access);
  }
}
export async function withSettingsExportAccess<T>(
  ticket: SettingsExportTicket,
  value: SettingsExportBinding,
  signal: AbortSignal,
  work: (access: SettingsExportAccess) => Promise<T>,
): Promise<T> {
  const state = tickets.get(ticket);
  tickets.delete(ticket);
  if (!state || JSON.stringify(binding(value)) !== JSON.stringify(state.binding)) fail();
  return run(state, [state.binding], signal, work);
}
export async function assertSettingsExportAccess(
  access: SettingsExportAccess,
  expected: { exportId: string; ownerId: number; selection?: unknown; pointId?: string },
): Promise<void> {
  const state = accesses.get(access);
  if (!state) fail();
  try {
    scopeLive(state);
  } catch (error) {
    accesses.delete(access);
    throw error;
  }
  const item = state.bindings.find((item) => item.exportId === expected.exportId && item.ownerId === expected.ownerId);
  if (
    !item ||
    (expected.selection !== undefined && JSON.stringify(selection(expected.selection)) !== JSON.stringify(item.selection)) ||
    (expected.pointId !== undefined && !item.selection.timeMachine.includes(expected.pointId))
  )
    fail();
  try {
    await actor(state);
    if (accesses.get(access) !== state) fail();
    scopeLive(state);
  } catch (error) {
    accesses.delete(access);
    throw error;
  }
}
export function settingsExportBorrowsMaintenance(access: SettingsExportAccess): boolean {
  const state = accesses.get(access);
  if (!state) fail();
  try {
    scopeLive(state);
  } catch (error) {
    accesses.delete(access);
    throw error;
  }
  return !!state.lease;
}

/** Supplemental reset state requires the entire admitted action, not just a matching profile export. */
export async function assertResetExportAccess(access: SettingsExportAccess, value: ResetExportPlan): Promise<void> {
  const state = accesses.get(access);
  if (!state?.lease || !state.resetPlanSha256 || state.resetPlanSha256 !== resetExportPlanSha256(value)) fail();
  const first = state.bindings[0];
  if (!first) fail();
  await assertSettingsExportAccess(access, first);
}
export async function verifyResetExportProof(
  auth: AuthService,
  passkeys: PasskeyService,
  request: Request,
  accounts: 'keep' | 'remove',
  proof:
    | { method: 'password'; password: string; totpCode?: string }
    | { method: 'passkey'; challengeId: string; response: unknown; totpCode?: string },
): Promise<ResetExportProof> {
  const actionBinding = resetSensitiveActionBinding(accounts);
  let state: Admission;
  if (!proof || typeof proof !== 'object') fail();
  if (proof.method === 'password') {
    passwordFields(proof, true);
    state = await passwordAdmission(auth, request, proof, 300_000);
  } else if (proof.method === 'passkey') {
    const fields = proofFields(proof, ['method', 'challengeId', 'response'], ['totpCode']);
    if (typeof fields.challengeId !== 'string' || fields.challengeId.length < 1 || fields.challengeId.length > 256 || fields.response == null) fail();
    state = { auth, request: actorRequest(request), actor: await auth.operatorActionContext(request), expires: Date.now() + 300_000 };
    await passkeys.verifySensitive(request, actionBinding, {
      challengeId: proof.challengeId,
      response: proof.response,
      ...(proof.totpCode === undefined ? {} : { totpCode: proof.totpCode }),
    });
    await actor(state);
  } else return fail();
  const token = Object.freeze({}) as ResetExportProof;
  proofs.set(token, { ...state, accounts });
  return token;
}
// These process-local proofs provide no restart authority; durable receipt integration remains the caller's responsibility.
export async function withResetExportAccess<T>(
  proof: ResetExportProof,
  value: ResetExportPlan,
  lease: BackupMaintenanceLease,
  signal: AbortSignal,
  work: (access: SettingsExportAccess) => Promise<T>,
): Promise<T> {
  const state = proofs.get(proof);
  proofs.delete(proof);
  if (!state) fail();
  const normalized = plan(value);
  if (state.accounts !== normalized.accounts || !normalized.users.includes(state.actor.userId)) fail();
  assertBackupMaintenanceLease(lease);
  return run(state, normalized.exports, signal, work, lease, resetExportPlanSha256(normalized));
}

/** Reads the inventory before a complete plan exists, using the same single-use reset confirmation. */
export async function withResetInventoryAccess<T>(
  proof: ResetExportProof,
  value: ResetInventoryBinding,
  work: (access: ResetInventoryAccess) => Promise<T>,
): Promise<T> {
  const state = proofs.get(proof);
  proofs.delete(proof);
  const { resetId, accounts, lease, signal } = value;
  if (!state || !uuid(resetId) || state.accounts !== accounts) fail();
  assertBackupMaintenanceLease(lease);
  const scope: InventoryScope = { ...state, resetId, accounts, lease, signal, bindings: [], planUsed: false };
  scopeLive(scope);
  await actor(scope);
  scopeLive(scope);
  scope.expires = Date.now() + 3_600_000;
  const access = Object.freeze({}) as ResetInventoryAccess;
  inventories.set(access, scope);
  try {
    const result = await work(access);
    await assertResetInventoryAccess(access, { resetId, accounts, lease, signal });
    return result;
  } finally {
    inventories.delete(access);
  }
}

export async function assertResetInventoryAccess(access: ResetInventoryAccess, expected: ResetInventoryBinding): Promise<void> {
  const scope = inventories.get(access);
  if (
    !scope ||
    scope.resetId !== expected.resetId ||
    scope.accounts !== expected.accounts ||
    scope.lease !== expected.lease ||
    scope.signal !== expected.signal
  )
    fail();
  try {
    scopeLive(scope);
    await actor(scope);
    if (inventories.get(access) !== scope) fail();
    scopeLive(scope);
  } catch (error) {
    inventories.delete(access);
    throw error;
  }
}

/** Exactly one complete plan may be admitted after inventory. Ending inventory revokes its child export scope. */
export async function withResetExportAccessFromInventory<T>(
  access: ResetInventoryAccess,
  value: ResetExportPlan,
  work: (exports: SettingsExportAccess) => Promise<T>,
): Promise<T> {
  const scope = inventories.get(access);
  const normalized = plan(value);
  if (
    !scope ||
    scope.planUsed ||
    scope.resetId !== normalized.resetId ||
    scope.accounts !== normalized.accounts ||
    !normalized.users.includes(scope.actor.userId)
  )
    fail();
  scope.planUsed = true;
  await assertResetInventoryAccess(access, scope);
  return run(scope, normalized.exports, scope.signal, work, scope.lease, resetExportPlanSha256(normalized), access);
}
