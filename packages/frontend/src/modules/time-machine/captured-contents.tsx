import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';

export function capturedContents(point: TimeMachinePoint) {
  const metadata = point.metadata;
  if (!metadata) return { included: [], excluded: [] };
  const included = ['Orbis accounts, settings and database'];
  const excluded = ['Operating system and installed system packages', 'State held by external services or devices'];
  if (metadata.version === 4) {
    for (const mount of metadata.selectedComponent.receipt.manifest.includedStorage)
      included.push(
        `Selected app storage: ${mount.appUrn} ${mount.destination}${mount.classification === 'media' ? ' (media files)' : mount.classification === 'external' ? ' (external storage)' : ''}`,
      );
    excluded.push('Unchecked app storage and media');
  } else if (metadata.coverage.appData) included.push('Managed app files and databases, including saved preferences, accounts and integrations');
  else excluded.push('Docker app files, databases and media');
  if (metadata.coverage.dockerImages) included.push('Retained Docker images and their exact versions');
  else excluded.push('Docker images and their versions');
  if (metadata.version === 2 && metadata.coverage.controllerConfiguration)
    included.push('Docker Compose configuration, ports, networks and saved mount paths');
  if (metadata.preview.available) included.push('Saved appearance and Home layout');
  if (metadata.breakdown.some((part) => part.id === 'media')) included.push('Files in the captured media directory');
  excluded.push('Other servers in the cluster');
  return { included, excluded };
}

export function CapturedContents({ point }: { point: TimeMachinePoint }) {
  const { included, excluded } = capturedContents(point);
  if (!point.metadata) return null;
  return (
    <section className="tm-captured-contents" aria-label="Restore contents">
      <h3>Included</h3>
      <ul>
        {included.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      <h3>Not included</h3>
      <ul>
        {excluded.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      <p>
        {point.metadata.version === 4
          ? 'Combined Orbis and app captures can be exported. Restoring them is not available yet.'
          : 'Mounted drives and external services must still be available. Browsing this point changes no app data.'}
      </p>
    </section>
  );
}
