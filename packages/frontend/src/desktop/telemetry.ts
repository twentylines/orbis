import { queryOptions } from '@tanstack/react-query';

export type Telemetry = {
  sampledAt: string;
  cpu: {
    scope: 'host-proc' | 'runtime';
    model?: string | null;
    totalPercent: number | null;
    perCorePercent: (number | null)[];
    uptimeSeconds: number | null;
    reportedClockGHz?: number | null;
  };
  memory: {
    scope: 'host-proc';
    totalBytes: number | null;
    availableBytes: number | null;
    swapTotalBytes: number | null;
    swapFreeBytes: number | null;
  };
  filesystems: {
    mount: string;
    filesystem: string;
    sizeBytes: number | null;
    usedBytes: number | null;
    availableBytes: number | null;
    scope: 'runtime';
  }[];
  network: {
    interface: string;
    rxBytesPerSecond: number | null;
    txBytesPerSecond: number | null;
    receivedBytes: number | null;
    transmittedBytes: number | null;
    scope: 'runtime';
  }[];
};

export const telemetryQueryKey = ['system-telemetry'] as const;

export function telemetryOptions(visible: boolean, path = '/api/system/telemetry', serverId?: string | null) {
  return queryOptions<Telemetry>({
    queryKey:
      path === '/api/system/telemetry' ? telemetryQueryKey : serverId ? ['cluster-server', serverId, 'telemetry'] : [...telemetryQueryKey, path],
    queryFn: async ({ signal }) => {
      if (path === '/api/system/telemetry') return loadTelemetry(signal);
      const response = await fetch(path, { credentials: 'include', signal });
      if (!response.ok) throw new Error('The selected server is unavailable');
      return response.json();
    },
    enabled: visible,
    staleTime: 800,
    refetchInterval: 1000,
    refetchIntervalInBackground: false,
  });
}

export async function loadTelemetry(signal: AbortSignal): Promise<Telemetry> {
  const response = await fetch('/api/system/telemetry', { credentials: 'include', signal });
  if (!response.ok) throw new Error('Unable to read system telemetry');
  return response.json() as Promise<Telemetry>;
}
