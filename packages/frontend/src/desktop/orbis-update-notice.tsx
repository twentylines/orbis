import { useQuery } from '@tanstack/react-query';
import { IconDownload } from '@tabler/icons-react';
import { Link } from 'react-router';
import { installedOrbisBuildOptions, newerOrbisRelease, orbisReleasesOptions } from './orbis-release';
import { useHostUpdateWatch } from './host-update-watch';
import { coreWatchIsActive } from './core-update-state';
import { useWindowVisible } from './window-visibility';
import { useCluster } from './cluster';

export function OrbisUpdateNotice() {
  const visible = useWindowVisible();
  const { watch } = useHostUpdateWatch();
  const cluster = useCluster();
  const build = useQuery({ ...installedOrbisBuildOptions(), enabled: visible });
  const releases = useQuery({ ...orbisReleasesOptions(), enabled: visible });
  const latest = releases.data?.[0];
  if (!latest || !newerOrbisRelease(latest, build.data?.version) || coreWatchIsActive(watch)) return null;
  const label = `Update to Orbis ${latest.tag.replace(/^v/, '')}`;
  return (
    <Link
      to="/updates"
      className="desktop-update-notice"
      title={label}
      onClick={(event) => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && cluster.data?.localId) cluster.select(cluster.data.localId);
      }}
    >
      <IconDownload size={18} aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}
