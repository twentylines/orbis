import { IconShield } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, type PropsWithChildren } from 'react';
import { sentinelUpdateActive } from '@runtipi/common/schemas/sentinel-update-progress';
import { RecoveryProgressBar } from '@/components/recovery-progress/recovery-progress';
import { describeSentinelUpdate, type SentinelUpdateView } from '../sentinel-update-progress';
import { SentinelKeyHandoff } from './sentinel-key-handoff';
import { SentinelControllerHandoff } from './sentinel-controller-handoff';
import {
  recoveryAccessNeedsSignIn,
  type SentinelEnrollmentStage,
  sentinelRecoveryAccessOptions,
  SentinelStatusError,
  sentinelStatusLabel,
  sentinelStatusOptions,
} from '../sentinel-status';

const enrollmentGuidance: Record<SentinelEnrollmentStage, [status: string, next: string]> = {
  'not-started': ['Enrollment has not started.', 'On the Orbis host, stage the operator account using the protected Sentinel bootstrap.'],
  staging: ['Operator setup is in progress.', 'Complete the staged setup on the Orbis host before preparing the emergency key.'],
  'operator-staged': ['Operator account staged.', 'Prepare and save the emergency key through the protected host setup.'],
  'key-prepared': ['Emergency key prepared.', 'Save the key somewhere you can reach while Orbis is offline, then confirm the saved file.'],
  'key-expired': ['The emergency key confirmation expired.', 'Review the existing host setup before continuing.'],
  'key-acknowledged': ['Host recorded a key acknowledgment.', 'Complete the reviewed activation on the Orbis host.'],
  'activation-pending': ['Activation is in progress.', 'Follow the host setup result before testing recovery sign-in.'],
  activated: ['Recovery credentials activated.', 'Open the recovery portal and test sign-in while Orbis is still available.'],
};

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
  const recovery = useQuery(sentinelRecoveryAccessOptions(active));
  const access = recovery.isError ? undefined : recovery.data;
  const enrollment = operator && access?.state === 'configured' && access.enrollment ? enrollmentGuidance[access.enrollment] : undefined;
  const recoveryLabel = recoveryAccessNeedsSignIn(recovery.error)
    ? 'Sign in again to check recovery access.'
    : recovery.isPending
      ? 'Checking recovery access…'
      : access?.state === 'configured'
        ? {
            active: 'Portal configured. Recovery service active.',
            inactive: 'Portal configured. Recovery service inactive.',
            unknown: 'Portal configured. Recovery service status unknown.',
          }[access.unitState]
        : access?.state === 'missing'
          ? 'Recovery portal setup required.'
          : 'Recovery access could not be verified.';
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
        <div className="desktop-sentinel-connection">
          <h3>Recovery access</h3>
          <output>{recoveryLabel}</output>
          {enrollment ? (
            <div>
              <output>{enrollment[0]}</output>
              <p>{enrollment[1]}</p>
            </div>
          ) : operator && access?.state === 'configured' && access.unitState === 'active' ? (
            <p>Enrollment progress could not be verified.</p>
          ) : null}
          {operator && access?.state === 'configured' && (access.enrollment === 'key-prepared' || access.enrollment === 'key-acknowledged') ? (
            <SentinelKeyHandoff active={active} acknowledged={access.enrollment === 'key-acknowledged'} onConfirmed={() => void recovery.refetch()} />
          ) : null}
          {access?.state === 'configured' ? (
            <>
              {enrollment ? null : <p>Open the portal to check sign-in availability.</p>}
              <a className="desktop-update-action secondary" href={access.portalUrl} target="_blank" rel="noopener noreferrer">
                Open recovery
              </a>
              {operator && access.enrollment === 'activated' && access.unitState === 'active' ? (
                <SentinelControllerHandoff key={access.portalUrl} active={active} portalUrl={access.portalUrl} />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {status.isError ? (
        <p role="alert">{status.error instanceof SentinelStatusError ? status.error.message : 'Sentinel status could not be read.'}</p>
      ) : null}
    </section>
  );
}
