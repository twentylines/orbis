import type { ContainerReading } from '@runtipi/common/schemas';

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
