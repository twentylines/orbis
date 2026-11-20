import type { TaskRecord } from '@runtipi/common/schemas/task-history';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import type { IncomingRestoreRequest, OutgoingRestoreRequest, RestoreRequests } from '@/modules/host-transfer/receiver-request-api';
import { restoreExportStage } from '@/modules/host-transfer/receiver-request-api';
import { capturePresentation } from '@/modules/time-machine/capture-presentation';
import { isSetupFailureTask } from './task-centre-records';
import { taskLabels, taskStates, taskIsActive } from './tasks';
import type { SystemActivityRecord } from './system-task-activity';
import { taskProgressLabel } from './task-progress';

export type TaskCentreBucket = 'active' | 'review' | 'recent';
export type TaskCentreOutcome = 'active' | 'review' | 'succeeded' | 'failed' | 'interrupted' | 'unconfirmed' | 'cancelled';
export type TaskCentreView = 'all' | 'active' | 'review' | 'history';
export type TaskCentreRecord = {
  key: string;
  title: string;
  source: string;
  sourceKey: string;
  status: string;
  outcome: TaskCentreOutcome;
  bucket: TaskCentreBucket;
  time?: number;
  startedAt?: number;
  finishedAt?: number;
  phase?: string;
  message?: string;
  progress?: { completed: number; total?: number | null };
  stale?: boolean;
  dismissed?: boolean;
  task?: TaskRecord;
  system?: SystemActivityRecord;
  incoming?: IncomingRestoreRequest;
  outgoing?: OutgoingRestoreRequest;
  actions: { label: string; path: string }[];
};
export type TaskCentreGroup = TaskCentreRecord & { attempts: TaskCentreRecord[] };
const timestamp = (value: string | null) => (value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined);
const systemSources = {
  exports: 'Settings backups',
  imports: 'Settings imports',
  restore: 'Settings restore',
  core: 'Orbis updates',
  points: 'Time Machine',
};
const dateValue = (record: TaskCentreRecord) => record.time ?? 0;
const byTime = (left: TaskCentreRecord, right: TaskCentreRecord) => dateValue(right) - dateValue(left) || left.key.localeCompare(right.key);

function systemOutcome(record: SystemActivityRecord): TaskCentreOutcome {
  if (record.bucket === 'active') return 'active';
  if (record.state === 'failed' || /failed/i.test(record.status)) return 'failed';
  if (record.state === 'interrupted') return 'interrupted';
  if (['cancelled', 'rejected', 'expired'].includes(record.state ?? '')) return 'cancelled';
  return record.bucket === 'review' ? 'review' : 'succeeded';
}

export function taskCentreRecords({
  tasks,
  names = new Map(),
  system = [],
  capture,
  captureFailed,
  requests,
  now = Date.now(),
}: {
  tasks: TaskRecord[];
  names?: Map<string, string>;
  system?: SystemActivityRecord[];
  capture?: TimeMachinePoint | null;
  captureFailed?: boolean;
  requests?: RestoreRequests;
  now?: number;
}): TaskCentreRecord[] {
  const records: TaskCentreRecord[] = tasks.map((task) => {
    const setup = isSetupFailureTask(task) ? task : null;
    const source = names.get(task.appUrn) ?? task.displayName ?? task.appUrn.split(':')[0] ?? 'Application';
    const [appId, storeId] = task.appUrn.split(':');
    const bucket = taskIsActive(task) ? 'active' : task.status === 'succeeded' || setup?.setupFailureDismissed ? 'recent' : 'review';
    return {
      key: `app:${task.id}`,
      title: `${setup ? (setup.setupFailureOutcome === 'preferences-save-failed' ? 'Save' : 'Capture') : taskLabels[task.action]} ${source}`,
      source,
      sourceKey: task.appUrn,
      status: `${taskProgressLabel(task) ?? taskStates[task.status]}${setup?.setupFailureDismissed ? ' · dismissed' : ''}`,
      bucket,
      outcome: task.status === 'running' || task.status === 'queued' ? 'active' : task.status,
      time: timestamp(task.finishedAt) ?? timestamp(task.updatedAt),
      startedAt: timestamp(task.startedAt),
      finishedAt: timestamp(task.finishedAt),
      task,
      dismissed: setup?.setupFailureDismissed,
      message: setup?.setupFailureReason,
      actions: setup
        ? [{ label: 'Review Time Machine', path: '/settings?tab=time-machine' }]
        : [
            {
              label: 'View application',
              path:
                storeId === '_user'
                  ? `/apps/${encodeURIComponent(appId ?? '')}`
                  : `/apps/${encodeURIComponent(storeId ?? '')}/${encodeURIComponent(appId ?? '')}`,
            },
            { label: 'Orbis logs', path: '/settings?tab=logs' },
          ],
    };
  });
  for (const record of system)
    records.push({
      key: record.key,
      title: record.title,
      source: systemSources[record.feed],
      sourceKey: `system:${record.feed}`,
      status: record.status,
      bucket: record.bucket,
      outcome: systemOutcome(record),
      time: record.time,
      phase: record.phase,
      message: record.message,
      ...(record.completed !== undefined ? { progress: { completed: record.completed, total: record.total } } : {}),
      stale: record.stale,
      system: record,
      actions: [{ label: record.action, path: record.path }],
    });
  if (capture) {
    const presentation = capturePresentation(capture, captureFailed);
    const key = `point:${capture.id}`;
    const index = records.findIndex((record) => record.key === key);
    const record: TaskCentreRecord = {
      key,
      title: 'Time Machine capture',
      source: 'Time Machine',
      sourceKey: 'system:points',
      time: capture.createdAt,
      status: captureFailed ? 'Status unavailable' : capture.status === 'capturing' ? 'Capturing' : presentation.title,
      bucket: capture.status === 'capturing' ? 'active' : capture.status === 'sealed' ? 'recent' : 'review',
      outcome: capture.status === 'capturing' ? 'active' : capture.status === 'sealed' ? 'succeeded' : capture.status,
      phase: presentation.stage,
      message: capture.issue?.message,
      stale: captureFailed,
      progress: { completed: capture.completedBytes, total: capture.totalBytes },
      actions: [{ label: 'Open Time Machine', path: '/settings?tab=time-machine' }],
    };
    if (index >= 0) records[index] = record;
    else records.push(record);
  }
  for (const direction of ['incoming', 'outgoing'] as const)
    for (const request of requests?.[direction] ?? []) {
      const stopped = ['complete', 'rejected', 'cancelled', 'expired', 'failed'].includes(request.status);
      const expired = !stopped && request.expiresAt <= now;
      const review = request.status === 'awaiting-approval' || (direction === 'outgoing' && request.status === 'complete');
      const statuses: Record<string, string> = {
        'awaiting-approval': 'Approval needed',
        approving: 'Approving',
        exporting: 'Creating encrypted backup',
        ready: 'Backup ready',
        sending: 'Sending backup',
        complete: direction === 'outgoing' ? 'Ready for review' : 'Transfer completed',
        failed: 'Transfer failed',
        rejected: 'Rejected',
        cancelled: 'Cancelled',
        expired: 'Expired',
        'awaiting-source-approval': 'Waiting for source approval',
        'checking-approval': 'Checking approval',
        'source-exporting': 'Source is creating backup',
        receiving: 'Receiving backup',
      };
      records.push({
        key: `${direction}:${request.id}`,
        title: direction === 'incoming' ? 'Export backup to another server' : 'Receive backup from another server',
        source: 'Server transfer',
        sourceKey: 'system:transfers',
        status: expired ? 'Expired · outcome unconfirmed' : (statuses[request.status] ?? 'Status not confirmed'),
        bucket: expired || ['failed', 'rejected', 'expired'].includes(request.status) || review ? 'review' : stopped ? 'recent' : 'active',
        outcome: expired
          ? 'unconfirmed'
          : ['rejected', 'expired', 'cancelled'].includes(request.status)
            ? 'cancelled'
            : request.status === 'failed'
              ? 'failed'
              : review
                ? 'review'
                : stopped
                  ? 'succeeded'
                  : 'active',
        phase: request.exportProgress ? restoreExportStage(request.exportProgress.stage) : undefined,
        progress: request.exportProgress
          ? { completed: request.exportProgress.completedBytes, total: request.exportProgress.totalBytes }
          : { completed: request.completedBytes, total: request.totalBytes },
        ...(direction === 'incoming' ? { incoming: request as IncomingRestoreRequest } : { outgoing: request as OutgoingRestoreRequest }),
        actions: direction === 'incoming' ? [] : [{ label: 'Review server transfer', path: '/settings?tab=backups' }],
      });
    }
  return [...new Map(records.map((record) => [record.key, record])).values()].sort(byTime);
}

export function groupTaskCentreAttempts(records: TaskCentreRecord[]): TaskCentreGroup[] {
  const groups: TaskCentreGroup[] = [];
  const previous = new Map<string, TaskCentreGroup>();
  for (const record of [...records].sort(byTime)) {
    const operation = record.task && !isSetupFailureTask(record.task) ? `${record.task.appUrn}:${record.task.action}` : null;
    const group = operation ? previous.get(operation) : undefined;
    if (
      operation &&
      record.outcome === 'failed' &&
      group?.outcome === 'failed' &&
      record.bucket === group.bucket &&
      record.time &&
      group.time &&
      group.time - record.time <= 10 * 60_000
    ) {
      group.attempts.push(record);
    } else {
      const next = { ...record, attempts: [record] };
      groups.push(next);
      if (operation) previous.set(operation, next);
    }
  }
  return groups;
}

export type TaskCentreFilters = { view: TaskCentreView; query: string; source: string; outcome: string; days: string };
export function filterTaskCentreRecords(records: TaskCentreRecord[], filters: TaskCentreFilters, now = Date.now()) {
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return records.filter((record) => {
    if (filters.view === 'history' ? record.bucket === 'active' : filters.view !== 'all' && record.bucket !== filters.view) return false;
    if (record.dismissed && filters.view !== 'history') return false;
    if (filters.source !== 'all' && record.sourceKey !== filters.source) return false;
    if (filters.outcome !== 'all' && record.outcome !== filters.outcome) return false;
    if (filters.days !== 'all' && (!record.time || record.time < now - Number(filters.days) * 86_400_000)) return false;
    const text = [record.title, record.source, record.status, record.phase, record.message, record.key, record.task?.appUrn]
      .join(' ')
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function shortTaskTime(time?: number, now = Date.now()) {
  if (!time || !Number.isFinite(time)) return 'Time not reported';
  const date = new Date(time);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const day = sameDay
    ? 'Today'
    : date.toDateString() === yesterday.toDateString()
      ? 'Yesterday'
      : date.toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
        });
  return `${day}, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export function taskDuration(record: TaskCentreRecord, now = Date.now()) {
  if (!record.startedAt) return null;
  const end = record.finishedAt ?? (record.bucket === 'active' && !record.stale ? now : null);
  if (end === null || end < record.startedAt) return null;
  const seconds = Math.floor((end - record.startedAt) / 1000);
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
