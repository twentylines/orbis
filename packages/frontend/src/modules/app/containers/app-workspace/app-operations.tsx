import { useTasks, taskLabels, taskStates } from '@/desktop/tasks';
import { IconArrowUpRight } from '@tabler/icons-react';
import { Link } from 'react-router';

export function AppOperations({ appUrn }: { appUrn: string }) {
  const history = useTasks();
  const records = history.data?.tasks.filter((task) => task.appUrn === appUrn).slice(0, 10) ?? [];
  return (
    <section className="app-operations" aria-label="Application operations">
      <header>
        <h3>Recent operations</h3>
        <Link to={`/tasks?app=${encodeURIComponent(appUrn)}`}>
          Task centre <IconArrowUpRight size={16} aria-hidden="true" />
        </Link>
      </header>
      {history.isPending ? <p>Reading operation history…</p> : null}
      {history.isError ? (
        <p role="alert">
          Operation history could not be refreshed. Previous records may be stale.{' '}
          <button type="button" onClick={() => history.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {history.data?.storage === 'unavailable' ? <p role="alert">History storage is unavailable. New records may be lost on restart.</p> : null}
      {!history.isPending && !history.isError && !records.length ? <p>No retained operations for this application.</p> : null}
      <ol>
        {records.map((task) => (
          <li key={task.id} data-status={task.status}>
            <details>
              <summary>
                <strong>{taskLabels[task.action]}</strong>
                <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString()}</time>
                <span>{taskStates[task.status]}</span>
              </summary>
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
              <Link to="/settings?tab=logs">Open instance logs</Link>
            </details>
          </li>
        ))}
      </ol>
      {history.data ? (
        <p className="app-panel-caption">Last checked {new Date(history.data.sampledAt).toLocaleTimeString()} · Latest 10 retained requests</p>
      ) : null}
    </section>
  );
}
