import { Inject, Injectable } from '@nestjs/common';
import type Dockerode from 'dockerode';
import type { ContainerReading, ContainerTelemetry } from '@runtipi/common/schemas';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from '../docker/docker.module';

const safe = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

export function containerUsage(stats: Dockerode.ContainerStats, previous?: Pick<Dockerode.ContainerStats, 'cpu_stats'>) {
  const current = stats.cpu_stats;
  const prior = previous?.cpu_stats ?? stats.precpu_stats;
  const delta = current?.cpu_usage?.total_usage - prior?.cpu_usage?.total_usage;
  const systemDelta = current?.system_cpu_usage - prior?.system_cpu_usage;
  const cpus = current?.online_cpus || current?.cpu_usage?.percpu_usage?.length;
  const cpuPercent = prior?.system_cpu_usage > 0 && systemDelta > 0 && delta >= 0 && cpus > 0 ? safe((delta / systemDelta) * cpus * 100) : null;
  const memory = stats.memory_stats;
  const cache = memory?.stats?.total_inactive_file ?? memory?.stats?.inactive_file ?? memory?.stats?.cache ?? 0;
  const usage = safe(memory?.usage);
  const memoryBytes = usage === null || cache > usage ? null : usage - (safe(cache) ?? 0);
  const networks = Object.values(stats.networks ?? {});
  const sumNetwork = (key: 'rx_bytes' | 'tx_bytes') => (networks.length ? networks.reduce((sum, item) => sum + (safe(item[key]) ?? 0), 0) : null);
  const block = stats.blkio_stats?.io_service_bytes_recursive;
  const sumBlock = (op: string) =>
    block ? block.filter((item) => item.op.toLowerCase() === op).reduce((sum, item) => sum + (safe(item.value) ?? 0), 0) : null;
  return {
    cpuPercent,
    memoryBytes,
    memoryLimitBytes: safe(memory?.limit),
    receivedBytes: sumNetwork('rx_bytes'),
    transmittedBytes: sumNetwork('tx_bytes'),
    blockReadBytes: sumBlock('read'),
    blockWriteBytes: sumBlock('write'),
  };
}

@Injectable()
export class ContainerTelemetryService {
  private cache?: { expiresAt: number; value: ContainerTelemetry };
  private pending?: Promise<ContainerTelemetry>;
  private previous = new Map<string, Pick<Dockerode.ContainerStats, 'cpu_stats'>>();

  constructor(
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly apps: AppsRepository,
  ) {}

  async read(): Promise<ContainerTelemetry> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    this.pending ??= this.sample()
      .then((value) => {
        this.cache = { value, expiresAt: Date.now() + 5000 };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async sample(): Promise<ContainerTelemetry> {
    const signal = AbortSignal.timeout(4000);
    try {
      const listOptions = { all: true, abortSignal: signal };
      const [all, apps] = await Promise.all([this.docker.listContainers(listOptions), this.apps.getApps()]);
      const projects = new Map(apps.map((app) => [`${app.appName}_${app.appStoreSlug}`, `${app.appName}:${app.appStoreSlug}`]));
      const liveIds = new Set(all.filter((item) => item.State === 'running').map((item) => item.Id));
      for (const id of this.previous.keys()) if (!liveIds.has(id)) this.previous.delete(id);
      const selected = all.slice(0, 200);
      const readings: ContainerReading[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, selected.length) }, async () => {
          while (next < selected.length) {
            const info = selected[next++];
            if (!info) break;
            const container = this.docker.getContainer(info.Id);
            const inspectOptions = { size: false, abortSignal: signal };
            const statsOptions = { stream: false as const, 'one-shot': true, abortSignal: signal };
            const [inspection, statistics] = await Promise.allSettled([
              container.inspect(inspectOptions),
              info.State === 'running' ? container.stats(statsOptions) : Promise.resolve(null),
            ]);
            const state = inspection.status === 'fulfilled' ? inspection.value.State.Status : info.State;
            const dockerHealth = inspection.status === 'fulfilled' ? inspection.value.State.Health?.Status : undefined;
            const health: ContainerReading['health'] =
              dockerHealth === 'healthy' || dockerHealth === 'unhealthy' || dockerHealth === 'starting'
                ? dockerHealth
                : inspection.status === 'fulfilled'
                  ? 'not-configured'
                  : 'unknown';
            const stats = statistics.status === 'fulfilled' ? statistics.value : null;
            const metrics = stats
              ? containerUsage(stats, this.previous.get(info.Id))
              : {
                  cpuPercent: null,
                  memoryBytes: null,
                  memoryLimitBytes: null,
                  receivedBytes: null,
                  transmittedBytes: null,
                  blockReadBytes: null,
                  blockWriteBytes: null,
                };
            if (stats) this.previous.set(info.Id, { cpu_stats: stats.cpu_stats });
            readings.push({
              id: info.Id,
              name: info.Names[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12),
              appUrn: info.Labels['runtipi.appurn'] ?? projects.get(info.Labels['com.docker.compose.project'] ?? '') ?? null,
              service: info.Labels['com.docker.compose.service'] ?? null,
              state,
              health,
              ...metrics,
              statsAvailable: stats !== null,
            });
          }
        }),
      );
      return {
        sampledAt: new Date().toISOString(),
        available: true,
        containers: readings.sort((left, right) => left.name.localeCompare(right.name)),
        omitted: all.length - selected.length,
      };
    } catch {
      this.previous.clear();
      return { sampledAt: new Date().toISOString(), available: false, containers: [], omitted: 0 };
    }
  }
}
