export type HostFilesystem = {
  mount: string;
  filesystem: string;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  readOnly: boolean;
};

export type HostNetwork = {
  interface: string;
  state: 'up' | 'down' | 'unknown';
  speedMbps: number | null;
  receivedBytes: number | null;
  transmittedBytes: number | null;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
};

export type HostDisk = {
  device: string;
  readBytes: number | null;
  writtenBytes: number | null;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  busyPercent: number | null;
  inFlight: number | null;
};

export type HostTelemetry =
  | { available: false; reason: string }
  | {
      available: true;
      sampledAt: string;
      stale: boolean;
      filesystems: HostFilesystem[];
      network: HostNetwork[];
      disks: HostDisk[];
      omitted: { filesystems: number; network: number; disks: number };
      unavailable: ('filesystems' | 'network' | 'disks')[];
    };
