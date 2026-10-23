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

export function appDockerHealth(containers: ContainerReading[]) {
  const coverage = {
    checked: containers.filter((item) => ['healthy', 'unhealthy', 'starting'].includes(item.health)).length,
    total: containers.length,
  };
  if (!containers.length) return { state: 'unknown', label: 'No container', ...coverage };
  if (containers.some((item) => item.health === 'unhealthy' || item.state === 'dead')) return { state: 'unhealthy', label: 'Unhealthy', ...coverage };
  if (containers.some((item) => item.health === 'starting' || item.state === 'restarting'))
    return { state: 'starting', label: 'Starting', ...coverage };
  const running = containers.filter((item) => item.state === 'running');
  if (!running.length) return { state: 'stopped', label: 'Stopped', ...coverage };
  if (running.length !== containers.length) return { state: 'partial', label: 'Partly stopped', ...coverage };
  if (running.some((item) => item.health === 'unknown')) return { state: 'unknown', label: 'Health unknown', ...coverage };
  const checked = running.filter((item) => item.health !== 'not-configured');
  if (checked.length && checked.every((item) => item.health === 'healthy')) return { state: 'healthy', label: 'Healthy', ...coverage };
  return { state: 'running', label: 'Running', ...coverage };
}
