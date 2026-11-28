import { IconShield } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, type PropsWithChildren } from 'react';
import { sentinelUpdateActive } from '@runtipi/common/schemas/sentinel-update-progress';
import { RecoveryProgressBar } from '@/components/recovery-progress/recovery-progress';
import { describeSentinelUpdate, type SentinelUpdateView } from '../sentinel-update-progress';
import { SentinelStatusError, sentinelStatusLabel, sentinelStatusOptions } from '../sentinel-status';

function SentinelUpdateStatus({ jobs, pending, unavailable }: SentinelUpdateView) {
  const sorted = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt);
  const activeJobs = sorted.filter(sentinelUpdateActive);
  const visibleJobs = activeJobs.length ? activeJobs : sorted.slice(0, 1);
  return (
    <div className="desktop-sentinel-connection">
      <h3>Sentinel update</h3>
      {unavailable ? <output>Sentinel update progress is unavailable.</output> : null}
      {pending ? <output>Checking Sentinel update progress…</output> : null}
      {!unavailable && !pending && !visibleJobs.length ? <output>No Sentinel installer activity reported.</output> : null}
      {visibleJobs.map((job) => {
        const { status, detail, percentage } = describeSentinelUpdate(job);
        return (
          <div className="desktop-sentinel-update-job" key={job.id}>
            <output>
              {status} · {job.version}
            </output>
            {detail ? <p>{detail}</p> : null}
            {sentinelUpdateActive(job) ? <RecoveryProgressBar label={status} percentage={percentage} /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function SentinelStatus({
  active,
  operator = false,
  updateProgress,
  children,
}: PropsWithChildren<{ active: boolean; operator?: boolean; updateProgress?: SentinelUpdateView }>) {
  const heading = useId();
  const status = useQuery(sentinelStatusOptions(active));
  const lastComplete = updateProgress?.jobs.reduce((latest, job) => (job.phase === 'complete' ? Math.max(latest, job.updatedAt) : latest), 0);
  const refetchStatus = status.refetch;
  useEffect(() => {
    if (active && lastComplete) void refetchStatus({ cancelRefetch: false });
  }, [active, lastComplete, refetchStatus]);
  const current = status.isError ? undefined : status.data;
  return (
    <section className="desktop-updates-card desktop-updates-sentinel" aria-labelledby={heading}>
      <div className="desktop-updates-card-head">
        <span className="desktop-updates-card-icon">
          <IconShield size={20} aria-hidden="true" />
        </span>
        <h2 id={heading}>Sentinel</h2>
      </div>
      <div className="desktop-sentinel-readings">
        <dl className="desktop-sentinel-versions" aria-label="Sentinel status">
          <div>
            <dt>Version</dt>
            <dd>{status.isPending ? 'Reading…' : (current?.installedVersion ?? 'Not reported')}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <output>{status.isPending ? 'Checking…' : sentinelStatusLabel(current)}</output>
            </dd>
          </div>
          {current?.availableVersion ? (
            <div>
              <dt>Available version</dt>
              <dd>{current.availableVersion}</dd>
            </div>
          ) : null}
        </dl>
        {operator && updateProgress ? <SentinelUpdateStatus {...updateProgress} /> : null}
        {children}
      </div>
      {status.isError ? (
        <p role="alert">{status.error instanceof SentinelStatusError ? status.error.message : 'Sentinel status could not be read.'}</p>
      ) : null}
    </section>
  );
}
