import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HostMemoryService, type HostMemory, type MemoryScope } from './host-memory.service';
import { X509Certificate } from 'node:crypto';
import si from 'systeminformation';
import fs from 'node:fs/promises';
import { cpuUsage, parseHostCpuStat, reportedCpuClockGHz, reportedCpuModel, type CpuSnapshot } from './host-cpu';
import { parseRuntimeNetwork, runtimeNetworkRates, type RuntimeNetworkSnapshot } from './runtime-network';
import { freshSentinelSample, readSentinelSystemReadings } from './sentinel-system-readings';

const safe = (value: number | undefined | null) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

@Injectable()
export class SystemService {
  private previousHostCpu: CpuSnapshot | null = null;
  private previousHostCpuAt: number | null = null;
  private lastHostReadingsAt: number | null = null;
  private previousRuntimeNetwork: RuntimeNetworkSnapshot | null = null;
  private networkInterface: { expiresAt: number; name: string } | null = null;
  private telemetryCache: { expiresAt: number; result: Awaited<ReturnType<SystemService['readTelemetry']>> } | null = null;
  private telemetryInFlight: Promise<Awaited<ReturnType<SystemService['readTelemetry']>>> | null = null;
  private disksCache: { expiresAt: number; result: Awaited<ReturnType<typeof si.fsSize>> } | null = null;
  private disksInFlight: Promise<Awaited<ReturnType<typeof si.fsSize>>> | null = null;

  constructor(
    private readonly config: ConfigurationService,
    private readonly filesystem: FilesystemService,
    private readonly hostMemory: HostMemoryService,
  ) {}

  public async getSystemLoad() {
    const sample = await this.getTelemetry();
    const { totalBytes: total, availableBytes: available, scope } = sample.memory;
    if (total === null || total <= 0 || available === null || scope === 'unavailable')
      throw new ServiceUnavailableException('Memory usage is temporarily unavailable');
    const memResult = { total, used: total - available, source: scope === 'host-proc' ? ('host' as const) : scope };
    const [disk0] = sample.filesystems;

    const diskFree = Math.round((disk0?.availableBytes ?? 0) / 1024 / 1024 / 1024);
    const diskSize = Math.round((disk0?.sizeBytes ?? 0) / 1024 / 1024 / 1024);
    const diskUsed = diskSize - diskFree;
    const percentUsed = Math.round((diskUsed / diskSize) * 100);

    const memoryTotal = Math.round(Number(memResult.total) / 1024 / 1024 / 1024);
    const percentUsedMemory = memResult.total > 0 ? Math.round((memResult.used / memResult.total) * 1000) / 10 : 0;

    return {
      diskUsed: diskUsed || 0,
      diskSize: diskSize || 0,
      percentUsed: percentUsed || 0,
      cpuLoad: sample.cpu.totalPercent || 0,
      memoryTotal: memoryTotal || 0,
      percentUsedMemory: percentUsedMemory || 0,
      memorySource: memResult.source,
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

  private async readCpuInformation() {
    try {
      const mounted = await this.filesystem.readTextFile('/host/proc/cpuinfo');
      if (mounted?.trim()) return mounted;
    } catch {
      // Older installations mounted host CPU counters without cpuinfo.
    }
    return fs.readFile('/proc/cpuinfo', 'utf8');
  }

  private async readLegacyHostSystem() {
    const [cpuStatResult, uptimeResult, memoryResult, cpuInfoResult] = await Promise.allSettled([
      this.filesystem.readTextFile('/host/proc/stat'),
      this.filesystem.readTextFile('/host/proc/uptime'),
      this.hostMemory.getMemory(),
      this.readCpuInformation(),
    ]);

    const hostCounters = cpuStatResult.status === 'fulfilled' && cpuStatResult.value ? parseHostCpuStat(cpuStatResult.value) : null;
    const now = Date.now();
    if (this.previousHostCpuAt !== null && (now - this.previousHostCpuAt > 30_000 || now < this.previousHostCpuAt)) this.previousHostCpu = null;
    const hostCpu = hostCounters?.has('cpu') ? cpuUsage(this.previousHostCpu, hostCounters) : null;
    this.previousHostCpu = hostCounters?.has('cpu') ? hostCounters : null;
    this.previousHostCpuAt = hostCounters?.has('cpu') ? now : null;
    const runtimeCpu = hostCpu ? null : await si.currentLoad().catch(() => null);
    const uptime = uptimeResult.status === 'fulfilled' && uptimeResult.value ? Number(uptimeResult.value.split(/\s+/)[0]) : null;
    const memory: HostMemory | null = memoryResult.status === 'fulfilled' ? memoryResult.value : null;
    const memoryScope = memory?.source === 'host' ? 'host-proc' : (memory?.source ?? 'unavailable');
    const clock = reportedCpuClockGHz(cpuInfoResult.status === 'fulfilled' ? cpuInfoResult.value : null);
    const model = reportedCpuModel(cpuInfoResult.status === 'fulfilled' ? cpuInfoResult.value : null);
    return {
      sampledAt: Date.now(),
      cpu: {
        scope: hostCpu ? 'host-proc' : 'runtime',
        ...(model ? { model } : {}),
        totalPercent: safe(hostCpu?.totalPercent ?? runtimeCpu?.currentLoad),
        perCorePercent: hostCpu?.perCorePercent ?? runtimeCpu?.cpus.map((core) => safe(core.load)) ?? [],
        uptimeSeconds: safe(uptime ?? si.time().uptime),
        ...(clock === null ? {} : { reportedClockGHz: clock }),
      },
      memory: {
        scope: memoryScope as MemoryScope,
        totalBytes: safe(memory?.total),
        availableBytes: memory ? safe(memory.total - memory.used) : null,
        swapTotalBytes: safe(memory?.swapTotal),
        swapFreeBytes: safe(memory?.swapFree),
      },
    };
  }

  private async readHostSystem() {
    const preferred = await readSentinelSystemReadings();
    if (preferred && (this.lastHostReadingsAt === null || preferred.sampledAt >= this.lastHostReadingsAt))
      return { source: 'sentinel' as const, sample: preferred };
    return { source: 'legacy' as const, sample: await this.readLegacyHostSystem() };
  }

  private async readTelemetry() {
    const [host, diskResult, networkResult] = await Promise.all([
      this.readHostSystem(),
      this.getDisks().catch(() => []),
      this.readRuntimeNetwork().catch(() => []),
    ]);
    const preferred = host.source === 'sentinel' && freshSentinelSample(host.sample.sampledAt);
    const system = host.source === 'sentinel' && !preferred ? await this.readLegacyHostSystem() : host.sample;
    if (preferred) {
      // A return to the legacy provider needs a new baseline, not an interval across two providers.
      this.previousHostCpu = this.previousHostCpuAt = null;
    }
    this.lastHostReadingsAt = system.sampledAt;
    return {
      sampledAt: new Date(system.sampledAt).toISOString(),
      cpu: system.cpu,
      memory: system.memory,
      filesystems: diskResult
        .filter((disk) => safe(disk.size) !== null)
        .map((disk) => ({
          mount: disk.mount,
          filesystem: disk.fs,
          sizeBytes: safe(disk.size),
          usedBytes: safe(disk.used),
          availableBytes: safe(disk.available),
          scope: 'runtime',
        })),
      network: networkResult.map((interfaceStats) => ({
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
    try {
      for (const name of ['ca.pem', 'cert.pem']) {
        const filePath = `${dataDir}/traefik/tls/${name}`;
        if (!(await this.filesystem.isFile(filePath))) continue;
        const file = await this.filesystem.readTextFile(filePath);
        if (file && file.length <= 65536) {
          const blocks = file.match(/-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g);
          if (blocks?.length === 1 && blocks[0]) {
            const root = new X509Certificate(blocks[0]);
            if (root.ca && root.subject === root.issuer && root.verify(root.publicKey)) return root.toString();
          }
        }
        // An invalid current root must not expose another file as the trust certificate.
        break;
      }
    } catch {
      // Certificate parse and read failures must not expose file contents or server paths.
    }
    throw new NotFoundException('The local HTTPS certificate is not available. Finish certificate setup on the server, then try again.');
  }
}
