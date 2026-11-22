import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Dockerode from 'dockerode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstalledSoftwareService } from '../installed-software.service';

const absent = { osName: null, osVersion: null, dockerVersion: null };

function engine() {
  const info = vi.fn<(options: { abortSignal: AbortSignal }) => Promise<unknown>>();
  return { info, service: new InstalledSoftwareService({ info } as unknown as Dockerode) };
}

describe('installed host software readings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('projects the configured Docker daemon host and server version without passing through unrelated metadata', async () => {
    const { info, service } = engine();
    info.mockResolvedValue({
      OperatingSystem: ' Ubuntu 24.04.4 LTS ',
      OSVersion: '24.04',
      ServerVersion: '29.0.0-rc.2',
      Driver: 'overlayfs',
      Name: 'internal-host',
    });
    expect(await service.read()).toEqual({ osName: 'Ubuntu 24.04.4 LTS', osVersion: '24.04', dockerVersion: '29.0.0-rc.2' });
    expect(info.mock.calls).toHaveLength(1);
    expect(info.mock.calls[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('returns available facts independently and ignores absent or malformed values', async () => {
    const { info, service } = engine();
    info.mockResolvedValue({ OperatingSystem: 'X'.repeat(161), OSVersion: 12, ServerVersion: '27.5.0' });
    expect(await service.read()).toEqual({ ...absent, dockerVersion: '27.5.0' });
    const malformed = engine();
    malformed.info.mockResolvedValue({ OperatingSystem: 'Linux\nTest', OSVersion: '', ServerVersion: '   ' });
    expect(await malformed.service.read()).toEqual(absent);
  });

  it('coalesces concurrent readers, caches briefly, and rereads a changed daemon after expiration', async () => {
    vi.useFakeTimers();
    const { info, service } = engine();
    info.mockResolvedValueOnce({ ServerVersion: '27.5.0' }).mockResolvedValueOnce({ ServerVersion: '29.2.1' });
    const first = await Promise.all([service.read(), service.read(), service.read()]);
    expect(first.map((value) => value.dockerVersion)).toEqual(['27.5.0', '27.5.0', '27.5.0']);
    vi.advanceTimersByTime(29_999);
    expect((await service.read()).dockerVersion).toBe('27.5.0');
    expect(info).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect((await service.read()).dockerVersion).toBe('29.2.1');
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable rather than client metadata on engine failure and recovers on the next eligible read', async () => {
    vi.useFakeTimers();
    const { info, service } = engine();
    info.mockRejectedValueOnce(new Error('Private socket diagnostic')).mockResolvedValueOnce({ ServerVersion: '29.2.1' });
    expect(await service.read()).toEqual(absent);
    expect(await service.read()).toEqual(absent);
    expect(info).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect((await service.read()).dockerVersion).toBe('29.2.1');
  });

  it('aborts the real Dockerode transport when the fixed info request stalls', async () => {
    const requests: string[] = [];
    const server = createServer((request) => {
      requests.push(`${request.method} ${request.url}`);
      // Accept the request without sending response headers.
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const fallback = setTimeout(() => server.closeAllConnections(), 4600);
    try {
      const docker = new Dockerode({ host: 'http://127.0.0.1', port: (server.address() as AddressInfo).port });
      const started = performance.now();
      expect(await new InstalledSoftwareService(docker).read()).toEqual(absent);
      expect(requests).toEqual(['GET /info']);
      expect(performance.now() - started).toBeLessThan(4500);
    } finally {
      clearTimeout(fallback);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 6000);
});
