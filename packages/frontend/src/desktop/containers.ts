import type { ContainerReading, ContainerTelemetry } from '@runtipi/common/schemas';
import { useQuery } from '@tanstack/react-query';

export const containerTelemetryKey = ['container-telemetry'] as const;
export const useContainerTelemetry = () =>
  useQuery<ContainerTelemetry>({
    queryKey: containerTelemetryKey,
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/system/containers', { credentials: 'include', signal });
      if (!response.ok) throw new Error('Docker telemetry is unavailable');
      return response.json();
    },
    refetchInterval: 5000,
    staleTime: 4000,
    refetchIntervalInBackground: false,
  });

export function appDockerHealth(containers: ContainerReading[]) {
  if (!containers.length) return { state: 'unknown', label: 'No container' };
  if (containers.some((item) => item.health === 'unhealthy' || item.state === 'dead')) return { state: 'unhealthy', label: 'Unhealthy' };
  if (containers.some((item) => item.health === 'starting' || item.state === 'restarting')) return { state: 'starting', label: 'Starting' };
  const running = containers.filter((item) => item.state === 'running');
  if (!running.length) return { state: 'stopped', label: 'Stopped' };
  if (running.length !== containers.length) return { state: 'partial', label: 'Partly stopped' };
  if (running.every((item) => item.health === 'healthy')) return { state: 'healthy', label: 'Healthy' };
  if (running.some((item) => item.health === 'unknown')) return { state: 'unknown', label: 'Health unknown' };
  return { state: 'running', label: 'No healthcheck' };
}
