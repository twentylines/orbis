import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { SentinelStatusError, sentinelStatusLabel, sentinelStatusOptions } from '../sentinel-status';
import '@/components/installed-versions/installed-versions.css';

export function SentinelStatus({ active }: { active: boolean }) {
  const heading = useId();
  const status = useQuery(sentinelStatusOptions(active));
  const current = status.isError ? undefined : status.data;
  return (
    <section className="desktop-update-build-details" aria-labelledby={heading}>
      <h4 id={heading}>Sentinel</h4>
      <dl className="installed-versions" aria-label="Sentinel status">
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
      {status.isError ? (
        <p role="alert">{status.error instanceof SentinelStatusError ? status.error.message : 'Sentinel status could not be read.'}</p>
      ) : null}
    </section>
  );
}
