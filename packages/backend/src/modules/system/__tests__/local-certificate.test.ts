import { describe, expect, it, vi } from 'vitest';
import { rootCertificates } from 'node:tls';
import { SystemService } from '../system.service';

describe('public local certificate download', () => {
  const config = { get: () => ({ dataDir: '/data' }) };
  it('returns valid public certificate blocks without unrelated trailing data', async () => {
    const certificate = rootCertificates[0];
    expect(certificate).toBeTruthy();
    const files = { isFile: vi.fn().mockResolvedValue(true), readTextFile: vi.fn().mockResolvedValue(`${certificate}\nprivate-test-marker`) };
    const result = await new SystemService({} as never, config as never, files as never).getLocalCertificate();
    expect(result).toContain('BEGIN CERTIFICATE');
    expect(result).not.toContain('private-test-marker');
    expect(files.readTextFile).toHaveBeenCalledWith('/data/traefik/tls/cert.pem');
  });
  it.each([null, '', 'not a certificate', 'x'.repeat(65537)])('rejects absent, empty, invalid and oversized data', async (value) => {
    const files = { isFile: vi.fn().mockResolvedValue(value !== null), readTextFile: vi.fn().mockResolvedValue(value) };
    await expect(new SystemService({} as never, config as never, files as never).getLocalCertificate()).rejects.toMatchObject({ status: 404 });
  });
  it('does not expose a read failure', async () => {
    const files = { isFile: vi.fn().mockResolvedValue(true), readTextFile: vi.fn().mockRejectedValue(new Error('private-path-and-data')) };
    await expect(new SystemService({} as never, config as never, files as never).getLocalCertificate()).rejects.toThrow(
      'local HTTPS certificate is not available',
    );
  });
});
