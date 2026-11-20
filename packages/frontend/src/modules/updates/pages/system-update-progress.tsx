import { DisclosureIndicator } from '@/components/ui/DisclosureIndicator/DisclosureIndicator';
import { Link } from 'react-router';
import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import { UpdateTerminal } from './update-terminal';

type PackageJob = {
  id: string;
  kind?: 'refresh';
  state: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted';
  message?: string;
  startedAt?: number;
  finishedAt?: number;
  rebootRequired?: boolean;
  operationCount?: number;
  output?: { text: string; bytes: number; truncated: boolean; updatedAt: number | null };
};

export function SystemUpdateProgress({ job }: { job: PackageJob }) {
  const busy = job.state === 'queued' || job.state === 'running';
  const checking = job.kind === 'refresh';
  const complete = job.state === 'complete';
  const title =
    job.state === 'queued'
      ? 'Waiting to start'
      : job.state === 'running'
        ? checking
          ? 'Checking for updates'
          : 'Installing system updates'
        : complete
          ? checking
            ? 'Update check complete'
            : 'System update complete'
          : job.state === 'interrupted'
            ? 'System update interrupted'
            : checking
              ? 'Update check failed'
              : 'System update needs attention';
  return (
    <section className="system-update-progress" data-state={job.state} aria-label="System update progress">
      {complete ? null : (
        <header>
          <OrbisLogo size={34} />
          <div>
            <h3 aria-live="polite">{title}</h3>
            <p>{job.message || (busy ? 'The host is working. This page can be closed.' : 'The recorded package operation has finished.')}</p>
          </div>
        </header>
      )}
      {busy ? <progress aria-label={title} /> : null}
      {job.rebootRequired ? <p>Restart required to finish applying installed updates.</p> : null}
      <details>
        <summary>
          <DisclosureIndicator size={17} />
          <span aria-live="polite">{complete ? title : busy ? 'View live output' : 'View operation details'}</span>
        </summary>
        {complete && job.message ? <p>{job.message}</p> : null}
        {(job.operationCount !== undefined && !checking) || job.startedAt || job.finishedAt ? (
          <dl>
            {!checking && job.operationCount !== undefined ? (
              <div>
                <dt>Planned changes</dt>
                <dd>{job.operationCount}</dd>
              </div>
            ) : null}
            {job.startedAt ? (
              <div>
                <dt>Started</dt>
                <dd>
                  <time dateTime={new Date(job.startedAt * 1000).toISOString()}>{new Date(job.startedAt * 1000).toLocaleString()}</time>
                </dd>
              </div>
            ) : null}
            {job.finishedAt ? (
              <div>
                <dt>Finished</dt>
                <dd>
                  <time dateTime={new Date(job.finishedAt * 1000).toISOString()}>{new Date(job.finishedAt * 1000).toLocaleString()}</time>
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <UpdateTerminal output={job.output} state={job.state} />
      </details>
    </section>
  );
}

export function UpdateRequestError({ error }: { error: Error }) {
  const captureHeld = /a protected controller capture requires completion or explicit reconciliation/i.test(error.message);
  return (
    <div className="system-update-error" role="alert">
      <p>{captureHeld ? 'A Time Machine capture is holding system changes. Review the capture before starting an update.' : error.message}</p>
      {captureHeld ? (
        <Link className="desktop-update-action" to="/settings?tab=time-machine">
          Review Time Machine
        </Link>
      ) : null}
    </div>
  );
}
