import type { TaskRecord } from '@runtipi/common/schemas/task-history';

export type SetupFailureOutcome = 'capture-failed' | 'capture-not-started' | 'preferences-save-failed';
export type SetupFailureTask = TaskRecord & { setupFailureOutcome: SetupFailureOutcome; setupFailureReason?: string };
type FailureEntry = { attemptId: string; outcome: SetupFailureOutcome; occurredAt: string; dismissed: boolean; reason?: string };
type FailureLedger = { version: 1; entries: FailureEntry[] };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

const key = (ownerId: number) => `orbis-setup-capture-tasks-v1:${ownerId}`;
const attemptPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const maximumEntries = 256;

function hasUnsafeFailureReason(reason: string) {
  for (const character of reason) {
    const code = character.charCodeAt(0);
    if (character === '<' || character === '>' || code < 32 || code === 127) return true;
  }
  return false;
}

export function mergeSetupCaptureTasks(serverTasks: readonly TaskRecord[], failureTasks: readonly SetupFailureTask[]) {
  const serverIds = new Set(serverTasks.map(({ id }) => id));
  return [...serverTasks, ...failureTasks.filter(({ id }) => !serverIds.has(id))];
}

function browserStorage(storage?: Storage | null): Storage | null {
  try {
    return storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : storage;
  } catch {
    return null;
  }
}

function readLedger(ownerId: number, storage: Storage | null): FailureLedger {
  const raw = storage?.getItem(key(ownerId));
  if (!raw) return { version: 1, entries: [] };
  if (raw.length > 64 * 1024) throw new Error('Setup capture task history is too large.');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'entries,version') throw new Error('Invalid task history.');
  const ledger = value as Partial<FailureLedger>;
  if (ledger.version !== 1 || !Array.isArray(ledger.entries) || ledger.entries.length > maximumEntries) throw new Error('Invalid task history.');
  const ids = new Set<string>();
  for (const entry of ledger.entries) {
    const expectedKeys = entry?.reason === undefined ? 'attemptId,dismissed,occurredAt,outcome' : 'attemptId,dismissed,occurredAt,outcome,reason';
    if (
      !entry ||
      Object.keys(entry).sort().join(',') !== expectedKeys ||
      !attemptPattern.test(entry.attemptId) ||
      !['capture-failed', 'capture-not-started', 'preferences-save-failed'].includes(entry.outcome) ||
      !Number.isFinite(Date.parse(entry.occurredAt)) ||
      (entry.reason !== undefined && (typeof entry.reason !== 'string' || entry.reason.length > 240 || hasUnsafeFailureReason(entry.reason))) ||
      (entry.outcome === 'preferences-save-failed' && !entry.reason) ||
      (entry.outcome !== 'preferences-save-failed' && entry.reason !== undefined) ||
      typeof entry.dismissed !== 'boolean' ||
      ids.has(entry.attemptId)
    )
      throw new Error('Invalid task history.');
    ids.add(entry.attemptId);
  }
  return ledger as FailureLedger;
}

function writeLedger(ownerId: number, ledger: FailureLedger, storage: Storage | null) {
  if (!storage || ledger.entries.length > maximumEntries) return false;
  try {
    const value = JSON.stringify(ledger);
    storage.setItem(key(ownerId), value);
    return storage.getItem(key(ownerId)) === value;
  } catch {
    return false;
  }
}

export function recordSetupFailureTask(
  ownerId: number,
  attemptId: string,
  outcome: SetupFailureOutcome,
  occurredAt = new Date().toISOString(),
  suppliedStorage?: Storage | null,
  reason?: string,
) {
  if (!attemptPattern.test(attemptId) || !Number.isFinite(Date.parse(occurredAt))) return false;
  if (outcome === 'preferences-save-failed' && (!reason || reason.length > 240 || hasUnsafeFailureReason(reason))) return false;
  if (outcome !== 'preferences-save-failed' && reason !== undefined) return false;
  const storage = browserStorage(suppliedStorage);
  try {
    const ledger = readLedger(ownerId, storage);
    if (ledger.entries.some((entry) => entry.attemptId === attemptId)) return true;
    return writeLedger(
      ownerId,
      { ...ledger, entries: [...ledger.entries, { attemptId, outcome, occurredAt, dismissed: false, ...(reason ? { reason } : {}) }] },
      storage,
    );
  } catch {
    return false;
  }
}

export function setupFailureTasks(ownerId: number, suppliedStorage?: Storage | null): SetupFailureTask[] {
  const storage = browserStorage(suppliedStorage);
  if (!storage) return [];
  try {
    return readLedger(ownerId, storage)
      .entries.filter((entry) => !entry.dismissed)
      .map((entry) => ({
        id: entry.attemptId,
        appUrn: (entry.outcome === 'preferences-save-failed' ? 'orbis:settings' : 'orbis:time-machine') as TaskRecord['appUrn'],
        displayName: entry.outcome === 'preferences-save-failed' ? 'Time Machine preferences' : 'Time Machine setup capture',
        action: entry.outcome === 'preferences-save-failed' ? 'update' : 'backup',
        status: 'failed',
        createdAt: entry.occurredAt,
        updatedAt: entry.occurredAt,
        startedAt: null,
        finishedAt: entry.occurredAt,
        attentionRevision: 0,
        setupFailureOutcome: entry.outcome,
        ...(entry.reason ? { setupFailureReason: entry.reason } : {}),
      }));
  } catch {
    return [];
  }
}

export function dismissSetupFailureTask(ownerId: number, attemptId: string, suppliedStorage?: Storage | null) {
  const storage = browserStorage(suppliedStorage);
  try {
    const ledger = readLedger(ownerId, storage);
    const entry = ledger.entries.find((item) => item.attemptId === attemptId);
    if (!entry || entry.dismissed) return Boolean(entry);
    return writeLedger(
      ownerId,
      { ...ledger, entries: ledger.entries.map((item) => (item.attemptId === attemptId ? { ...item, dismissed: true } : item)) },
      storage,
    );
  } catch {
    return false;
  }
}
