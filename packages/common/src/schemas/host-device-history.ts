import type { MetricHistoryRange, MetricSummary } from './metric-history.js';

export type HostHistorySelection = { kind: 'network' | 'disk'; name: string };
export type HostHistoryDevice = HostHistorySelection & { lastSeenAt: string; present: boolean };
export type HostHistoryPoint = {
  at: string;
  until: string;
  intervalSeconds: number;
  samples: number;
  sourceId: string | null;
  inbound: MetricSummary;
  outbound: MetricSummary;
  busy: MetricSummary;
};
export type HostDeviceHistory = {
  range: MetricHistoryRange;
  from: string;
  to: string;
  resolutionSeconds: number;
  sampledEverySeconds: 10;
  retentionDays: 7;
  seriesLimit: 64;
  storage: 'persistent' | 'unavailable';
  collectorAvailable: boolean;
  reason: string | null;
  unidentifiedDevices: number;
  omittedDevices: number;
  evictedDevices: number;
  lastSampleAt: string | null;
  persistedThrough: string | null;
  devices: HostHistoryDevice[];
  selected: HostHistorySelection | null;
  points: HostHistoryPoint[];
};
