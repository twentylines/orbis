export const metricHistoryRanges = {
  '5m': { seconds: 300, resolutionSeconds: 10 },
  '1h': { seconds: 3600, resolutionSeconds: 60 },
  '24h': { seconds: 86400, resolutionSeconds: 300 },
  '7d': { seconds: 604800, resolutionSeconds: 1800 },
} as const;

export type MetricHistoryRange = keyof typeof metricHistoryRanges;
export type MetricSummary = { average: number | null; peak: number | null; samples: number };
export type MetricHistoryPoint = {
  at: string;
  until: string;
  intervalSeconds: number;
  samples: number;
  cpuScope: 'host-proc' | 'runtime' | 'mixed';
  cpu: MetricSummary;
  memory: MetricSummary;
  download: MetricSummary;
  upload: MetricSummary;
};

export type MetricHistory = {
  range: MetricHistoryRange;
  from: string;
  to: string;
  resolutionSeconds: number;
  sampledEverySeconds: 10;
  retentionDays: 7;
  storage: 'persistent' | 'unavailable';
  collectorAvailable: boolean;
  lastSampleAt: string | null;
  persistedThrough: string | null;
  points: MetricHistoryPoint[];
};
