import { IconAlertTriangle, IconDownload, IconRefresh } from '@tabler/icons-react';
import { Link } from 'react-router';
import { useCluster } from './cluster';
import { formatOrbisVersion } from './orbis-version';
import { useCoreUpdateBusy } from './host-update-watch';
import { useOrbisUpdateOffer } from './use-orbis-update-offer';

export function OrbisUpdateNotice() {
  const { busy, release } = useOrbisUpdateOffer();
  const cluster = useCluster();
  if (!busy && !release) return null;
  const critical = release?.priority === 'critical';
  const label = busy ? 'Updating Orbis' : critical ? 'Critical update' : `Update to Orbis ${formatOrbisVersion(release?.tag ?? '')}`;
  return (
    <Link
      to="/updates"
      className={`desktop-update-notice${critical ? ' desktop-update-notice-critical' : ''}`}
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
