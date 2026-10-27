import './installed-versions.css';
import { formatOrbisVersion } from '@/desktop/orbis-version';
import type { OrbisReleaseChannel } from '@runtipi/common/schemas/orbis-release-channel';

export function InstalledVersions({
  orbis,
  runtipi,
  channel,
}: {
  orbis?: string;
  runtipi?: string | null;
  channel?: OrbisReleaseChannel | 'loading' | 'unavailable';
}) {
  return (
    <dl className="installed-versions" aria-label="Installed software versions">
      <div>
        <dt>Orbis</dt>
        <dd>{orbis ? formatOrbisVersion(orbis) : 'Not reported'}</dd>
      </div>
      <div>
        <dt>Runtipi</dt>
        <dd>{runtipi || 'Not reported'}</dd>
      </div>
      {channel ? (
        <div>
          <dt>Update channel</dt>
          <dd>{channel === 'stable' ? 'Stable' : channel === 'nightly' ? 'Nightly' : channel === 'loading' ? 'Reading…' : 'Unavailable'}</dd>
        </div>
      ) : null}
    </dl>
  );
}
