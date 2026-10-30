import { taskAttentionKey, taskAttentionLedgerSchema } from '@runtipi/common/schemas/task-history';
import { type } from 'arktype';
import { gt, lte, valid } from 'semver';
import { newerOrbisRelease, type OrbisRelease } from './orbis-release';
export { taskAttentionKey };

export const criticalUpdateAttentionKey = (release: OrbisRelease | undefined, installed: string | undefined) => {
  if (release?.priority !== 'critical' || !newerOrbisRelease(release, installed)) return null;
  const marker =
    release.criticalThrough && valid(release.criticalThrough) && lte(release.criticalThrough, release.tag) ? release.criticalThrough : release.tag;
  return installed && gt(marker, installed) ? `critical:${marker}` : null;
};
export const taskAttentionStorageKey = 'orbis-task-attention-read-v2';
const localKey = (account: number) => `${taskAttentionStorageKey}:${account}`;
const supplemental = (key: unknown): key is string =>
  typeof key === 'string' && key.length <= 128 && (key === 'history-unavailable' || (key.startsWith('critical:') && Boolean(valid(key.slice(9)))));
export function readTaskAcknowledgements(storage?: Pick<Storage, 'getItem'>, account = 0): string[] {
  try {
    const raw = storage?.getItem(localKey(account));
    if (!raw || raw.length > 64 * 1024) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.length <= 302 && value.every(supplemental) ? value : [];
  } catch {
    return [];
  }
}
export function mergeTaskAcknowledgements(previous: readonly string[], observed: readonly string[]) {
  const merged = [...new Set([...previous, ...observed])];
  if (merged.length > 4096) throw new Error('Task acknowledgement storage is full. Existing acknowledgements were preserved.');
  return merged;
}
export function saveTaskAcknowledgements(keys: readonly string[], storage: Pick<Storage, 'getItem' | 'setItem'>, account: number) {
  try {
    const raw = storage.getItem(localKey(account));
    const previous: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(previous) || previous.length > 302 || !previous.every(supplemental)) return false;
    const merged = mergeTaskAcknowledgements(previous, keys.filter(supplemental));
    if (merged.length > 302) return false;
    storage.setItem(localKey(account), JSON.stringify(merged));
    return true;
  } catch {
    return false;
  }
}
export function clearRecoveredHistoryAcknowledgement(storage: Pick<Storage, 'getItem' | 'setItem'>, account: number) {
  try {
    const raw = storage.getItem(localKey(account));
    if (!raw) return true;
    const keys: unknown = JSON.parse(raw);
    if (!Array.isArray(keys) || keys.length > 302 || !keys.every(supplemental)) return false;
    if (keys.includes('history-unavailable')) storage.setItem(localKey(account), JSON.stringify(keys.filter((key) => key !== 'history-unavailable')));
    return true;
  } catch {
    return false;
  }
}
export type TaskAttentionRequest = (url: string, options: RequestInit) => Promise<Response>;
export async function requestTaskAcknowledgements(signal: AbortSignal, keys?: readonly string[], request: TaskAttentionRequest = fetch) {
  signal.throwIfAborted();
  const response = await request('/api/tasks/attention', {
    method: keys ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    ...(keys ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, keys }) } : {}),
  });
  signal.throwIfAborted();
  if (!response.ok) throw new Error('Task alerts could not be saved or read. Open Tasks and try again.');
  const value = taskAttentionLedgerSchema(await response.json());
  signal.throwIfAborted();
  if (value instanceof type.errors) throw new Error('Task acknowledgement storage returned an invalid response.');
  return value;
}
const epochs = new WeakMap<object, number>();
let nextEpoch = 0;
export function taskAttentionSession(epoch: object) {
  let id = epochs.get(epoch);
  if (id === undefined) {
    id = ++nextEpoch;
    epochs.set(epoch, id);
  }
  return id;
}
