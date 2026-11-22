import { queryOptions } from '@tanstack/react-query';

const states = ['unknown', 'healthy', 'unavailable', 'updating', 'recovering'] as const;
const version = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![\s\S])/;

export type SentinelStatus = {
  available: boolean;
  installedVersion: string | null;
  availableVersion: string | null;
  state: (typeof states)[number];
};

export class SentinelStatusError extends Error {
  constructor(readonly status?: number) {
    super(status === 401 || status === 403 ? 'Sign in again to read Sentinel status.' : 'Sentinel status could not be read.');
    this.name = 'SentinelStatusError';
  }
}

export function parseSentinelStatus(value: unknown): SentinelStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SentinelStatusError();
  const record = value as Record<string, unknown>;
  const validVersion = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 128 && version.test(value));
  if (
    Object.keys(record).length !== 4 ||
    !['available', 'installedVersion', 'availableVersion', 'state'].every((key) => Object.hasOwn(record, key)) ||
    typeof record.available !== 'boolean' ||
    !validVersion(record.installedVersion) ||
    !validVersion(record.availableVersion) ||
    !states.some((state) => state === record.state) ||
    (!record.available && (record.installedVersion !== null || record.availableVersion !== null || record.state !== 'unknown'))
  )
    throw new SentinelStatusError();
  return {
    available: record.available,
    installedVersion: record.installedVersion as string | null,
    availableVersion: record.availableVersion as string | null,
    state: record.state as SentinelStatus['state'],
  };
}

export async function readSentinelJson(
  endpoint: '/api/system/sentinel' | '/api/system/sentinel/recovery-access' | '/api/system/sentinel/update-progress',
  signal: AbortSignal,
  maxBytes = 4096,
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new SentinelStatusError(response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new SentinelStatusError();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new SentinelStatusError();
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    reader.releaseLock();
  }
}

export async function readSentinelStatus(signal: AbortSignal): Promise<SentinelStatus> {
  return parseSentinelStatus(await readSentinelJson('/api/system/sentinel', signal));
}

const enrollmentStages = [
  'not-started',
  'staging',
  'operator-staged',
  'key-prepared',
  'key-expired',
  'key-acknowledged',
  'activation-pending',
  'activated',
] as const;
export type SentinelEnrollmentStage = (typeof enrollmentStages)[number];

export type SentinelRecoveryAccess =
  | { state: 'missing' | 'unavailable'; portalUrl: null; unitState: null }
  | { state: 'configured'; portalUrl: string; unitState: 'active' | 'inactive' | 'unknown'; enrollment?: SentinelEnrollmentStage };

export async function readSentinelRecoveryAccess(signal: AbortSignal): Promise<SentinelRecoveryAccess> {
  const value = await readSentinelJson('/api/system/sentinel/recovery-access', signal);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SentinelStatusError();
  const { state, portalUrl, unitState, enrollment } = value as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((key) => !['state', 'portalUrl', 'unitState', 'enrollment'].includes(key))) throw new SentinelStatusError();
  if ((state === 'missing' || state === 'unavailable') && portalUrl === null && unitState === null && !keys.includes('enrollment')) {
    return { state, portalUrl, unitState };
  }
  if (
    state === 'configured' &&
    (unitState === 'active' || unitState === 'inactive' || unitState === 'unknown') &&
    typeof portalUrl === 'string' &&
    portalUrl.length <= 531 &&
    /^https:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::[0-9]{1,5})?\/sentinel\/recovery\/(?![\s\S])/i.test(portalUrl)
  ) {
    const url = URL.canParse(portalUrl) ? new URL(portalUrl) : null;
    if (url && url.port !== '0' && url.pathname === '/sentinel/recovery/') {
      const stage = enrollmentStages.find((candidate) => candidate === enrollment);
      if (keys.includes('enrollment') && (!stage || unitState !== 'active')) throw new SentinelStatusError();
      return stage ? { state, portalUrl, unitState, enrollment: stage } : { state, portalUrl, unitState };
    }
  }
  throw new SentinelStatusError();
}

export function recoveryAccessNeedsSignIn(error: unknown) {
  return error instanceof SentinelStatusError && (error.status === 401 || error.status === 403);
}

export const sentinelRecoveryAccessOptions = (active: boolean) =>
  queryOptions({
    queryKey: ['orbis-sentinel-recovery-access'],
    queryFn: ({ signal }) => readSentinelRecoveryAccess(signal),
    enabled: (query) => active && !recoveryAccessNeedsSignIn(query.state.error),
    refetchInterval: (query) =>
      active &&
      !recoveryAccessNeedsSignIn(query.state.error) &&
      !(query.state.error instanceof SentinelStatusError && query.state.error.status === 404)
        ? 15_000
        : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });

export const sentinelStatusOptions = (active: boolean) =>
  queryOptions({
    queryKey: ['orbis-sentinel-status'],
    queryFn: ({ signal }) => readSentinelStatus(signal),
    enabled: active,
    staleTime: 5000,
    refetchInterval: active
      ? (query) => {
          if (query.state.error instanceof SentinelStatusError && [401, 403, 404].includes(query.state.error.status ?? 0)) return false;
          return ['updating', 'recovering'].includes(query.state.data?.state ?? '') ? 4000 : 30_000;
        }
      : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });

export function sentinelStatusLabel(status: SentinelStatus | undefined) {
  if (!status?.available) return 'Status unavailable';
  return { healthy: 'Running', unavailable: 'Unavailable', updating: 'Updating', recovering: 'Recovering', unknown: 'Status unknown' }[status.state];
}
