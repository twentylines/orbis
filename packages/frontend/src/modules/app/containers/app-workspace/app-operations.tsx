import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { useAppContext } from '@/context/app-context';
import { useTasks, taskLabels, taskStates } from '@/desktop/tasks';
import { useWindowVisible } from '@/desktop/window-visibility';
import { installRecoveryReviewSchema, type InstallRecoveryReview } from '@runtipi/common/schemas/install-recovery-review';
import { useQuery } from '@tanstack/react-query';
import { type } from 'arktype';
import { Link } from 'react-router';
import { taskProgressLabel } from '@/desktop/task-progress';

const phaseLabels = { provisional: 'Provisional receipt', pending: 'Pending receipt', spent: 'Consumed receipt' };
const reservationLabels = {
  unconfirmed: 'Unconfirmed database reservation',
  matches: 'Matching database reservation',
  missing: 'Database reservation missing',
  changed: 'Database reservation changed',
};

export function AppInstallRecoveryNotice({ review, stale = false }: { review: InstallRecoveryReview | undefined; stale?: boolean }) {
  if (!review || review.state === 'clear') return null;
  if (stale || review.state === 'unverified') return <output>Install hold details could not be verified.</output>;
  if (review.state === 'busy') return <output>Install review will refresh when the current operation finishes.</output>;
  if (review.state !== 'held') return null;

  const { requestId, phase, reservation } = review.hold;
  return (
    <Alert variant="warning" role="status">
      <AlertDescription>
        <h4>Interrupted install</h4>
        <p>To clear this hold, Orbis must verify that the app is stopped on the Docker host and that retrying can safely use any retained data.</p>
        <dl>
          <div>
            <dt>Receipt</dt>
            <dd>{phaseLabels[phase]}</dd>
          </div>
          <div>
            <dt>Reservation</dt>
            <dd>{reservationLabels[reservation]}</dd>
          </div>
          <div>
            <dt>Request</dt>
            <dd>{requestId}</dd>
          </div>
        </dl>
      </AlertDescription>
    </Alert>
  );
}

export function AppOperations({ appUrn }: { appUrn: string }) {
  const { user } = useAppContext();
  const visible = useWindowVisible();
  const installReview = useQuery({
    enabled: visible && user.operator,
    queryKey: ['app-install-recovery-review', user.id, appUrn],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/app-lifecycle/${encodeURIComponent(appUrn)}/install-recovery`, {
        credentials: 'include',
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Install review is unavailable');
      const parsed = installRecoveryReviewSchema(await response.json());
      if (parsed instanceof type.errors || parsed.appUrn !== appUrn) throw new Error('Install review returned an invalid response');
      return parsed;
    },
    refetchInterval: 5000,
    staleTime: 4000,
    refetchIntervalInBackground: false,
  });
  const history = useTasks();
  const records = history.data?.tasks.filter((task) => task.appUrn === appUrn).slice(0, 10) ?? [];
  return (
    <section className="app-operations" aria-label="Application operations">
      <header>
        <h3>Recent operations</h3>
        <Link to={`/tasks?app=${encodeURIComponent(appUrn)}`}>Task centre</Link>
      </header>
      {user.operator ? <AppInstallRecoveryNotice review={installReview.data} stale={installReview.isError} /> : null}
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
      {!history.isPending && !history.isError && !records.length ? <p>No recorded operations for this app.</p> : null}
      <ol>
        {records.map((task) => (
          <li key={task.id} data-status={task.status}>
            <details>
              <summary>
                <strong>{taskLabels[task.action]}</strong>
                <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString()}</time>
                <span>{taskProgressLabel(task) ?? taskStates[task.status]}</span>
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
