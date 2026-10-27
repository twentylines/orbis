import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconDownload } from '@tabler/icons-react';
import { Link } from 'react-router';
import { installedOrbisBuildOptions, newerOrbisRelease, orbisUpdateNoticeOptions } from './orbis-release';
import { useHostUpdateWatch } from './host-update-watch';
import { coreWatchIsActive } from './core-update-state';
import { useWindowVisible } from './window-visibility';
import { useCluster } from './cluster';
import { orbisReleaseChannelsOptions } from './release-channels';
import { formatOrbisVersion } from './orbis-version';

export function OrbisUpdateNotice() {
  const visible = useWindowVisible();
  const { watch } = useHostUpdateWatch();
  const cluster = useCluster();
  const build = useQuery({ ...installedOrbisBuildOptions(), enabled: visible });
  const channels = useQuery({ ...orbisReleaseChannelsOptions(), enabled: visible });
  const releases = useQuery(orbisUpdateNoticeOptions(visible && Boolean(channels.data), channels.data?.current));
  const latest = releases.data?.[0];
  if (!latest || !newerOrbisRelease(latest, build.data?.version) || coreWatchIsActive(watch)) return null;
  const critical = latest.priority === 'critical';
  const label = critical ? 'Critical update' : `Update to Orbis ${formatOrbisVersion(latest.tag)}`;
  return (
    <Link
      to="/updates"
      className={`desktop-update-notice${critical ? ' desktop-update-notice-critical' : ''}`}
      title={critical ? `Critical security update to Orbis ${formatOrbisVersion(latest.tag)}` : label}
      onClick={(event) => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && cluster.data?.localId) cluster.select(cluster.data.localId);
      }}
    >
      {critical ? <IconAlertTriangle size={18} aria-hidden="true" /> : <IconDownload size={18} aria-hidden="true" />}
      <span>{label}</span>
    </Link>
  );
}
