import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { TaskCentreRecord } from './task-centre-model';
import {
  activityRevision,
  activityVisibilityKey,
  canDismissActivity,
  clearCompletedActivity,
  dismissActivity,
  readActivityVisibility,
  undoCompletedActivity,
  type ActivityClearUndo,
  type ActivityVisibility,
} from './task-centre-visibility';

type Snapshot = { value: string | null; undo?: ActivityClearUndo; unsaved?: boolean };
const snapshots = new Map<string, Snapshot>();
const undoTimers = new Map<string, number>();
const listeners = new Set<() => void>();
const empty: Snapshot = { value: null };
function notify() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', onStorage);
  };
}
function onStorage(event: StorageEvent) {
  if (event.key?.startsWith('orbis:activity-visibility:v1:') || event.key === null) {
    if (event.key) {
      stopUndoTimer(event.key);
      snapshots.delete(event.key);
    } else {
      for (const key of undoTimers.keys()) stopUndoTimer(key);
      snapshots.clear();
    }
    notify();
  }
}
function stopUndoTimer(key: string) {
  window.clearTimeout(undoTimers.get(key));
  undoTimers.delete(key);
}
function snapshot(key: string | null): Snapshot {
  if (!key || typeof window === 'undefined') return empty;
  const existing = snapshots.get(key);
  if (existing) return existing;
  try {
    const initial = { value: window.localStorage.getItem(key) };
    snapshots.set(key, initial);
    return initial;
  } catch {
    return empty;
  }
}

export function useTaskCentreVisibility(owner?: string) {
  const key = owner && typeof window !== 'undefined' ? activityVisibilityKey(owner, window.location.origin) : null;
  const getSnapshot = useCallback(() => snapshot(key), [key]);
  const current = useSyncExternalStore(subscribe, getSnapshot, () => empty);
  const state = useMemo(() => readActivityVisibility(current.value), [current.value]);
  const update = (value: ActivityVisibility, undo?: ActivityClearUndo) => {
    if (!key) return;
    const serialized = JSON.stringify(value);
    let unsaved = false;
    try {
      if (serialized.length > 512_000 || value.hidden.length > 5000) throw new Error('Activity visibility storage is full');
      window.localStorage.setItem(key, serialized);
    } catch {
      unsaved = true;
    }
    snapshots.set(key, { value: serialized, undo, unsaved });
    stopUndoTimer(key);
    if (undo) {
      undoTimers.set(
        key,
        window.setTimeout(
          () => {
            const latest = snapshot(key);
            snapshots.set(key, { ...latest, undo: undefined });
            undoTimers.delete(key);
            notify();
          },
          Math.max(0, undo.expiresAt - Date.now()),
        ),
      );
    }
    notify();
  };
  return {
    enabled: Boolean(key),
    state,
    undoAvailable: Boolean(current.undo),
    unsaved: current.unsaved,
    dismiss: (records: TaskCentreRecord[]) => {
      const latest = snapshot(key);
      // An individual dismissal after Clear all must survive Undo.
      const revisions = dismissActivity(readActivityVisibility(latest.value), records);
      const individuallyHidden = new Set(records.filter(canDismissActivity).map(activityRevision));
      const retainedUndo = latest.undo
        ? { ...latest.undo, added: latest.undo.added.filter((revision) => !individuallyHidden.has(revision)) }
        : undefined;
      update(revisions, retainedUndo?.added.length ? retainedUndo : undefined);
    },
    clear: (records: TaskCentreRecord[]) => {
      const latest = snapshot(key);
      const next = clearCompletedActivity(readActivityVisibility(latest.value), records);
      if (!next.undo.added.length) return;
      const previous = latest.undo && latest.undo.expiresAt > Date.now() ? latest.undo.added : [];
      update(next.state, { ...next.undo, added: [...previous, ...next.undo.added] });
    },
    undo: () => {
      const latest = snapshot(key);
      if (latest.undo && latest.undo.expiresAt > Date.now()) update(undoCompletedActivity(readActivityVisibility(latest.value), latest.undo));
    },
  };
}
