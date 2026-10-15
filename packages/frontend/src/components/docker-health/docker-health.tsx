import type { ContainerTelemetry } from '@runtipi/common/schemas';
import { appDockerHealth } from '@/desktop/containers';
import './docker-health.css';

export function DockerHealth({ appUrn, telemetry, stale = false }: { appUrn: string; telemetry?: ContainerTelemetry; stale?: boolean }) {
  const result =
    stale || (telemetry && !telemetry.available)
      ? { state: 'unknown', label: 'Docker unavailable' }
      : telemetry
        ? appDockerHealth(telemetry.containers.filter((item) => item.appUrn === appUrn))
        : { state: 'unknown', label: 'Checking Docker' };
  return (
    <span className="docker-health" data-health={result.state} title={`Docker: ${result.label}`}>
      <i aria-hidden="true" />
      {result.label}
    </span>
  );
}
