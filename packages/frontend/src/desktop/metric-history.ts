import { useQuery } from '@tanstack/react-query';
import type { MetricHistory, MetricHistoryRange } from '@runtipi/common/schemas';

export const useMetricHistory = (range: MetricHistoryRange) =>
  useQuery<MetricHistory>({
    queryKey: ['metric-history', range],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/system/history?range=${range}`, { credentials: 'include', signal });
      if (!response.ok) throw new Error('Metric history is unavailable');
      return response.json();
    },
    refetchInterval: range === '5m' ? 10000 : 30000,
    staleTime: 9000,
    refetchIntervalInBackground: false,
  });
