import type { TaskRecord } from '@runtipi/common/schemas/task-history';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { IconActivity, IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { Link } from 'react-router';
import { capturePresentation } from '@/modules/time-machine/capture-presentation';
import { formatBackupBytes } from '@/modules/system-backups/contracts';
import { taskIsActive, taskLabels, taskStates } from './tasks';
import { isSetupFailureTask } from './task-centre-records';
import { SourceRestoreRequests } from '@/modules/host-transfer/source-restore-requests';
import type { useRestoreRequests } from '@/modules/host-transfer/receiver-request-context';
import { restoreRequestStopped } from '@/modules/host-transfer/receiver-request-api';
import { systemActivitySort, type SystemActivitySnapshot } from './system-task-activity';
import { SystemActivityNotices, SystemActivityRow } from './system-task-activity-view';

export function taskPanelPosition(anchor: { left: number; right: number; bottom: number }, width: number, viewportWidth: number) {
  return { left: Math.max(16, Math.min((anchor.left + anchor.right - width) / 2, viewportWidth - width - 16)), top: anchor.bottom + 8 };
}

export function taskPanelGroups(tasks: TaskRecord[]) {
  const ordered = [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return [
    { title: 'Active operations', tasks: ordered.filter(taskIsActive) },
    { title: 'Needs review', tasks: ordered.filter((task) => ['failed', 'interrupted', 'unconfirmed'].includes(task.status)) },
    { title: 'Recent activity', tasks: ordered.filter((task) => !taskIsActive(task)) },
  ];
}

type TaskPanelProps = {
  tasks: TaskRecord[];
  names?: Map<string, string>;
  dismissSetupFailure?: (id: string) => void;
  restoreRequests?: ReturnType<typeof useRestoreRequests>;
  systemActivity?: SystemActivitySnapshot;
  loading: boolean;
  failed: boolean;
  storageUnavailable: boolean;
  capture?: TimeMachinePoint | null;
  captureFailed: boolean;
  pendingRequests: number;
  criticalUpdate: boolean;
  retry: () => void;
  close: () => void;
};

export function DesktopTaskPanel({
  tasks,
  names = new Map(),
  dismissSetupFailure,
  restoreRequests,
  systemActivity,
  loading,
  failed,
  storageUnavailable,
  capture,
  captureFailed,
  pendingRequests,
  criticalUpdate,
  retry,
  close,
}: TaskPanelProps) {
  const groups = taskPanelGroups(tasks);
  const presentation = capture ? capturePresentation(capture, captureFailed) : null;
  const incoming =
    restoreRequests?.snapshot.incoming.filter((request) => !restoreRequestStopped.has(request.status) && request.expiresAt > Date.now()) ?? [];
  const transferring = incoming.some((request) => request.status !== 'awaiting-approval');
  return (
    <>
      {systemActivity ? <SystemActivityNotices activity={systemActivity} /> : null}
      {systemActivity?.records.some((record) => record.feed === 'restore') ? (
        <section className="desktop-task-panel-group" aria-label="Latest settings restore">
          <h3>Latest settings restore</h3>
          <ol>
            {systemActivity.records
              .filter((record) => record.feed === 'restore')
              .map((record) => (
                <SystemActivityRow key={record.key} record={record} close={close} />
              ))}
          </ol>
        </section>
      ) : null}
      {loading ? <output>Reading operations…</output> : null}
      {failed ? (
        <div className="desktop-task-panel-notice">
          <p aria-live="polite">Task history could not be refreshed. Shown records are the last reported state.</p>
          <button type="button" onClick={retry}>
            Retry task history
          </button>
        </div>
      ) : null}
      {storageUnavailable ? (
        <p className="desktop-task-panel-notice">History storage is unavailable. Recent records may be lost on restart.</p>
      ) : null}
      {captureFailed && !capture ? (
        <p className="desktop-task-panel-notice">Capture status could not be refreshed. Check Time Machine before starting another capture.</p>
      ) : null}
      {criticalUpdate ? (
        <Link className="desktop-task-panel-notice desktop-task-panel-action" to="/updates" onClick={close}>
          Review critical Orbis update
        </Link>
      ) : null}
      {pendingRequests && !incoming.length ? (
        <Link className="desktop-task-panel-notice desktop-task-panel-action" to="/tasks" onClick={close}>
          Review {pendingRequests} restore request{pendingRequests === 1 ? '' : 's'}
        </Link>
      ) : null}
      <SourceRestoreRequests />
      {capture && presentation ? (
        <section className="desktop-task-panel-capture" aria-label="Time Machine capture">
          <strong>{presentation.title}</strong>
          <p>{presentation.stage}</p>
          {presentation.percentage !== undefined ? (
            <>
              <progress aria-label="Capture progress" max={100} value={presentation.percentage} />
              <small>
                {presentation.percentage}% · {formatBackupBytes(capture.completedBytes)} of {formatBackupBytes(capture.totalBytes ?? 0)} reported
              </small>
            </>
          ) : (
            <small>{captureFailed ? 'Completion has not been confirmed.' : 'The server has not reported a total size.'}</small>
          )}
          <Link className="desktop-task-panel-action" to="/settings?tab=time-machine" onClick={close}>
            Open Time Machine
          </Link>
        </section>
      ) : null}
      {groups.map((group, groupIndex) => {
        const bucket = (['active', 'review', 'recent'] as const)[groupIndex];
        const rows = [
          ...group.tasks.map((task) => ({ task, system: undefined, time: Date.parse(task.updatedAt) })),
          ...(systemActivity?.records
            .filter((record) => record.bucket === bucket && record.feed !== 'restore')
            .map((system) => ({ task: undefined, system, time: system.time })) ?? []),
        ].sort(systemActivitySort);
        return (
          <section className="desktop-task-panel-group" key={group.title} aria-label={group.title}>
            <h3>
              {group.title}
              {rows.length ? <span>{rows.length}</span> : null}
            </h3>
            <ol>
              {rows.slice(0, 3).map(({ task, system }) => {
                if (system) return <SystemActivityRow key={system.key} record={system} close={close} />;
                if (!task) return null;
                const active = taskIsActive(task);
                const review = !active && task.status !== 'succeeded';
                const setupFailure = isSetupFailureTask(task) ? task : null;
                return (
                  <li key={task.id} data-status={task.status}>
                    <span className="desktop-task-panel-symbol" aria-hidden="true">
                      {active ? <IconActivity size={18} /> : review ? <IconAlertTriangle size={18} /> : <IconCheck size={18} />}
                    </span>
                    <div className="desktop-task-panel-record">
                      <strong>
                        {setupFailure
                          ? setupFailure.setupFailureOutcome === 'preferences-save-failed'
                            ? 'Save'
                            : 'Capture'
                          : taskLabels[task.action]}{' '}
                        {names.get(task.appUrn) ?? task.displayName ?? task.appUrn.split(':')[0]}
                      </strong>
                      <span>
                        {taskStates[task.status]}
                        {failed ? ' · last reported' : ''}
                      </span>
                      <time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString()}</time>
                      {task.status === 'unconfirmed' || task.status === 'interrupted' ? (
                        <small>Check the app before retrying; the outcome is not confirmed.</small>
                      ) : null}
                      <div className="desktop-task-panel-links">
                        <Link to={setupFailure ? '/settings?tab=time-machine' : `/tasks?app=${encodeURIComponent(task.appUrn)}`} onClick={close}>
                          {setupFailure ? 'Review Time Machine' : 'View app tasks'}
                        </Link>
                        {review ? (
                          <Link to="/settings?tab=logs" onClick={close}>
                            Orbis logs
                          </Link>
                        ) : null}
                        {setupFailure && dismissSetupFailure ? (
                          <button type="button" onClick={() => dismissSetupFailure(task.id)}>
                            Dismiss
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
            {rows.length ? null : (
              <p className="desktop-task-panel-empty">
                {loading || systemActivity?.loading
                  ? 'Reading tasks…'
                  : failed
                    ? 'Task status unavailable'
                    : systemActivity?.incomplete
                      ? groupIndex === 0
                        ? 'No active tasks in available records'
                        : groupIndex === 1
                          ? 'No attention items in available records'
                          : 'No recent activity in available records'
                      : groupIndex === 0
                        ? capture || transferring || systemActivity?.records.some((record) => record.feed === 'restore' && record.bucket === 'active')
                          ? 'No other active tasks'
                          : 'No active tasks'
                        : groupIndex === 1
                          ? pendingRequests ||
                            criticalUpdate ||
                            systemActivity?.records.some((record) => record.feed === 'restore' && record.bucket === 'review')
                            ? 'No other tasks need attention'
                            : 'Nothing needs attention'
                          : systemActivity?.records.some((record) => record.feed === 'restore' && record.bucket === 'recent')
                            ? 'No other recent activity'
                            : 'No recent activity'}
              </p>
            )}
            {rows.length > 3 ? <small>Showing the latest 3 of {rows.length}.</small> : null}
          </section>
        );
      })}
    </>
  );
}
