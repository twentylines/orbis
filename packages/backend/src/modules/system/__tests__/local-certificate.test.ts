import { describe, expect, it, vi } from 'vitest';
import { rootCertificates } from 'node:tls';
import { HostMemoryService } from '../host-memory.service';
import { SystemService } from '../system.service';

describe('public local certificate download', () => {
  const config = { get: () => ({ dataDir: '/data' }) };
  it('returns valid public certificate blocks without unrelated trailing data', async () => {
    const certificate = rootCertificates[0];
    expect(certificate).toBeTruthy();
    const files = { isFile: vi.fn().mockResolvedValue(true), readTextFile: vi.fn().mockResolvedValue(`${certificate}\nprivate-test-marker`) };
    const result = await systemService({} as never, config as never, files as never).getLocalCertificate();
    expect(result).toContain('BEGIN CERTIFICATE');
    expect(result).not.toContain('private-test-marker');
    expect(files.readTextFile).toHaveBeenCalledWith('/data/traefik/tls/ca.pem');
  });
  it('preserves public download of a legacy trusted root before CA migration', async () => {
    const certificate = rootCertificates[0];
    const files = { isFile: vi.fn(async (file: string) => file.endsWith('/cert.pem')), readTextFile: vi.fn().mockResolvedValue(certificate) };
    expect(await systemService({} as never, config as never, files as never).getLocalCertificate()).toContain('BEGIN CERTIFICATE');
    expect(files.readTextFile).toHaveBeenCalledWith('/data/traefik/tls/cert.pem');
  });
  it('does not fall back from an invalid current CA or expose a bundle as a single trust root', async () => {
    for (const content of ['not a root', `${rootCertificates[0]}\n${rootCertificates[0]}`]) {
      const files = { isFile: vi.fn().mockResolvedValue(true), readTextFile: vi.fn().mockResolvedValue(content) };
      await expect(systemService({} as never, config as never, files as never).getLocalCertificate()).rejects.toMatchObject({ status: 404 });
      expect(files.readTextFile).toHaveBeenCalledTimes(1);
      expect(files.readTextFile).toHaveBeenCalledWith('/data/traefik/tls/ca.pem');
    }
  });
  it.each([null, '', 'not a certificate', 'x'.repeat(65537)])('rejects absent, empty, invalid and oversized data', async (value) => {
    const files = { isFile: vi.fn().mockResolvedValue(value !== null), readTextFile: vi.fn().mockResolvedValue(value) };
    await expect(systemService({} as never, config as never, files as never).getLocalCertificate()).rejects.toMatchObject({ status: 404 });
  });
  it('does not expose a read failure', async () => {
    const files = { isFile: vi.fn().mockResolvedValue(true), readTextFile: vi.fn().mockRejectedValue(new Error('private-path-and-data')) };
    await expect(systemService({} as never, config as never, files as never).getLocalCertificate()).rejects.toThrow(
      'local HTTPS certificate is not available',
    );
  });
});

const systemService = (_logger: never, config: never, filesystem: never) =>
  new SystemService(config, filesystem, new HostMemoryService({ error: vi.fn() } as never, { get: () => 0 } as never, filesystem, {} as never));
