import type { ContainerTelemetry } from '@runtipi/common/schemas';
import { appDockerHealth } from '@/desktop/container-health';
import './docker-health.css';

export function DockerHealth({ appUrn, telemetry, stale = false }: { appUrn: string; telemetry?: ContainerTelemetry; stale?: boolean }) {
  const result =
    stale || (telemetry && !telemetry.available)
      ? { state: 'unknown', label: 'Docker unavailable' }
      : telemetry
        ? appDockerHealth(telemetry.containers.filter((item) => item.appUrn === appUrn))
        : { state: 'unknown', label: 'Checking Docker' };
  const coverage =
    'checked' in result
      ? result.state === 'running' && result.checked === 0
        ? ' · No Docker healthcheck is configured'
        : result.checked && result.checked < result.total
          ? ` · ${result.checked} of ${result.total} containers have healthchecks`
          : ''
      : '';
  return (
    <span className="docker-health" data-health={result.state} title={`Docker: ${result.label}${coverage}`}>
      <i aria-hidden="true" />
      <span>{result.label}</span>
    </span>
  );
}
