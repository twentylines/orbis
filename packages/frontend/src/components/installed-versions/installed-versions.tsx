import './installed-versions.css';

export function InstalledVersions({ orbis, runtipi }: { orbis?: string; runtipi?: string | null }) {
  return (
    <dl className="installed-versions" aria-label="Installed software versions">
      <div>
        <dt>Orbis</dt>
        <dd>{orbis || 'Not reported'}</dd>
      </div>
      <div>
        <dt>Runtipi</dt>
        <dd>{runtipi || 'Not reported'}</dd>
      </div>
    </dl>
  );
}
