import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import si from 'systeminformation';

@Injectable()
export class SystemService {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly filesystem: FilesystemService,
  ) {}

  public async getSystemLoad() {
    const { currentLoad } = await si.currentLoad();

    const memResult = { total: 0, used: 0, available: 0 };

    try {
      const memInfo = await this.filesystem.readTextFile('/host/proc/meminfo');

      memResult.total = Number(memInfo?.toString().match(/MemTotal:\s+(\d+)/)?.[1] ?? 0) * 1024;
      memResult.available = Number(memInfo?.toString().match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) * 1024;
      memResult.used = memResult.total - memResult.available;
    } catch (e) {
      this.logger.error(`Unable to read /host/proc/meminfo: ${e}`);
    }

    const [disk0] = await si.fsSize();

    const disk = disk0 ?? { available: 0, size: 0 };
    const diskFree = Math.round(disk.available / 1024 / 1024 / 1024);
    const diskSize = Math.round(disk.size / 1024 / 1024 / 1024);
    const diskUsed = diskSize - diskFree;
    const percentUsed = Math.round((diskUsed / diskSize) * 100);

    const memoryTotal = Math.round(Number(memResult.total) / 1024 / 1024 / 1024);
    const memoryFree = Math.round(Number(memResult.available) / 1024 / 1024 / 1024);
    const percentUsedMemory = Math.round(((memoryTotal - memoryFree) / memoryTotal) * 100);

    return {
      diskUsed: diskUsed || 0,
      diskSize: diskSize || 0,
      percentUsed: percentUsed || 0,
      cpuLoad: currentLoad || 0,
      memoryTotal: memoryTotal || 0,
      percentUsedMemory: percentUsedMemory || 0,
    };
  }

  public async getTelemetry() {
    const [cpuResult, diskResult, networkResult, memoryResult] = await Promise.allSettled([
      si.currentLoad(),
      si.fsSize(),
      si.networkStats(),
      this.filesystem.readTextFile('/host/proc/meminfo'),
    ]);

    const cpu = cpuResult.status === 'fulfilled' ? cpuResult.value : null;
    const disks = diskResult.status === 'fulfilled' ? diskResult.value : [];
    const networks = networkResult.status === 'fulfilled' ? networkResult.value : [];
    const memoryText = memoryResult.status === 'fulfilled' ? memoryResult.value : null;
    const memory = (key: string) => {
      const match = memoryText?.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return match ? Number(match[1]) * 1024 : null;
    };
    const memoryTotal = memory('MemTotal');
    const memoryAvailable = memory('MemAvailable');
    const swapTotal = memory('SwapTotal');
    const swapFree = memory('SwapFree');
    const safe = (value: number | undefined | null) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

    return {
      sampledAt: new Date().toISOString(),
      cpu: {
        scope: 'runtime',
        totalPercent: safe(cpu?.currentLoad),
        perCorePercent: cpu?.cpus.map((core) => safe(core.load)) ?? [],
        uptimeSeconds: safe(si.time().uptime),
      },
      memory: {
        scope: 'host-proc',
        totalBytes: safe(memoryTotal),
        availableBytes: safe(memoryAvailable),
        swapTotalBytes: safe(swapTotal),
        swapFreeBytes: safe(swapFree),
      },
      filesystems: disks
        .filter((disk) => safe(disk.size) !== null)
        .map((disk) => ({
          mount: disk.mount,
          filesystem: disk.fs,
          sizeBytes: safe(disk.size),
          usedBytes: safe(disk.used),
          availableBytes: safe(disk.available),
          scope: 'runtime',
        })),
      network: networks.map((interfaceStats) => ({
        interface: interfaceStats.iface,
        rxBytesPerSecond: safe(interfaceStats.rx_sec),
        txBytesPerSecond: safe(interfaceStats.tx_sec),
        receivedBytes: safe(interfaceStats.rx_bytes),
        transmittedBytes: safe(interfaceStats.tx_bytes),
        scope: 'runtime',
      })),
    };
  }

  public async getLocalCertificate() {
    const { dataDir } = this.config.get('directories');
    const filePath = `${dataDir}/traefik/tls/cert.pem`;

    if (await this.filesystem.isFile(filePath)) {
      const file = await this.filesystem.readTextFile(filePath);
      return file;
    }
  }
}
