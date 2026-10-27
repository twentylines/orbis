import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconDownload, IconRefresh } from '@tabler/icons-react';
import { Link } from 'react-router';
import { installedOrbisBuildOptions, newerOrbisRelease, orbisUpdateNoticeOptions } from './orbis-release';
import { useCoreUpdateBusy } from './host-update-watch';
import { useWindowVisible } from './window-visibility';
import { useCluster } from './cluster';
import { orbisReleaseChannelsOptions } from './release-channels';
import { formatOrbisVersion } from './orbis-version';

export function OrbisUpdateNotice() {
  const visible = useWindowVisible();
  const busy = useCoreUpdateBusy();
  const cluster = useCluster();
  const build = useQuery({ ...installedOrbisBuildOptions(), enabled: visible });
  const channels = useQuery({ ...orbisReleaseChannelsOptions(), enabled: visible });
  const releases = useQuery(orbisUpdateNoticeOptions(visible && Boolean(channels.data) && !channels.isError, channels.data?.current));
  const latest = channels.isError || releases.isError ? undefined : releases.data?.[0];
  if (!busy && (!latest || !newerOrbisRelease(latest, build.data?.version))) return null;
  const critical = latest?.priority === 'critical';
  const label = busy ? 'Updating Orbis' : critical ? 'Critical update' : `Update to Orbis ${formatOrbisVersion(latest?.tag ?? '')}`;
  return (
    <Link
      to="/updates"
      className={`desktop-update-notice${critical ? ' desktop-update-notice-critical' : ''}`}
      title={
        busy
          ? 'Orbis update in progress. Open Updates for details.'
          : critical
            ? `Critical security update to Orbis ${formatOrbisVersion(latest?.tag ?? '')}`
            : label
      }
      aria-label={label}
      onClick={(event) => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && cluster.data?.localId) cluster.select(cluster.data.localId);
      }}
    >
      {busy ? (
        <IconRefresh className="orbis-update-spinning" size={18} aria-hidden="true" />
      ) : critical ? (
        <IconAlertTriangle size={18} aria-hidden="true" />
      ) : (
        <IconDownload size={18} aria-hidden="true" />
      )}
      <span>{label}</span>
    </Link>
  );
}

export function OrbisUpdateIcon() {
  const busy = useCoreUpdateBusy();
  return <IconRefresh className={busy ? 'orbis-update-spinning' : undefined} size={22} stroke={1.7} aria-hidden="true" />;
}
