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

  constructor(status: number, canForce = false, code?: string) {
    super(releaseChannelRequestMessage(status, code));
    this.name = 'ReleaseChannelRequestError';
    this.canForce = canForce;
  }
}

export class ReleaseChannelsStatusError extends Error {
  constructor(
    readonly status: number,
    code?: string,
  ) {
    super(releaseChannelsStatusMessage(status, code));
    this.name = 'ReleaseChannelsStatusError';
  }
}

function releaseChannelRequestMessage(status: number, code?: string): string {
  if (code === 'host-channel-support-required') {
    return 'The host service needs an update to support release channels. Update the host service using the current installer, then retry this change.';
  }
  if (status === 401 || status === 403) return 'Your session cannot change the release channel. Sign in with an operator account and try again.';
  if (status === 409) return 'Release channel status changed before this request completed. Refresh the status and try again.';
  if (status === 400) return 'The release channel request was rejected. Refresh the status and review the request before trying again.';
  if (status === 429) return 'Too many release channel requests were sent. Wait a moment and try again.';
  if (status >= 500) return `The host could not complete the release channel request (HTTP ${status}). Try again.`;
  return `The release channel request could not be completed (HTTP ${status}). Refresh the status and try again.`;
}

export function releaseChannelsStatusMessage(status: number, code?: string): string {
  if (code === 'channel-storage-invalid') {
    return 'The private release channel settings need repair. Review the host service with the current installer before retrying.';
  }
  if (status === 401 || status === 403) return 'Your session cannot read release channel status. Sign in again and retry.';
  if (status >= 500) return `The host could not read release channel status (HTTP ${status}). Try again.`;
  return `Release channel status could not be read (HTTP ${status}). Try again.`;
}

export function releaseChannelErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ReleaseChannelRequestError || error instanceof ReleaseChannelsStatusError) return error.message;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'The request took too long. Check the server connection and try again.';
  }
  if (error instanceof TypeError) return 'The server could not be reached. Check the connection and try again.';
  return fallback;
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
    let canForce = false;
    let code: string | undefined;
    try {
      const payload: unknown = await response.json();
      canForce = Boolean(payload && typeof payload === 'object' && 'canForce' in payload && payload.canForce === true);
      code = payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string' ? payload.code : undefined;
    } catch {
      // The status code provides safe user-facing context when the body is absent or malformed.
    }
    throw new ReleaseChannelRequestError(response.status, canForce, code);
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
      if (!response.ok) {
        let code: string | undefined;
        try {
          const payload: unknown = await response.json();
          code = payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string' ? payload.code : undefined;
        } catch {
          // The status code provides safe user-facing context when the body is absent or malformed.
        }
        throw new ReleaseChannelsStatusError(response.status, code);
      }
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
