import { IconShield } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useId, type PropsWithChildren } from 'react';
import { SentinelStatusError, sentinelStatusLabel, sentinelStatusOptions } from '../sentinel-status';

export function SentinelStatus({ active, children }: PropsWithChildren<{ active: boolean }>) {
  const heading = useId();
  const status = useQuery(sentinelStatusOptions(active));
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
        {children}
      </div>
      {status.isError ? (
        <p role="alert">{status.error instanceof SentinelStatusError ? status.error.message : 'Sentinel status could not be read.'}</p>
      ) : null}
    </section>
  );
}
