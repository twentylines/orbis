import { createHash, X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { clusterCertificate } from './cluster-certificate';
import { clusterRequest } from './cluster-transport';
import { clusterTlsFixture } from './cluster-tls.fixture';

vi.unmock('node:fs');
const state = vi.hoisted(() => ({ addresses: [{ address: '192.168.20.5', family: 4 }] }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => state.addresses) }));
let fixture: ReturnType<typeof clusterTlsFixture>;
beforeAll(() => {
  fixture = clusterTlsFixture();
});
afterAll(() => fixture?.remove());
beforeEach(() => {
  state.addresses = [{ address: '192.168.20.5', family: 4 }];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const certificate = (pem: string) =>
  clusterCertificate({
    peerCertificatePem: pem,
    peerCertificateSha256: createHash('sha256').update(new X509Certificate(pem).raw).digest('hex'),
    confirmPeerCertificate: true,
  });

async function tlsTest(
  cert: string,
  action: (port: string, received: () => number, requests: https.RequestOptions[]) => Promise<void>,
  status = 200,
) {
  let count = 0;
  const server = https.createServer({ cert, key: fixture.key }, (_request, response) => {
    count++;
    response.writeHead(status, { 'Content-Type': 'application/json', ...(status === 302 ? { Location: 'https://8.8.8.8/secret' } : {}) });
    response.end('{"accepted":true}');
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const original = https.request;
  const requests: https.RequestOptions[] = [];
  vi.spyOn(https, 'request').mockImplementation(((
    options: https.RequestOptions,
    callback: (response: import('node:http').IncomingMessage) => void,
  ) => {
    requests.push(options);
    const pinned = vi.fn();
    (options.lookup as (hostname: string, options: object, callback: (...args: unknown[]) => void) => void)('source.example.test', {}, pinned);
    expect(pinned).toHaveBeenCalledWith(null, '192.168.20.5', 4);
    // Only the fixture's physical connection is redirected to loopback; TLS name and verification options stay intact.
    return original({ ...options, lookup: (_hostname, _options, done) => done(null, '127.0.0.1', 4) }, callback);
  }) as typeof https.request);
  try {
    await action(String((server.address() as AddressInfo).port), () => count, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const send = (port: string, pem?: string, hostname = 'source.example.test') =>
  clusterRequest(
    `https://${hostname}:${port}`,
    '/api/cluster/accept',
    { code: 'disposable-pairing-code', secret: 'disposable-secret' },
    {},
    false,
    pem ? certificate(pem) : undefined,
  );

it('uses the explicitly approved private root for a real verified TLS handshake, preserving native hostname verification and DNS pin', async () => {
  await tlsTest(fixture.leaf, async (port, received, requests) => {
    await expect(send(port, fixture.root)).resolves.toEqual({ accepted: true });
    expect(received()).toBe(1);
    expect(requests[0]).toMatchObject({
      hostname: 'source.example.test',
      rejectUnauthorized: true,
      agent: false,
      ca: new X509Certificate(fixture.root).toString(),
      path: '/api/cluster/accept',
    });
    expect(requests[0]?.checkServerIdentity).toBeUndefined();
  });
});
it('supports stock self-signed certificates but never carries their trust to another request or wrong hostname', async () => {
  await tlsTest(fixture.self, async (port, received) => {
    await expect(send(port, fixture.self)).resolves.toEqual({ accepted: true });
    await expect(send(port)).rejects.toThrow('hostname matching its HTTPS certificate');
    await expect(send(port, fixture.self, 'wrong.example.test')).rejects.toThrow('hostname matching its HTTPS certificate');
    expect(received()).toBe(1);
  });
});
it('does not send pairing secrets with a wrong root, wrong hostname, rotated/untrusted root or expired leaf', async () => {
  await tlsTest(fixture.leaf, async (port, received) => {
    await expect(send(port, fixture.self)).rejects.toThrow('certificate trust');
    await expect(send(port, fixture.root, 'wrong.example.test')).rejects.toThrow('certificate trust');
    await expect(send(port)).rejects.toThrow('certificate trust');
    expect(received()).toBe(0);
  });
  vi.restoreAllMocks();
  await tlsTest(fixture.expired, async (port, received) => {
    await expect(send(port, fixture.root)).rejects.toThrow('certificate trust');
    expect(received()).toBe(0);
  });
});
it('never follows a redirect carrying pairing secrets', async () => {
  await tlsTest(
    fixture.leaf,
    async (port, received, requests) => {
      await expect(send(port, fixture.root)).rejects.toThrow('refused the request (302)');
      expect(received()).toBe(1);
      expect(requests).toHaveLength(1);
    },
    302,
  );
});
it('refuses mixed/private-public DNS or HTTP-with-certificate before opening any connection', async () => {
  const request = vi.spyOn(https, 'request');
  state.addresses = [
    { address: '192.168.20.5', family: 4 },
    { address: '8.8.8.8', family: 4 },
  ];
  await expect(send('8443', fixture.root)).rejects.toThrow('public targets are refused');
  await expect(clusterRequest('http://192.168.20.5', '/api/cluster/accept', {}, {}, true, certificate(fixture.root))).rejects.toThrow(
    'requires HTTPS',
  );
  expect(request).not.toHaveBeenCalled();
});
it('bounds an unresolved DNS request without opening a TLS connection', async () => {
  vi.useFakeTimers();
  vi.mocked(lookup).mockImplementationOnce(async () => new Promise(() => undefined));
  const pending = send('8443', fixture.root);
  const rejected = expect(pending).rejects.toThrow('resolved in time');
  await vi.advanceTimersByTimeAsync(6001);
  await rejected;
});
