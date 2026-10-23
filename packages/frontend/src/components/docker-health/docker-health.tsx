import type { ContainerTelemetry } from '@runtipi/common/schemas';
import { appHealthSnapshot, sameAppHealth } from '@/desktop/container-health';
import { memo } from 'react';
import './docker-health.css';

export const DockerHealth = memo(
  function DockerHealth({ appUrn, telemetry, stale = false }: { appUrn: string; telemetry?: ContainerTelemetry; stale?: boolean }) {
    const result = appHealthSnapshot(telemetry, appUrn, stale);
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
  },
  (previous, next) =>
    previous.appUrn === next.appUrn &&
    sameAppHealth(appHealthSnapshot(previous.telemetry, previous.appUrn, previous.stale), appHealthSnapshot(next.telemetry, next.appUrn, next.stale)),
);
