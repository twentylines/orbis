import { Inject, Injectable } from '@nestjs/common';
import type Dockerode from 'dockerode';
import type { ContainerReading, ContainerTelemetry } from '@runtipi/common/schemas';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from '../docker/docker.module';

const safe = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const safeInteger = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;

function checkTime(value: unknown) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() + 5000 ? new Date(timestamp).toISOString() : null;
}

function healthcheckIssue(output: unknown): NonNullable<ContainerReading['readiness']>['lastCheckIssue'] {
  if (typeof output !== 'string') return null;
  const text = output.slice(0, 4096);
  if (/curl: \(6\)|could not resolve|name or service not known|EAI_AGAIN/i.test(text)) return 'dns';
  if (/curl: \(28\)|timed? out|healthcheck exceeded timeout/i.test(text)) return 'timeout';
  if (/curl: \(7\)|connection refused|ECONNREFUSED|failed to connect|could not connect to server/i.test(text)) return 'connection';
  if (/permission denied|operation not permitted/i.test(text)) return 'permission';
  if (/HTTP\/\S+\s+(?:401|403)\b|\bUnauthorized\b|\bForbidden\b/i.test(text)) return 'http-auth';
  if (/curl: \(22\)|HTTP\/\S+\s+[45]\d\d\b/i.test(text)) return 'http-error';
  if (/command not found|executable (?:file )?not found/i.test(text)) return 'command-missing';
  return null;
}

function healthcheckPort(test: string[] | undefined) {
  if (!Array.isArray(test) || test.length > 16 || test.some((part) => typeof part !== 'string' || part.length > 4096)) return null;
  const ports = new Set<number>();
  for (const match of test.join('\n').matchAll(/(?:^|[\s/'"])(?:localhost|127\.0\.0\.1|\[::1\]):([^/\s'"?&#;|)]+)/g)) {
    if (!match[1] || !/^\d{1,5}$/.test(match[1])) return null;
    const port = safeInteger(Number(match[1]), 1, 65535);
    if (port === null) return null;
    ports.add(port);
  }
  return ports.size === 1 ? [...ports][0] : null;
}

function configuredPort(environment: string[] | undefined) {
  for (let index = (environment?.length ?? 0) - 1; index >= 0; index--) {
    const entry = environment?.[index];
    if (typeof entry !== 'string' || !entry.startsWith('PORT=')) continue;
    const setting = entry.slice(5);
    return /^\d{1,5}$/.test(setting) ? safeInteger(Number(setting), 1, 65535) : null;
  }
  return null;
}

export function containerReadiness(inspection: Dockerode.ContainerInspectInfo): NonNullable<ContainerReading['readiness']> {
  const health = inspection.State.Health;
  const lastCheck = Array.isArray(health?.Log) ? health.Log.at(-1) : undefined;
  const interval = safeInteger(inspection.Config?.Healthcheck?.Interval, 1);
  const startPeriod = safeInteger(inspection.Config?.Healthcheck?.StartPeriod);
  const exitCode = safeInteger(lastCheck?.ExitCode, -2147483648, 2147483647);
  const failed = (health?.Status === 'unhealthy' || health?.Status === 'starting') && exitCode !== null && exitCode !== 0;
  return {
    failingStreak: safeInteger(health?.FailingStreak),
    lastCheckExitCode: exitCode,
    lastCheckAt: checkTime(lastCheck?.End),
    intervalSeconds: interval === null ? null : interval / 1_000_000_000,
    startPeriodSeconds: startPeriod === null ? null : startPeriod / 1_000_000_000,
    oomKilled: typeof inspection.State.OOMKilled === 'boolean' ? inspection.State.OOMKilled : null,
    restartCount: safeInteger(inspection.RestartCount),
    lastCheckIssue: failed ? healthcheckIssue(lastCheck?.Output) : null,
    healthcheckPort: failed ? healthcheckPort(inspection.Config?.Healthcheck?.Test) : null,
    configuredPort: failed ? configuredPort(inspection.Config?.Env) : null,
  };
}

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
              readiness: inspection.status === 'fulfilled' ? containerReadiness(inspection.value) : null,
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
