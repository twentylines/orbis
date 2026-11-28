import { queryOptions } from '@tanstack/react-query';

export type ReleaseCompatibility = {
  tag: string;
  currentRuntipiVersion: string;
  targetRuntipiVersion: string;
  crossesRuntipiBoundary: boolean;
  hostUpdateSupported: boolean;
  warning: string | null;
};

export async function hostRequest<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/host-updates/${path}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(
        path === 'plan' || path.startsWith('downgrade/')
          ? 110_000
          : path === 'packages/plan' || path === 'packages/apply' || path === 'packages/refresh'
            ? 70_000
            : path === 'packages'
              ? 40_000
              : 20_000,
      ),
    ]),
  });
  const result: unknown = await response.json().catch(() => null);
  if (response.ok && (!result || typeof result !== 'object'))
    throw new Error('The host returned an incomplete response. Check its status before retrying.');
  if (!response.ok) {
    const message =
      typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string' ? result.message : null;
    const error = new Error(message || `Host update request failed (${response.status})`);
    throw Object.assign(error, {
      canForce: response.status === 400 && typeof result === 'object' && result !== null && 'canForce' in result && result.canForce === true,
    });
  }
  return result as T;
}

export function orbisUpdateEligibilityOptions(tag: string, userId: number, installed: string, base: string, hostCanChangeBase: boolean) {
  return queryOptions({
    queryKey: ['orbis-update-eligibility', userId, installed, base, hostCanChangeBase, tag],
    queryFn: async ({ signal }) => {
      const result = await hostRequest<ReleaseCompatibility>(`release-compatibility?tag=${encodeURIComponent(tag)}`, undefined, signal);
      if (
        result.tag !== tag ||
        result.currentRuntipiVersion !== base ||
        typeof result.targetRuntipiVersion !== 'string' ||
        typeof result.crossesRuntipiBoundary !== 'boolean' ||
        typeof result.hostUpdateSupported !== 'boolean' ||
        (result.warning !== null && typeof result.warning !== 'string') ||
        result.crossesRuntipiBoundary !== (base !== result.targetRuntipiVersion) ||
        (result.hostUpdateSupported &&
          !(
            (!result.crossesRuntipiBoundary && (base === '4.10.1' || (base === '4.12.0' && hostCanChangeBase))) ||
            (hostCanChangeBase && base === '4.10.1' && result.targetRuntipiVersion === '4.12.0')
          ))
      )
        throw new Error('The release compatibility check could not be verified. Try again before updating.');
      return result;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
