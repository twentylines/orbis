export type ContainerReading = {
  id: string;
  name: string;
  appUrn: string | null;
  service: string | null;
  state: string;
  health: 'healthy' | 'unhealthy' | 'starting' | 'not-configured' | 'unknown';
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  receivedBytes: number | null;
  transmittedBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  statsAvailable: boolean;
};

export type ContainerTelemetry = {
  sampledAt: string;
  available: boolean;
  containers: ContainerReading[];
  omitted: number;
};
