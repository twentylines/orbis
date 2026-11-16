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

export async function readSentinelStatus(signal: AbortSignal): Promise<SentinelStatus> {
  const response = await fetch('/api/system/sentinel', {
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
      if (bytes > 4096) {
        await reader.cancel();
        throw new SentinelStatusError();
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return parseSentinelStatus(JSON.parse(text));
  } finally {
    reader.releaseLock();
  }
}

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
