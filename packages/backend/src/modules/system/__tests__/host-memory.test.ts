import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { fsMock } from '@/tests/__mocks__/fs';
import { ServiceUnavailableException } from '@nestjs/common';
import os from 'node:os';
import { fromPartial } from '@total-typescript/shoehorn';
import type Dockerode from 'dockerode';
import { afterEach, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { HostMemoryService } from '../host-memory.service';
import { SystemService } from '../system.service';

vi.mock('systeminformation', () => ({
  default: {
    currentLoad: async () => ({ currentLoad: 10, cpus: [] }),
    fsSize: async () => [],
    time: () => ({ uptime: 0 }),
  },
}));

const GB = 1024 ** 3;
const LXCFS_MOUNTINFO = '1010 1000 0:60 /proc/meminfo /host/proc/meminfo ro,relatime - fuse.lxcfs lxcfs rw';

afterEach(() => vi.restoreAllMocks());

const setup = (files: Record<string, string>, hostTotal = 0) => {
  fsMock.default.__applyMockFiles(files);

  const config = mock<ConfigurationService>();
  config.get.mockReturnValue(hostTotal);

  const docker = mock<Dockerode>();
  const stats = vi.fn<() => Promise<Dockerode.ContainerStats>>();
  docker.listContainers.mockResolvedValue([fromPartial({ Id: 'one' })]);
  docker.getContainer.mockReturnValue(fromPartial({ stats }));
  stats.mockResolvedValue(fromPartial({ memory_stats: { usage: 3 * GB, stats: {} } }));

  const service = new HostMemoryService(mock<LoggerService>(), config, new FilesystemService(mock<LoggerService>()), docker);

  return { service, docker };
};

test('reads host meminfo and ignores cgroups outside LXC', async () => {
  const { service } = setup({
    '/host/proc/meminfo': 'MemTotal: 8388608 kB\nMemAvailable: 6291456 kB\n',
    '/host/sys/fs/cgroup/memory.current': `${7 * GB}`,
    '/host/sys/fs/cgroup/memory.stat': 'inactive_file 0',
  });

  expect(await service.getMemory()).toEqual({ used: 2 * GB, total: 8 * GB, source: 'host', swapTotal: null, swapFree: null });
});

test('uses the LXC cgroup limit instead of a smaller reader MemTotal', async () => {
  const { service } = setup({
    '/proc/self/mountinfo': LXCFS_MOUNTINFO,
    '/host/proc/meminfo': 'MemTotal: 1048576 kB\nMemAvailable: 524288 kB\n',
    '/host/sys/fs/cgroup/memory.current': `${5 * GB}`,
    '/host/sys/fs/cgroup/memory.stat': 'inactive_file 0',
    '/host/sys/fs/cgroup/memory.max': `${8 * GB}`,
  });

  expect(await service.getMemory()).toEqual({ used: 5 * GB, total: 8 * GB, source: 'cgroup' });
});

test('uses the CLI host total when the LXC limit is hidden by the cgroup namespace', async () => {
  const { service } = setup(
    {
      '/proc/self/mountinfo': LXCFS_MOUNTINFO,
      '/host/proc/meminfo': 'MemTotal: 1048576 kB\nMemAvailable: 524288 kB\n',
      '/host/sys/fs/cgroup/memory.current': `${5 * GB}`,
      '/host/sys/fs/cgroup/memory.stat': 'inactive_file 0',
      '/host/sys/fs/cgroup/memory.max': 'max',
    },
    8 * GB,
  );

  expect(await service.getMemory()).toEqual({ used: 5 * GB, total: 8 * GB, source: 'cgroup' });
});

test('honors a live cgroup limit below the host total captured at startup', async () => {
  const { service } = setup(
    {
      '/proc/self/mountinfo': LXCFS_MOUNTINFO,
      '/host/proc/meminfo': 'MemTotal: 8388608 kB\n',
      '/host/sys/fs/cgroup/memory.current': `${5 * GB}`,
      '/host/sys/fs/cgroup/memory.stat': `inactive_file ${GB}\nactive_file ${GB}\nslab_reclaimable ${GB}`,
      '/host/sys/fs/cgroup/memory.max': `${6 * GB}`,
    },
    8 * GB,
  );

  expect(await service.getMemory()).toEqual({ used: 2 * GB, total: 6 * GB, source: 'cgroup' });
});

test('estimates Docker memory when the CLI cgroup mount is missing', async () => {
  const { service } = setup(
    {
      '/proc/self/mountinfo': LXCFS_MOUNTINFO,
      '/host/proc/meminfo': 'MemTotal: 1048576 kB\n',
    },
    8 * GB,
  );

  expect(await service.getMemory()).toEqual({ used: 3 * GB, total: 8 * GB, source: 'containers' });
});

test('retries cgroup accounting after an earlier read was unavailable', async () => {
  const { service } = setup({
    '/proc/self/mountinfo': LXCFS_MOUNTINFO,
    '/host/proc/meminfo': 'MemTotal: 8388608 kB\n',
  });

  expect((await service.getMemory()).source).toBe('containers');

  fsMock.default.__applyMockFiles({
    '/host/sys/fs/cgroup/memory.current': `${5 * GB}`,
    '/host/sys/fs/cgroup/memory.stat': 'inactive_file 0',
    '/host/sys/fs/cgroup/memory.max': `${8 * GB}`,
  });

  expect(await service.getMemory()).toEqual({ used: 5 * GB, total: 8 * GB, source: 'cgroup' });
});

test('reports unavailable instead of zero on an initial Docker failure and retries immediately', async () => {
  const { service, docker } = setup({
    '/proc/self/mountinfo': LXCFS_MOUNTINFO,
    '/host/proc/meminfo': 'MemTotal: 8388608 kB\n',
  });
  docker.listContainers.mockRejectedValueOnce(new Error('temporary socket error'));

  await expect(service.getMemory()).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(await service.getMemory()).toEqual({ used: 3 * GB, total: 8 * GB, source: 'containers' });
});

test('reports low memory usage from bytes through the system-load interface', async () => {
  const { service } = setup({
    '/host/proc/meminfo': 'MemTotal: 8388608 kB\nMemAvailable: 8126464 kB\n',
  });
  const system = new SystemService(mock<ConfigurationService>(), mock<FilesystemService>(), service);

  expect(await system.getSystemLoad()).toMatchObject({
    memoryTotal: 8,
    percentUsedMemory: 3.1,
    memorySource: 'host',
  });
});

test('labels the portable fallback as runtime memory when host accounting is absent', async () => {
  const { service } = setup({});
  vi.spyOn(os, 'totalmem').mockReturnValue(8 * GB);
  vi.spyOn(os, 'freemem').mockReturnValue(6 * GB);
  expect(await service.getMemory()).toEqual({ total: 8 * GB, used: 2 * GB, source: 'runtime' });
});

test('does not combine an LXC usage estimate with an unrelated runtime total', async () => {
  const { service, docker } = setup({ '/proc/self/mountinfo': LXCFS_MOUNTINFO });
  vi.spyOn(os, 'totalmem').mockReturnValue(8 * GB);
  await expect(service.getMemory()).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(docker.listContainers).not.toHaveBeenCalled();
});

test('does not present a zero cgroup limit as a valid memory percentage', async () => {
  const { service } = setup({
    '/proc/self/mountinfo': LXCFS_MOUNTINFO,
    '/host/proc/meminfo': 'MemTotal: 8388608 kB\n',
    '/host/sys/fs/cgroup/memory.current': '100',
    '/host/sys/fs/cgroup/memory.stat': 'inactive_file 0',
    '/host/sys/fs/cgroup/memory.max': '0',
  });
  await expect(service.getMemory()).rejects.toBeInstanceOf(ServiceUnavailableException);
});
