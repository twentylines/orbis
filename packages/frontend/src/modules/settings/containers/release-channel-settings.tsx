import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { orbisReleaseChannelsOptions } from '@/desktop/release-channels';
import { useWindowVisible } from '@/desktop/window-visibility';
import './release-channel-settings.css';

export function ReleaseChannelSettings() {
  const id = useId();
  const visible = useWindowVisible();
  const status = useQuery({ ...orbisReleaseChannelsOptions(), enabled: visible });
  return (
    <section className="release-channel-settings" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Release channel</h2>
      {status.isPending ? <output>Reading release channels…</output> : null}
      {status.isError ? (
        <p role="alert">
          Release channels could not be read.{' '}
          <button type="button" onClick={() => void status.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {status.data ? (
        <dl className="release-channel-list">
          <div>
            <dt>
              Stable <span>{status.data.current === 'stable' ? 'Current' : 'Available'}</span>
            </dt>
            <dd>Receives the current published beta releases.</dd>
          </div>
          <div>
            <dt>
              Nightly <span>{status.data.channels.find((channel) => channel.id === 'nightly')?.available ? 'Available' : 'Inactive'}</span>
            </dt>
            <dd>Nightly is inactive during beta.</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
