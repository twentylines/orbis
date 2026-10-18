export type HostProcess = {
  pid: number;
  name: string;
  cpuPercent: number | null;
  memoryBytes: number;
};

export type HostProcesses =
  | { available: false; reason: string }
  | {
      available: true;
      sampledAt: string;
      stale: boolean;
      scanned: number;
      readable: number;
      unreadable: number;
      compared: number;
      limited: boolean;
      byCpu: HostProcess[];
      byMemory: HostProcess[];
    };
