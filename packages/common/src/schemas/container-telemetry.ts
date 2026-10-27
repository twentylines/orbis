export type ContainerReading = {
  id: string;
  name: string;
  appUrn: string | null;
  service: string | null;
  state: string;
  health: 'healthy' | 'unhealthy' | 'starting' | 'not-configured' | 'unknown';
  readiness?: {
    failingStreak: number | null;
    lastCheckExitCode: number | null;
    lastCheckAt: string | null;
    intervalSeconds: number | null;
    startPeriodSeconds: number | null;
    oomKilled: boolean | null;
    restartCount: number | null;
    lastCheckIssue?: 'connection' | 'timeout' | 'dns' | 'permission' | 'http-auth' | 'http-error' | 'command-missing' | null;
    healthcheckPort?: number | null;
    configuredPort?: number | null;
  } | null;
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
