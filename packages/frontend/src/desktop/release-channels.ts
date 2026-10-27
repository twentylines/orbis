import type { OrbisReleaseChannel, OrbisReleaseChannelStatus } from '@runtipi/common/schemas/orbis-release-channel';
import { queryOptions, type QueryClient } from '@tanstack/react-query';

export type StableChannelPlan = {
  planId: string;
  currentTag: string;
  targetTag: string;
  targetDigest: string;
  snapshotBytes: number;
  appsMustBeStopped: boolean;
  compatibility: string;
  expiresAt: number;
  forced: boolean;
  warnings: string[];
  returnToStable: true;
  operation: 'update' | 'downgrade';
};

export type StableChannelApply = { jobId: string; state: string };

export class ReleaseChannelRequestError extends Error {
  canForce = false;
}

async function request<T>(path: string, method: 'POST' | 'PUT', body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/host-updates/${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(path.endsWith('/plan') ? 110_000 : 20_000)]),
  });
  if (!response.ok) {
    const error = new ReleaseChannelRequestError('The release channel request could not be completed.');
    try {
      const payload: unknown = await response.json();
      if (payload && typeof payload === 'object' && 'canForce' in payload && payload.canForce === true) error.canForce = true;
      if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
        error.message = payload.message;
      }
    } catch {
      // Keep the safe fallback when an error body is absent or malformed.
    }
    throw error;
  }
  return response.json();
}

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
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    retry: false,
  });

export const enrollOrbisReleaseChannel = (channel: OrbisReleaseChannel, revision: string, acknowledgeNightly = false) =>
  request<OrbisReleaseChannelStatus>('channel', 'PUT', {
    channel,
    revision,
    ...(channel === 'nightly' && acknowledgeNightly ? { acknowledgeNightly: true } : {}),
  });

export const planStableChannelInstall = (force = false) => request<StableChannelPlan>('channel/stable/plan', 'POST', force ? { force: true } : {});

export const applyStableChannelInstall = (planId: string, force = false) =>
  request<StableChannelApply>('channel/stable/apply', 'POST', { planId, ...(force ? { force: true } : {}) });

export async function refreshReleaseChannelRelatedQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['orbis-release-channels'] }),
    queryClient.invalidateQueries({ queryKey: ['orbis-installed-build'] }),
    queryClient.invalidateQueries({ queryKey: ['orbis-github-releases'] }),
    queryClient.invalidateQueries({ queryKey: ['orbis-published-releases'] }),
    queryClient.invalidateQueries({ queryKey: ['orbis-release-history'] }),
    queryClient.invalidateQueries({ queryKey: ['orbis-host-update-status'] }),
  ]);
}
