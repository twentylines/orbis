import type { OrbisReleaseChannelStatus } from '@runtipi/common/schemas/orbis-release-channel';
import { queryOptions } from '@tanstack/react-query';

export const orbisReleaseChannelsOptions = () =>
  queryOptions({
    queryKey: ['orbis-release-channels'],
    queryFn: async ({ signal }): Promise<OrbisReleaseChannelStatus> => {
      const response = await fetch('/api/system/orbis-release-channels', {
        credentials: 'same-origin',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (!response.ok) throw new Error('Release channels could not be read.');
      return response.json();
    },
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
