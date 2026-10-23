import type { ContainerTelemetry } from '@runtipi/common/schemas';
import { useQuery } from '@tanstack/react-query';
import { useWindowVisible } from './window-visibility';
import { useServerPath } from './cluster-data';

export const containerTelemetryKey = ['container-telemetry'] as const;
export const useContainerTelemetry = () => {
  const visible = useWindowVisible();
  const path = useServerPath()('/api/system/containers');
  return useQuery<ContainerTelemetry>({
    enabled: visible,
    queryKey: [...containerTelemetryKey, path],
    queryFn: async ({ signal }) => {
      const response = await fetch(path, { credentials: 'include', signal });
      if (!response.ok) throw new Error('Docker telemetry is unavailable');
      return response.json();
    },
    refetchInterval: 5000,
    staleTime: 4000,
    refetchIntervalInBackground: false,
  });
};
