import type { TaskCentreRecord } from './task-centre-model';

export type ActivityVisibility = { version: 1; completedBefore: number; hidden: string[] };
export const emptyActivityVisibility: ActivityVisibility = { version: 1, completedBefore: 0, hidden: [] };
export type ActivityClearUndo = { added: string[]; expiresAt: number };
const undoDuration = 10_000;

export function activityVisibilityKey(owner: string, server: string) {
  return `orbis:activity-visibility:v1:${encodeURIComponent(server)}:${encodeURIComponent(owner)}`;
}

export function readActivityVisibility(value: string | null): ActivityVisibility {
  try {
    if (!value || value.length > 512_000) return emptyActivityVisibility;
    const parsed = JSON.parse(value) as ActivityVisibility;
    if (parsed.version !== 1 || !Number.isFinite(parsed.completedBefore) || parsed.completedBefore < 0 || !Array.isArray(parsed.hidden))
      return emptyActivityVisibility;
    if (parsed.hidden.length > 5000 || parsed.hidden.some((key) => typeof key !== 'string' || key.length > 2000)) return emptyActivityVisibility;
    return { version: 1, completedBefore: parsed.completedBefore, hidden: [...new Set(parsed.hidden)] };
  } catch {
    return emptyActivityVisibility;
  }
}

export function canDismissActivity(record: TaskCentreRecord) {
  return (
    record.bucket !== 'active' &&
    !record.stale &&
    !record.dismissed &&
    (record.outcome === 'succeeded' || record.outcome === 'cancelled' || record.outcome === 'failed')
  );
}

export function completedActivity(record: TaskCentreRecord) {
  return record.bucket === 'recent' && canDismissActivity(record);
}

export function activityRevision(record: TaskCentreRecord) {
  const revision = [record.key, record.outcome, record.finishedAt ?? record.time ?? null];
  return JSON.stringify(record.outcome === 'failed' && record.task?.attentionRevision ? [...revision, record.task.attentionRevision] : revision);
}

function completionTime(record: TaskCentreRecord) {
  // Backup exports, captures and core updates expose a start/creation time, not a finish time.
  // Their known IDs can be hidden explicitly; a new completion must never inherit a start-time cutoff.
  return record.finishedAt ?? (record.task || record.system?.feed === 'imports' ? record.time : undefined);
}

export function activityIsHidden(record: TaskCentreRecord, state: ActivityVisibility) {
  if (record.dismissed) return true;
  if (!canDismissActivity(record)) return false;
  const completedAt = completionTime(record);
  return (
    state.hidden.includes(activityRevision(record)) ||
    (completedActivity(record) && completedAt != null && completedAt > 0 && completedAt <= state.completedBefore)
  );
}

export function dismissActivity(state: ActivityVisibility, records: TaskCentreRecord[]): ActivityVisibility {
  return { ...state, hidden: [...new Set([...state.hidden, ...records.filter(canDismissActivity).map(activityRevision)])] };
}

export function clearCompletedActivity(state: ActivityVisibility, records: TaskCentreRecord[], now = Date.now()) {
  return clearActivity(state, records.filter(completedActivity), now);
}

export function clearAttentionActivity(state: ActivityVisibility, records: TaskCentreRecord[], now = Date.now()) {
  return clearActivity(
    state,
    records.filter((record) => record.bucket === 'review' && canDismissActivity(record)),
    now,
  );
}

function clearActivity(state: ActivityVisibility, records: TaskCentreRecord[], now: number) {
  // Hide the known records available to this view. Keep reading older saved cutoffs for compatibility.
  const added = records.filter((record) => !activityIsHidden(record, state)).map(activityRevision);
  return {
    state: { ...state, hidden: [...new Set([...state.hidden, ...added])] },
    undo: { added, expiresAt: now + undoDuration } satisfies ActivityClearUndo,
  };
}

export function undoCompletedActivity(state: ActivityVisibility, undo: ActivityClearUndo): ActivityVisibility {
  return {
    ...state,
    hidden: state.hidden.filter((key) => !undo.added.includes(key)),
  };
}
