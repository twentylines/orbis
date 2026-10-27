export type DriveHealthState = 'passed' | 'warning' | 'failed' | 'unavailable' | 'sleeping';
export type DriveHealthPoint = {
  at: string;
  health: DriveHealthState;
  temperature: number | null;
  percentageUsed: number | null;
  pendingSectors: number | null;
  mediaErrors: number | null;
};
export type DriveHealth = {
  id: string;
  device: string;
  model: string;
  firmware: string | null;
  protocol: string;
  capacityBytes: number | null;
  health: DriveHealthState;
  reasons: string[];
  sampledAt: string;
  temperature: number | null;
  powerOnHours: number | null;
  percentageUsed: number | null;
  availableSpare: number | null;
  spareThreshold: number | null;
  reallocatedSectors: number | null;
  pendingSectors: number | null;
  uncorrectableSectors: number | null;
  mediaErrors: number | null;
  errorCount: number | null;
  unsafeShutdowns: number | null;
  bytesRead: number | null;
  bytesWritten: number | null;
  selfTest: { supported: boolean; running: boolean; remainingPercent: number | null; shortMinutes: number | null; extendedMinutes: number | null };
  tests: { type: string; status: string; passed: boolean | null; hours: number | null }[];
  errors: { summary: string; hours: number | null }[];
  attributes: { id: number; name: string; value: number | null; worst: number | null; threshold: number | null; raw: string; failing: boolean }[];
  history: DriveHealthPoint[];
};
export type DriveHealthSample =
  | { available: false; reason: string }
  | { available: true; sampledAt: string; stale: boolean; limited: boolean; historyAvailable: boolean; drives: DriveHealth[] };
