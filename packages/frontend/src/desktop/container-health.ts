import type { ContainerReading, ContainerTelemetry } from '@runtipi/common/schemas';

const snapshots = new WeakMap<ContainerTelemetry, Map<string, ReturnType<typeof appDockerHealth>>>();
export function appHealthSnapshot(telemetry: ContainerTelemetry | undefined, urn: string, stale = false): ReturnType<typeof appDockerHealth> {
  if (stale || (telemetry && !telemetry.available)) return { state: 'unknown', label: 'Docker unavailable', checked: 0, total: 0 };
  if (!telemetry) return { state: 'unknown', label: 'Checking Docker', checked: 0, total: 0 };
  let health = snapshots.get(telemetry);
  if (!health) {
    const groups = new Map<string, ContainerReading[]>();
    for (const container of telemetry.containers) {
      if (!container.appUrn) continue;
      const group = groups.get(container.appUrn) ?? [];
      group.push(container);
      groups.set(container.appUrn, group);
    }
    health = new Map([...groups].map(([key, containers]) => [key, appDockerHealth(containers)]));
    snapshots.set(telemetry, health);
  }
  return health.get(urn) ?? appDockerHealth([]);
}

export function sameAppHealth(a: ReturnType<typeof appDockerHealth>, b: ReturnType<typeof appDockerHealth>) {
  return a.state === b.state && a.label === b.label && a.checked === b.checked && a.total === b.total;
}

export function displayedAppStatus<T extends string>(status: T, health: ReturnType<typeof appDockerHealth>): T | 'restarting' | 'stopped' {
  if (status !== 'running') return status;
  if (health.label === 'Restarting') return 'restarting';
  return health.state === 'stopped' || health.label === 'Container failed' ? 'stopped' : status;
}

export function appDockerHealth(containers: ContainerReading[]) {
  const coverage = {
    checked: containers.filter((item) => ['healthy', 'unhealthy', 'starting'].includes(item.health)).length,
    total: containers.length,
  };
  if (!containers.length) return { state: 'unknown', label: 'No container', ...coverage };
  if (containers.some((item) => item.state === 'dead')) return { state: 'unhealthy', label: 'Container failed', ...coverage };
  if (containers.some((item) => item.state === 'restarting')) return { state: 'starting', label: 'Restarting', ...coverage };
  const running = containers.filter((item) => item.state === 'running');
  if (!running.length) return { state: 'stopped', label: 'Stopped', ...coverage };
  if (running.length !== containers.length) return { state: 'partial', label: 'Partly stopped', ...coverage };
  if (running.some((item) => item.health === 'unhealthy')) return { state: 'unhealthy', label: 'Unhealthy', ...coverage };
  if (running.some((item) => item.health === 'starting')) return { state: 'starting', label: 'Readiness pending', ...coverage };
  if (running.some((item) => item.health === 'unknown')) return { state: 'unknown', label: 'Health unknown', ...coverage };
  const checked = running.filter((item) => item.health !== 'not-configured');
  if (checked.length && checked.every((item) => item.health === 'healthy')) return { state: 'healthy', label: 'Healthy', ...coverage };
  return { state: 'running', label: 'Running', ...coverage };
}

export function containerHealthReason(item: ContainerReading) {
  if (item.readiness?.oomKilled) return 'Docker stopped this container after it exceeded its memory limit.';
  if (item.state === 'restarting')
    return `Docker is restarting the process${item.readiness?.restartCount ? ` · ${item.readiness.restartCount} restarts recorded` : ''}. Check the app logs for the exit reason.`;
  if (item.state === 'dead') return 'Docker reports that this container has failed.';
  if (item.state !== 'running') return `Container state: ${item.state}.`;
  if (item.health === 'not-configured') return 'No Docker healthcheck is configured.';
  if (item.health === 'healthy') return 'The configured Docker healthcheck is passing.';
  if (item.health === 'unknown') return 'Docker did not return a healthcheck result.';
  const readiness = item.readiness;
  const details = [
    readiness?.failingStreak ? `${readiness.failingStreak} consecutive failed checks` : null,
    readiness?.lastCheckExitCode !== null && readiness?.lastCheckExitCode !== undefined ? `last exit code ${readiness.lastCheckExitCode}` : null,
    readiness?.intervalSeconds ? `checks every ${readiness.intervalSeconds} seconds` : null,
    item.health === 'starting' && readiness?.startPeriodSeconds ? `${readiness.startPeriodSeconds}-second startup grace period` : null,
  ].filter(Boolean);
  const summary =
    item.health === 'starting' ? 'The process is running; Docker has not confirmed readiness yet.' : 'The configured Docker healthcheck is failing.';
  return `${summary}${details.length ? ` ${details.join(' · ')}.` : ''}`;
}
