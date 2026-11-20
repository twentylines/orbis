import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { dismissSetupFailureTask, mergeSetupCaptureTasks, setupFailureTasks, type SetupFailureTask } from '@/components/welcome/setup-capture-task';
import type { TaskRecord } from '@runtipi/common/schemas/task-history';

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', notify);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', notify);
  };
}
const inactive = () => () => undefined;
const empty = () => '[]';

export function isSetupFailureTask(task: TaskRecord | SetupFailureTask): task is SetupFailureTask {
  return 'setupFailureOutcome' in task;
}

export function useTaskCentreRecords(serverRecords: TaskRecord[], ownerId: number, enabled = true) {
  const snapshot = useCallback(() => JSON.stringify(setupFailureTasks(ownerId, undefined, true)), [ownerId]);
  const serialized = useSyncExternalStore(enabled ? subscribe : inactive, enabled ? snapshot : empty, empty);
  const failures = useMemo(() => JSON.parse(serialized) as SetupFailureTask[], [serialized]);
  const apps = useQuery({ ...getInstalledAppsOptions(), enabled });
  const records = useMemo(() => mergeSetupCaptureTasks(serverRecords, failures), [serverRecords, failures]);
  const names = useMemo(() => new Map(apps.data?.installed.map(({ info }) => [info.urn, info.name])), [apps.data]);
  const dismiss = (id: string) => {
    if (dismissSetupFailureTask(ownerId, id)) notify();
  };
  return { records, names, dismiss };
}
