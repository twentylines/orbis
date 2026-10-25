import { describe, expect, it, vi, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type Dockerode from 'dockerode';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { ContainerTelemetryService, containerReadiness, containerUsage } from '../container-telemetry.service';

const statistics = (memory = { usage: 1000, limit: 4000, stats: { inactive_file: 200 } }) =>
  ({
    cpu_stats: { cpu_usage: { total_usage: 150, percpu_usage: [1, 1] }, system_cpu_usage: 2000, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: memory,
    networks: { eth0: { rx_bytes: 400, tx_bytes: 700 } },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'Read', value: 12 },
        { op: 'Write', value: 34 },
      ],
    },
  }) as unknown as Dockerode.ContainerStats;

afterEach(() => vi.useRealTimers());

describe('Docker telemetry', () => {
  it('uses Docker CPU deltas and excludes reclaimable file cache on both cgroup layouts', () => {
    expect(containerUsage(statistics())).toMatchObject({
      cpuPercent: 10,
      memoryBytes: 800,
      memoryLimitBytes: 4000,
      receivedBytes: 400,
      transmittedBytes: 700,
      blockReadBytes: 12,
      blockWriteBytes: 34,
    });
    expect(containerUsage(statistics({ usage: 1000, limit: 4000, stats: { total_inactive_file: 300 } } as never)).memoryBytes).toBe(700);
    const first = statistics();
    first.precpu_stats = {} as never;
    expect(containerUsage(first).cpuPercent).toBeNull();
    expect(
      containerUsage(first, { ...statistics(), cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000 } } as never).cpuPercent,
    ).toBeNull();
  });

  it('shares samples, joins legacy Compose apps, and only returns selected safe fields', async () => {
    vi.useFakeTimers();
    const docker = mock<Dockerode>();
    const apps = mock<AppsRepository>();
    apps.getApps.mockResolvedValue([{ appName: 'demo', appStoreSlug: 'official' }] as never);
    docker.listContainers.mockResolvedValue([
      {
        Id: 'container-a',
        Names: ['/demo'],
        State: 'running',
        Labels: { 'com.docker.compose.project': 'demo_official', 'private.value': 'must-not-appear' },
        Command: 'must-not-appear',
      },
    ] as never);
    const checkedAt = new Date(Date.now() - 1000).toISOString();
    const inspect = vi.fn().mockResolvedValue({
      State: {
        Status: 'running',
        OOMKilled: false,
        Health: { Status: 'unhealthy', FailingStreak: 3, Log: [{ End: checkedAt, ExitCode: 1, Output: 'must-not-appear' }] },
      },
      RestartCount: 2,
      Config: { Env: ['must-not-appear'], Healthcheck: { Test: ['CMD-SHELL', 'must-not-appear'], Interval: 30e9, StartPeriod: 60e9 } },
    });
    const stats = vi.fn().mockResolvedValue(statistics());
    docker.getContainer.mockReturnValue({ inspect, stats } as never);
    const service = new ContainerTelemetryService(docker, apps);
    const [first, second] = await Promise.all([service.read(), service.read()]);
    expect(first).toBe(second);
    expect(docker.listContainers).toHaveBeenCalledOnce();
    expect(first.containers[0]).toMatchObject({
      appUrn: 'demo:official',
      health: 'unhealthy',
      cpuPercent: 10,
      memoryBytes: 800,
      readiness: {
        failingStreak: 3,
        lastCheckExitCode: 1,
        lastCheckAt: checkedAt,
        intervalSeconds: 30,
        startPeriodSeconds: 60,
        oomKilled: false,
        restartCount: 2,
      },
    });
    expect(JSON.stringify(first)).not.toContain('must-not-appear');
    expect(stats.mock.calls[0]?.[0]).toMatchObject({ stream: false, 'one-shot': true, abortSignal: expect.any(AbortSignal) });
    vi.advanceTimersByTime(5000);
    await service.read();
    expect(docker.listContainers).toHaveBeenCalledTimes(2);
  });

  it('preserves zero readiness counts, converts nanoseconds, and only reports the latest check', () => {
    const result = containerReadiness({
      State: {
        OOMKilled: true,
        Health: { FailingStreak: 0, Log: [{ ExitCode: 1 }, { ExitCode: 0, End: '2026-01-01T00:00:00.123456789Z' }] },
      },
      RestartCount: 0,
      Config: { Healthcheck: { Interval: 500_000_000, StartPeriod: 0 } },
    } as never);
    expect(result).toEqual({
      failingStreak: 0,
      lastCheckExitCode: 0,
      lastCheckAt: '2026-01-01T00:00:00.123Z',
      intervalSeconds: 0.5,
      startPeriodSeconds: 0,
      oomKilled: true,
      restartCount: 0,
    });
    expect(containerReadiness({ State: {}, Config: {} } as never)).toEqual({
      failingStreak: null,
      lastCheckExitCode: null,
      lastCheckAt: null,
      intervalSeconds: null,
      startPeriodSeconds: null,
      oomKilled: null,
      restartCount: null,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -1, false, '4'])(
    'rejects invalid readiness counters and durations %j without leaking source values',
    (value) => {
      const result = containerReadiness({
        State: { OOMKilled: 'private', Health: { FailingStreak: value, Log: [{ ExitCode: 'private', End: '/private', Output: 'private' }] } },
        RestartCount: value,
        Config: { Env: ['private'], Healthcheck: { Test: ['private'], Interval: value, StartPeriod: value } },
      } as never);
      expect(Object.values(result)).toEqual(Array(7).fill(null));
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );

  it.each(['0001-01-01T00:00:00Z', 'not a timestamp', new Date(Date.now() + 60_000).toISOString()])(
    'does not publish an invalid or uninitialized latest check time %s',
    (End) => {
      const result = containerReadiness({ State: { Health: { Log: [{ ExitCode: -1, End }] } }, Config: { Healthcheck: { Interval: 0 } } } as never);
      expect(result.lastCheckAt).toBeNull();
      expect(result.lastCheckExitCode).toBe(-1);
      expect(result.intervalSeconds).toBeNull();
    },
  );

  it('keeps inspection failures unknown without inventing readiness metadata or dropping other containers', async () => {
    const docker = mock<Dockerode>();
    const apps = mock<AppsRepository>();
    apps.getApps.mockResolvedValue([]);
    docker.listContainers.mockResolvedValue(
      ['unreadable', 'running'].map((Id) => ({ Id, Names: [`/${Id}`], State: 'running', Labels: {} })) as never,
    );
    docker.getContainer.mockImplementation(
      (id) =>
        ({
          inspect:
            id === 'unreadable' ? vi.fn().mockRejectedValue(new Error('private')) : vi.fn().mockResolvedValue({ State: { Status: 'running' } }),
          stats: vi.fn().mockResolvedValue(statistics()),
        }) as never,
    );
    const result = await new ContainerTelemetryService(docker, apps).read();
    expect(result.available).toBe(true);
    expect(result.containers).toHaveLength(2);
    expect(result.containers.find((item) => item.id === 'unreadable')).toMatchObject({ health: 'unknown', readiness: null });
    expect(result.containers.find((item) => item.id === 'running')).toMatchObject({ health: 'not-configured' });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('does not report stopped containers as healthy or manufacture unavailable resource readings', async () => {
    const docker = mock<Dockerode>();
    const apps = mock<AppsRepository>();
    apps.getApps.mockResolvedValue([]);
    docker.listContainers.mockResolvedValue([{ Id: 'stopped', Names: ['/stopped'], State: 'exited', Labels: {} }] as never);
    const stats = vi.fn();
    docker.getContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ State: { Status: 'exited' } }), stats } as never);
    const result = await new ContainerTelemetryService(docker, apps).read();
    expect(stats).not.toHaveBeenCalled();
    expect(result.containers[0]).toMatchObject({
      state: 'exited',
      health: 'not-configured',
      cpuPercent: null,
      memoryBytes: null,
      statsAvailable: false,
    });
    docker.listContainers.mockRejectedValue(new Error('daemon disconnected'));
    expect(await new ContainerTelemetryService(docker, apps).read()).toMatchObject({ available: false, containers: [] });
  });
});
