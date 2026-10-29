import { createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sourceCertificate } from './transfer-certificates';
import { TransferTransport, type TransferTarget } from './transfer-transport';
import { transferTlsFixture } from './transfer-tls.fixture';

vi.unmock('node:fs');

let fixture: ReturnType<typeof transferTlsFixture>;
beforeAll(() => {
  fixture = transferTlsFixture();
});
afterAll(() => fixture?.remove());
const trust = (pem: string) =>
  sourceCertificate({
    sourceCertificatePem: pem,
    sourceCertificateSha256: createHash('sha256').update(new X509Certificate(pem).raw).digest('hex'),
    confirmSourceCertificate: true,
  });

async function serverTest(certificate: string, action: (port: string, requests: () => number) => Promise<void>) {
  let requests = 0;
  const server = https.createServer({ key: fixture.key, cert: certificate }, (_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"status":"approved"}');
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await action(String((server.address() as AddressInfo).port), () => requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const target = (port: string, hostname = 'source.example.test', pem?: string): TransferTarget =>
  Object.freeze({
    origin: `https://${hostname}:${port}`,
    hostname,
    port,
    address: '127.0.0.1',
    family: 4,
    ...(pem ? { certificate: trust(pem) } : {}),
  });
const request = (value: TransferTarget) =>
  new TransferTransport().json(value, 'claim', { code: 'disposable-code-not-sent-before-TLS' }, AbortSignal.timeout(5000));

it('performs a real verified TLS handshake with uploaded private root and hostname or IP SAN, then sends the claim', async () => {
  await serverTest(fixture.leaf, async (port, requests) => {
    await expect(request(target(port, 'source.example.test', fixture.root))).resolves.toEqual({ status: 'approved' });
    await expect(request(target(port, '127.0.0.1', fixture.root))).resolves.toEqual({ status: 'approved' });
    expect(requests()).toBe(2);
  });
});

it('supports stock self-signed TLS while keeping hostname verification and trust local to that job', async () => {
  await serverTest(fixture.self, async (port, requests) => {
    await expect(request(target(port, 'source.example.test', fixture.self))).resolves.toEqual({ status: 'approved' });
    await expect(request(target(port))).rejects.toThrow('hostname matching its HTTPS certificate');
    await expect(request(target(port, 'wrong.example.test', fixture.self))).rejects.toThrow('hostname matching its HTTPS certificate');
    await expect(request(target(port, '127.0.0.1', fixture.self))).rejects.toThrow('hostname matching its HTTPS certificate');
    expect(requests()).toBe(1);
  });
});

it('sends no claim over TLS with wrong root, wrong name or untrusted issuer', async () => {
  await serverTest(fixture.leaf, async (port, requests) => {
    await expect(request(target(port, 'source.example.test', fixture.self))).rejects.toThrow('certificate trust');
    await expect(request(target(port, 'wrong.example.test', fixture.root))).rejects.toThrow('certificate trust');
    await expect(request(target(port))).rejects.toThrow('certificate trust');
    expect(requests()).toBe(0);
  });
});

it('rejects an expired leaf even with the right uploaded root and hostname', async () => {
  await serverTest(fixture.expired, async (port, requests) => {
    await expect(request(target(port, 'source.example.test', fixture.root))).rejects.toThrow('certificate trust');
    expect(requests()).toBe(0);
  });
});
