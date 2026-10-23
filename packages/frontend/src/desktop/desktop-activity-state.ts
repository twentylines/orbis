import type { TaskRecord } from '@runtipi/common/schemas';
import { coreUpdateTitle, coreWatchIsActive, type CoreUpdateWatch } from './core-update-state';

export type PackageActivityJob = { id: string; state: string; operationCount?: number; message?: string };
export type DesktopActivityItem = {
  id: string;
  kind: 'app' | 'core' | 'packages';
  title: string;
  detail: string;
  state: string;
  appUrn?: string;
};
export type DesktopActivity = {
  title: string;
  detail: string;
  appUrn?: string;
  kind: DesktopActivityItem['kind'];
  count: number;
  items: DesktopActivityItem[];
};
const verbs: Record<TaskRecord['action'], string> = {
  start: 'Starting',
  stop: 'Stopping',
  install: 'Installing',
  uninstall: 'Uninstalling',
  reset: 'Resetting',
  restart: 'Restarting',
  generate_env: 'Configuring',
  backup: 'Backing up',
  restore: 'Restoring',
  update: 'Updating',
};

export function desktopActivity(
  tasks: readonly TaskRecord[],
  names: ReadonlyMap<string, string>,
  watch: CoreUpdateWatch | null,
  packageJob: PackageActivityJob | null,
): DesktopActivity | null {
  const activeTasks = tasks
    .filter((task) => task.status === 'queued' || task.status === 'running')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  const name = (task: TaskRecord) => task.displayName || names.get(task.appUrn) || task.appUrn.split(':')[0] || 'Application';
  const items: DesktopActivityItem[] = activeTasks.map((task) => ({
    id: task.id,
    kind: 'app',
    title: `${verbs[task.action]} ${name(task)}`,
    detail: task.status === 'queued' ? 'Queued' : 'In progress',
    state: task.status,
    appUrn: task.appUrn,
  }));
  let summary: Omit<DesktopActivity, 'items'> | null = null;
  const latest = activeTasks[0];
  if (latest) {
    const group = activeTasks.filter((task) => task.action === latest.action);
    const appCount = new Set(group.map((task) => task.appUrn)).size;
    const queued = group.every((task) => task.status === 'queued');
    summary = {
      title: `${verbs[latest.action]}${queued ? ' · Queued' : ''}`,
      detail: appCount === 1 ? name(latest) : `${appCount} apps${group.length > appCount ? ` · ${group.length} operations` : ''}`,
      appUrn: appCount === 1 ? latest.appUrn : undefined,
      kind: 'app',
      count: items.length,
    };
  }
  if (packageJob && ['queued', 'running'].includes(packageJob.state)) {
    const count = packageJob.operationCount;
    const title = count ? `Updating ${count} system package${count === 1 ? '' : 's'}` : 'Updating system packages';
    items.unshift({
      id: packageJob.id,
      kind: 'packages',
      title,
      detail: packageJob.message || (packageJob.state === 'queued' ? 'Queued' : 'In progress'),
      state: packageJob.state,
    });
    summary = { title, detail: packageJob.state === 'queued' ? 'Queued' : 'Installing system updates', kind: 'packages', count: items.length };
  }
  if (watch && coreWatchIsActive(watch)) {
    const title = coreUpdateTitle(watch.phase);
    items.unshift({ id: watch.id, kind: 'core', title, detail: watch.message, state: watch.phase });
    summary = { title, detail: watch.message, kind: 'core', count: items.length };
  }
  return summary ? { ...summary, count: items.length, items } : null;
}
