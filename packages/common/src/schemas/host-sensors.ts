export type HostSensorStatus = 'available' | 'fault' | 'disabled' | 'unavailable';

export type HostTemperature = {
  id: string;
  label: string;
  chip: string;
  status: HostSensorStatus;
  celsius: number | null;
  criticalCelsius: number | null;
};

export type HostFan = {
  id: string;
  label: string;
  chip: string;
  status: HostSensorStatus;
  rpm: number | null;
};

export type HostGpu = {
  id: string;
  label: string;
  vendor: string | null;
  driver: string | null;
  utilizationPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
};

export type HostSensors =
  | { available: false; reason: string }
  | {
      available: true;
      sampledAt: string;
      stale: boolean;
      limited: boolean;
      unreadable: number;
      temperatures: HostTemperature[];
      fans: HostFan[];
      gpus: HostGpu[];
      omitted: { temperatures: number; fans: number; gpus: number };
      unavailable: ('temperatures' | 'fans' | 'gpus')[];
    };
