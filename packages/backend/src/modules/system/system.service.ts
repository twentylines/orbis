import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import si from 'systeminformation';
import fs from 'node:fs/promises';
import { cpuUsage, parseHostCpuStat, reportedCpuClockGHz, reportedCpuModel, type CpuSnapshot } from './host-cpu';
import { parseRuntimeNetwork, runtimeNetworkRates, type RuntimeNetworkSnapshot } from './runtime-network';

@Injectable()
export class SystemService {
  private previousHostCpu: CpuSnapshot | null = null;
  private previousHostCpuAt: number | null = null;
  private previousRuntimeNetwork: RuntimeNetworkSnapshot | null = null;
  private networkInterface: { expiresAt: number; name: string } | null = null;
  private telemetryCache: { expiresAt: number; result: Awaited<ReturnType<SystemService['readTelemetry']>> } | null = null;
  private telemetryInFlight: Promise<Awaited<ReturnType<SystemService['readTelemetry']>>> | null = null;
  private disksCache: { expiresAt: number; result: Awaited<ReturnType<typeof si.fsSize>> } | null = null;
  private disksInFlight: Promise<Awaited<ReturnType<typeof si.fsSize>>> | null = null;

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
    if (this.telemetryCache && Date.now() < this.telemetryCache.expiresAt) return this.telemetryCache.result;
    if (!this.telemetryInFlight) {
      this.telemetryInFlight = this.readTelemetry()
        .then((result) => {
          this.telemetryCache = { expiresAt: Date.now() + 1000, result };
          return result;
        })
        .finally(() => {
          this.telemetryInFlight = null;
        });
    }
    return this.telemetryInFlight;
  }

  private getDisks() {
    if (this.disksCache && Date.now() < this.disksCache.expiresAt) return Promise.resolve(this.disksCache.result);
    if (!this.disksInFlight) {
      this.disksInFlight = si
        .fsSize()
        .then(
          (result) => {
            this.disksCache = { expiresAt: Date.now() + 10000, result };
            return result;
          },
          () => {
            this.disksCache = { expiresAt: Date.now() + 2000, result: [] };
            return [];
          },
        )
        .finally(() => {
          this.disksInFlight = null;
        });
    }
    return this.disksInFlight;
  }

  private async readRuntimeNetwork() {
    try {
      const counters = parseRuntimeNetwork(await fs.readFile('/proc/net/dev', 'utf8'));
      if (!counters.size) throw new Error('No runtime network counters');
      if (!this.networkInterface || Date.now() >= this.networkInterface.expiresAt) {
        this.networkInterface = { name: await si.networkInterfaceDefault().catch(() => ''), expiresAt: Date.now() + 10000 };
      }
      const current =
        counters.get(this.networkInterface.name) ?? [...counters.values()].find((item) => item.iface !== 'lo') ?? counters.values().next().value;
      if (!current) return [];
      const snapshot = { ...current, at: performance.now() };
      const reading = runtimeNetworkRates(this.previousRuntimeNetwork, snapshot);
      this.previousRuntimeNetwork = snapshot;
      return [reading];
    } catch {
      this.previousRuntimeNetwork = null;
      return si.networkStats();
    }
  }

  private async readTelemetry() {
    const [cpuStatResult, uptimeResult, diskResult, networkResult, memoryResult, cpuInfoResult] = await Promise.allSettled([
      this.filesystem.readTextFile('/host/proc/stat'),
      this.filesystem.readTextFile('/host/proc/uptime'),
      this.getDisks(),
      this.readRuntimeNetwork(),
      this.filesystem.readTextFile('/host/proc/meminfo'),
      this.filesystem.readTextFile('/host/proc/cpuinfo'),
    ]);

    const hostCounters = cpuStatResult.status === 'fulfilled' && cpuStatResult.value ? parseHostCpuStat(cpuStatResult.value) : null;
    const now = Date.now();
    if (this.previousHostCpuAt !== null && (now - this.previousHostCpuAt > 30_000 || now < this.previousHostCpuAt)) this.previousHostCpu = null;
    const hostCpu = hostCounters?.has('cpu') ? cpuUsage(this.previousHostCpu, hostCounters) : null;
    this.previousHostCpu = hostCounters?.has('cpu') ? hostCounters : null;
    this.previousHostCpuAt = hostCounters?.has('cpu') ? now : null;
    const runtimeCpu = hostCpu ? null : await si.currentLoad().catch(() => null);
    const uptime = uptimeResult.status === 'fulfilled' && uptimeResult.value ? Number(uptimeResult.value.split(/\s+/)[0]) : null;
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
    const clock = reportedCpuClockGHz(cpuInfoResult.status === 'fulfilled' ? cpuInfoResult.value : null);
    const model = reportedCpuModel(cpuInfoResult.status === 'fulfilled' ? cpuInfoResult.value : null);
    const safe = (value: number | undefined | null) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

    return {
      sampledAt: new Date().toISOString(),
      cpu: {
        scope: hostCpu ? 'host-proc' : 'runtime',
        ...(model ? { model } : {}),
        totalPercent: safe(hostCpu?.totalPercent ?? runtimeCpu?.currentLoad),
        perCorePercent: hostCpu?.perCorePercent ?? runtimeCpu?.cpus.map((core) => safe(core.load)) ?? [],
        uptimeSeconds: safe(uptime ?? si.time().uptime),
        ...(clock === null ? {} : { reportedClockGHz: clock }),
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
