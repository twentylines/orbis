import './installed-versions.css';
import { formatOrbisVersion } from '@/desktop/orbis-version';
import type { OrbisReleaseChannel } from '@runtipi/common/schemas/orbis-release-channel';

const snapshotName = import.meta.env.VITE_ORBIS_SNAPSHOT_NAME;
const snapshot = typeof snapshotName === 'string' && /^[a-z0-9][a-z0-9.-]{0,79}$/i.test(snapshotName) ? snapshotName : null;

export function InstalledVersions({
  orbis,
  runtipi,
  channel,
  host,
}: {
  orbis?: string;
  runtipi?: string | null;
  channel?: OrbisReleaseChannel | 'loading' | 'unavailable';
  host?: { sentinel?: string | null; operatingSystem?: string | null; docker?: string | null };
}) {
  return (
    <dl className="installed-versions" aria-label="Installed software versions">
      <div>
        <dt>Orbis</dt>
        <dd>{orbis ? formatOrbisVersion(orbis) : 'Not reported'}</dd>
      </div>
      {snapshot ? (
        <div>
          <dt>Live build</dt>
          <dd>Snapshot {snapshot}</dd>
        </div>
      ) : null}
      <div>
        <dt>Compatibility base</dt>
        <dd>{runtipi || 'Not reported'}</dd>
      </div>
      {host ? (
        <>
          <div>
            <dt>Sentinel</dt>
            <dd>{host.sentinel || 'Not reported'}</dd>
          </div>
          <div>
            <dt>Operating system</dt>
            <dd>{host.operatingSystem || 'Not reported'}</dd>
          </div>
          <div>
            <dt>Docker</dt>
            <dd>{host.docker || 'Not reported'}</dd>
          </div>
        </>
      ) : null}
      {channel ? (
        <div>
          <dt>Update channel</dt>
          <dd>{channel === 'stable' ? 'Stable' : channel === 'nightly' ? 'Nightly' : channel === 'loading' ? 'Reading…' : 'Unavailable'}</dd>
        </div>
      ) : null}
    </dl>
  );
}
