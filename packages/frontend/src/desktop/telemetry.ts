export type Telemetry = {
  sampledAt: string;
  cpu: { scope: 'host-proc' | 'runtime'; totalPercent: number | null; perCorePercent: (number | null)[]; uptimeSeconds: number | null };
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

export async function loadTelemetry(signal: AbortSignal): Promise<Telemetry> {
  const response = await fetch('/api/system/telemetry', { credentials: 'include', signal });
  if (!response.ok) throw new Error('Unable to read system telemetry');
  return response.json() as Promise<Telemetry>;
}
