import { describe, expect, it, vi, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type Dockerode from 'dockerode';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { ContainerTelemetryService, containerUsage } from '../container-telemetry.service';

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
    const inspect = vi.fn().mockResolvedValue({
      State: { Status: 'running', Health: { Status: 'unhealthy', Log: ['must-not-appear'] } },
      Config: { Env: ['must-not-appear'] },
    });
    const stats = vi.fn().mockResolvedValue(statistics());
    docker.getContainer.mockReturnValue({ inspect, stats } as never);
    const service = new ContainerTelemetryService(docker, apps);
    const [first, second] = await Promise.all([service.read(), service.read()]);
    expect(first).toBe(second);
    expect(docker.listContainers).toHaveBeenCalledOnce();
    expect(first.containers[0]).toMatchObject({ appUrn: 'demo:official', health: 'unhealthy', cpuPercent: 10, memoryBytes: 800 });
    expect(JSON.stringify(first)).not.toContain('must-not-appear');
    expect(stats.mock.calls[0]?.[0]).toMatchObject({ stream: false, 'one-shot': true, abortSignal: expect.any(AbortSignal) });
    vi.advanceTimersByTime(5000);
    await service.read();
    expect(docker.listContainers).toHaveBeenCalledTimes(2);
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
