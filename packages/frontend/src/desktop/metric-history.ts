import { useQuery } from '@tanstack/react-query';
import type { MetricHistory, MetricHistoryRange } from '@runtipi/common/schemas';
import { useWindowVisible } from './window-visibility';
import { useServerPath } from './cluster-data';

export const useMetricHistory = (range: MetricHistoryRange) => {
  const visible = useWindowVisible();
  const path = useServerPath()(`/api/system/history?range=${range}`);
  return useQuery<MetricHistory>({
    enabled: visible,
    queryKey: ['metric-history', path],
    queryFn: async ({ signal }) => {
      const response = await fetch(path, { credentials: 'include', signal });
      if (!response.ok) throw new Error('Metric history is unavailable');
      return response.json();
    },
    refetchInterval: range === '5m' ? 10000 : 30000,
    staleTime: 9000,
    refetchIntervalInBackground: false,
  });
};
