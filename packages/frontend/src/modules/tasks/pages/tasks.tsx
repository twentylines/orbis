import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { IconActivity, IconArrowUpRight, IconCheck, IconClock, IconAlertTriangle } from '@tabler/icons-react';
import { useTasks, taskLabels, taskStates, taskIsActive } from '@/desktop/tasks';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { useQuery } from '@tanstack/react-query';
import type { TaskRecord } from '@runtipi/common/schemas';
import './tasks.css';

export default function Tasks() {
  const tasks = useTasks();
  const apps = useQuery(getInstalledAppsOptions());
  const [filter, setFilter] = useState('all');
  const [params, setParams] = useSearchParams();
  const requestedApp = params.get('app');
  const appScope = requestedApp && requestedApp.length <= 180 && /^[^:]+:[^:]+$/.test(requestedApp) ? requestedApp : null;
  const records = (tasks.data?.tasks ?? []).filter((task) => !appScope || task.appUrn === appScope);
  const names = new Map(apps.data?.installed.map(({ info }) => [info.urn, info.name]));
  const active = records.filter(taskIsActive);
  const review = records.filter((task) => ['failed', 'interrupted', 'unconfirmed'].includes(task.status));
  const visible = records.filter(
    (task) =>
      filter === 'all' || (filter === 'active' ? taskIsActive(task) : filter === 'review' ? review.includes(task) : task.status === 'succeeded'),
  );
  const explain = (task: TaskRecord) =>
    task.status === 'interrupted'
      ? 'The server restarted before the outcome was confirmed. Check the app and instance logs before retrying.'
      : task.status === 'unconfirmed'
        ? 'The queue did not confirm this request. It may still be running; check the app before retrying.'
        : task.status === 'failed'
          ? 'Operation failed. Check Orbis logs for details.'
          : task.status === 'queued'
            ? 'Waiting for a lifecycle worker or another operation on this app.'
            : task.status === 'running'
              ? 'Operation running. Check Orbis logs for output.'
              : 'Operation completed. Check the app’s health separately.';

  return (
    <div className="task-centre">
      {appScope ? (
        <div className="task-scope">
          <span>
            Application: <strong>{names.get(appScope) ?? appScope}</strong>
          </span>
          <button
            type="button"
            onClick={() =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.delete('app');
                return next;
              })
            }
          >
            Show all applications
          </button>
        </div>
      ) : null}
      <div className="task-summary">
        <span className={`task-summary-orbit ${active.length ? 'is-busy' : ''}`} aria-hidden="true">
          <IconActivity size={30} stroke={1.3} />
        </span>
        <div>
          <h2>
            {tasks.data
              ? active.length
                ? `${active.length} operation${active.length === 1 ? '' : 's'} in progress`
                : 'No operations in progress'
              : tasks.isError
                ? 'Operation history unavailable'
                : 'Reading operations'}
          </h2>
          {review.length > 0 ? (
            <p>
              {review.length} operation{review.length === 1 ? ' needs' : 's need'} review.
            </p>
          ) : null}
        </div>
        <span className="task-retention">
          Up to {tasks.data?.limit ?? 300} operations · {tasks.data?.retentionDays ?? 30} days
        </span>
      </div>
      {tasks.isError ? (
        <p className="workspace-message" role="alert">
          Task history could not be refreshed. Previous records may be stale.{' '}
          <button type="button" onClick={() => tasks.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {tasks.data?.storage === 'unavailable' ? (
        <p className="workspace-message" role="alert">
          History storage is unavailable. New records are held in memory and may be lost on restart.
        </p>
      ) : null}
      <div className="task-toolbar">
        <fieldset>
          <legend className="visually-hidden">Filter operations</legend>
          {[
            ['all', 'All'],
            ['active', 'Active'],
            ['review', 'Needs review'],
            ['completed', 'Completed'],
          ].map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value ?? 'all')}>
              {label}
            </button>
          ))}
        </fieldset>
        <span>{tasks.data ? `Checked ${new Date(tasks.data.sampledAt).toLocaleTimeString()}` : 'Loading history'}</span>
      </div>
      {tasks.isPending ? <p>Loading operations…</p> : null}
      {!tasks.isPending && !visible.length ? (
        <div className="task-empty">
          <IconClock size={32} stroke={1.4} aria-hidden="true" />
          <h2>{filter === 'all' ? 'No recorded operations' : 'No matching operations'}</h2>
          {filter === 'all' ? <p>App installs, starts, stops, updates, backups and restores are recorded here.</p> : null}
        </div>
      ) : null}
      <ol className="task-list">
        {visible.map((task) => {
          const [appId, storeId] = task.appUrn.split(':');
          return (
            <li key={task.id} data-status={task.status}>
              <details>
                <summary>
                  <span className="task-symbol" aria-hidden="true">
                    {taskIsActive(task) ? (
                      <IconActivity size={20} />
                    ) : task.status === 'succeeded' ? (
                      <IconCheck size={20} />
                    ) : (
                      <IconAlertTriangle size={20} />
                    )}
                  </span>
                  <span className="task-identity">
                    <strong>
                      {taskLabels[task.action]} <span>{names.get(task.appUrn) ?? appId}</span>
                    </strong>
                    <small>
                      {storeId} · <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString()}</time>
                    </small>
                  </span>
                  <span className="task-state">{taskStates[task.status]}</span>
                  <IconArrowUpRight className="task-disclosure" size={18} aria-hidden="true" />
                </summary>
                <div className="task-details">
                  <p>{explain(task)}</p>
                  <dl>
                    <div>
                      <dt>Started</dt>
                      <dd>{task.startedAt ? new Date(task.startedAt).toLocaleString() : 'Not confirmed'}</dd>
                    </div>
                    <div>
                      <dt>Finished</dt>
                      <dd>{task.finishedAt ? new Date(task.finishedAt).toLocaleString() : 'Not confirmed'}</dd>
                    </div>
                    <div>
                      <dt>Request</dt>
                      <dd>{task.id}</dd>
                    </div>
                  </dl>
                  <div className="task-links">
                    <Link to={names.has(task.appUrn) ? `/apps/${encodeURIComponent(storeId ?? '')}/${encodeURIComponent(appId ?? '')}` : '/apps'}>
                      {names.has(task.appUrn) ? 'Open application' : 'View applications'}
                    </Link>
                    <Link to="/settings?tab=logs">Open Orbis logs</Link>
                  </div>
                </div>
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
