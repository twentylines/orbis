import { createHash, randomUUID } from 'node:crypto';
import { resetExportPlanSha256, type ResetExportPlan, type SettingsExportBinding } from './settings-export-authorization';

export type ResetSafetyCapture = { id: string; ownerId: number };
type Inventory = { users: number[]; captures: ResetSafetyCapture[] };
const maximumExports = 4096;
const capturesPerExport = 16;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const user = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const fail = () => new Error('Reset safety backup selection needs review.');
function keys(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw fail();
}
function inventory(value: Inventory) {
  keys(value, ['users', 'captures']);
  if (
    !Array.isArray(value.users) ||
    value.users.length < 1 ||
    value.users.length > 256 ||
    !Array.from(value.users).every(user) ||
    new Set(value.users).size !== value.users.length ||
    !Array.isArray(value.captures) ||
    value.captures.length > maximumExports * capturesPerExport
  )
    throw fail();
  const users = [...value.users].sort((a, b) => a - b);
  const owners = new Set(users);
  const captures = Array.from(value.captures, (capture) => {
    keys(capture, ['id', 'ownerId']);
    if (!uuid(capture.id) || !owners.has(capture.ownerId)) throw fail();
    return Object.freeze({ id: capture.id, ownerId: capture.ownerId });
  });
  captures.sort((a, b) => a.ownerId - b.ownerId || a.id.localeCompare(b.id));
  if (new Set(captures.map((capture) => capture.id)).size !== captures.length) throw fail();
  const byOwner = new Map(users.map((ownerId) => [ownerId, [] as string[]]));
  for (const capture of captures) byOwner.get(capture.ownerId)?.push(capture.id);
  const count = Array.from(byOwner.values()).reduce((total, points) => total + Math.max(1, Math.ceil(points.length / capturesPerExport)), 0);
  if (count > maximumExports) throw fail();
  return { users, captures, byOwner };
}

/** The caller must obtain and recheck the authoritative inventory while holding reset's maintenance lease. */
export function assertResetSafetyExportCoverage(plan: ResetExportPlan, current: Inventory): void {
  try {
    resetExportPlanSha256(plan);
    const expected = inventory(current);
    if (JSON.stringify([...plan.users].sort((a, b) => a - b)) !== JSON.stringify(expected.users)) throw fail();
    const full = new Map(expected.users.map((ownerId) => [ownerId, 0]));
    const captured: ResetSafetyCapture[] = [];
    for (const item of plan.exports) {
      const ordinary = [item.selection.settings, item.selection.dashboard, item.selection.wallpapers, item.selection.themes];
      if (ordinary.every(Boolean)) full.set(item.ownerId, (full.get(item.ownerId) ?? 0) + 1);
      else if (ordinary.some(Boolean)) throw fail();
      for (const id of item.selection.timeMachine) captured.push({ id, ownerId: item.ownerId });
    }
    captured.sort((a, b) => a.ownerId - b.ownerId || a.id.localeCompare(b.id));
    if (Array.from(full.values()).some((count) => count !== 1) || JSON.stringify(captured) !== JSON.stringify(expected.captures)) throw fail();
  } catch {
    throw fail();
  }
}

/** Plans existing settings/capture exports only; this neither captures Docker data nor authorizes erasure. */
export function planResetSafetyExports(
  options: { resetId: string; accounts: 'keep' | 'remove'; users: number[]; captures: ResetSafetyCapture[] },
  nextExportId: () => string = randomUUID,
) {
  keys(options, ['resetId', 'accounts', 'users', 'captures']);
  if (!uuid(options.resetId) || !['keep', 'remove'].includes(options.accounts)) throw fail();
  const expected = inventory({ users: options.users, captures: options.captures });
  const exports: SettingsExportBinding[] = [];
  const ids = new Set<string>();
  for (const ownerId of expected.users) {
    const points = expected.byOwner.get(ownerId) ?? [];
    for (let offset = 0; offset < Math.max(1, points.length); offset += capturesPerExport) {
      const exportId = nextExportId();
      if (!uuid(exportId) || ids.has(exportId)) throw fail();
      ids.add(exportId);
      exports.push(
        Object.freeze({
          exportId,
          ownerId,
          selection: Object.freeze({
            version: 1 as const,
            settings: offset === 0,
            dashboard: offset === 0,
            wallpapers: offset === 0,
            themes: offset === 0,
            timeMachine: Object.freeze(points.slice(offset, offset + capturesPerExport)) as unknown as string[],
          }),
        }),
      );
    }
  }
  const plan: ResetExportPlan = Object.freeze({
    resetId: options.resetId,
    accounts: options.accounts,
    users: Object.freeze(expected.users) as unknown as number[],
    exports: Object.freeze(exports) as unknown as SettingsExportBinding[],
  });
  assertResetSafetyExportCoverage(plan, { users: expected.users, captures: expected.captures });
  return Object.freeze({
    plan,
    selectionSha256: resetExportPlanSha256(plan),
    inventorySha256: createHash('sha256')
      .update('orbis-reset-export-inventory-v1\n')
      .update(JSON.stringify({ users: expected.users, captures: expected.captures }))
      .digest('hex'),
  });
}
