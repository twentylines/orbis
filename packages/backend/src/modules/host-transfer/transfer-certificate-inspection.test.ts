import { createHash, X509Certificate } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication, NestMiddleware } from '@nestjs/common';
import request from 'supertest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import { HostTransferController } from './host-transfer.controller';
import { HostTransferService } from './host-transfer.service';
import { TransferIngress } from './transfer-ingress';
import { assertPrivateCertificateInspection, inspectPublicCertificate } from './transfer-certificate-inspection';
import { assertPrivateTransferPeer } from './transfer-peer';
import { transferTlsFixture } from './transfer-tls.fixture';
vi.unmock('node:fs');
let fixture: ReturnType<typeof transferTlsFixture>;
beforeAll(() => {
  fixture = transferTlsFixture();
});
afterAll(() => fixture?.remove());
const hash = (pem: string) => createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
const proxy = '172.20.0.2';
function peer(overrides: Record<string, unknown> = {}): Request {
  return {
    socket: { remoteAddress: proxy },
    ip: '192.168.10.30',
    protocol: 'http',
    secure: false,
    headers: { host: '192.168.10.20:8080', 'x-forwarded-for': '192.168.10.30', 'x-forwarded-proto': 'http' },
    rawHeaders: ['Host', '192.168.10.20:8080', 'X-Forwarded-For', '192.168.10.30', 'X-Forwarded-Proto', 'http'],
    ...overrides,
  } as unknown as Request;
}
it('returns only a native DER fingerprint for one current public self-signed root or stock leaf, without creating trust', () => {
  for (const certificatePem of [fixture.root, fixture.self]) {
    expect(inspectPublicCertificate({ certificatePem })).toEqual({ sha256: hash(certificatePem) });
    expect(inspectPublicCertificate({ certificatePem: `\n${certificatePem.replaceAll('\n', '\r\n')}\n` })).toEqual({ sha256: hash(certificatePem) });
  }
});
it('rejects secret keys, bundles, invalid/trailing DER, unknown fields, unsigned leaves and expired anchors', () => {
  const trailing = Buffer.concat([new X509Certificate(fixture.root).raw, Buffer.from('extra')]);
  for (const certificatePem of [
    fixture.key,
    fixture.root + fixture.key,
    fixture.root + fixture.root,
    fixture.leaf,
    'x'.repeat(65537),
    `${fixture.root}extra`,
    `-----BEGIN CERTIFICATE-----\n${trailing.toString('base64')}\n-----END CERTIFICATE-----\n`,
    '-----BEGIN CERTIFICATE-----\ninvalid!\n-----END CERTIFICATE-----\n',
  ])
    expect(() => inspectPublicCertificate({ certificatePem })).toThrow('Private keys and bundles');
  for (const body of [null, [], {}, { certificatePem: fixture.root, confirmSourceCertificate: true }, { certificatePem: 42 }])
    expect(() => inspectPublicCertificate(body)).toThrow('Private keys and bundles');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(new X509Certificate(fixture.root).validTo));
  try {
    expect(() => inspectPublicCertificate({ certificatePem: fixture.root })).toThrow('current');
  } finally {
    clock.mockRestore();
  }
});
it('allows ordinary private HTTP inspection without weakening the strict transfer HTTPS peer gate', () => {
  expect(() => assertPrivateCertificateInspection(peer(), [proxy])).not.toThrow();
  expect(() => assertPrivateTransferPeer(peer(), [proxy])).toThrow('HTTPS');
  expect(() =>
    assertPrivateCertificateInspection(peer({ socket: { remoteAddress: '192.168.10.30' }, ip: '192.168.10.30', headers: {}, rawHeaders: [] }), []),
  ).not.toThrow();
});
it('requires exact verified proxy identity and a private nonambiguous client chain for forwarded inspection', () => {
  for (const chain of [
    '192.168.10.30, 203.0.113.8',
    '192.168.10.30,,172.20.0.2',
    '192.168.10.30, 192.168.99.9',
    '203.0.113.8',
    '192.168.10.30, unknown',
  ])
    expect(() => assertPrivateCertificateInspection(peer({ headers: { 'x-forwarded-for': chain, 'x-forwarded-proto': 'http' } }), [proxy])).toThrow(
      'private direct connection',
    );
  expect(() => assertPrivateCertificateInspection(peer(), [])).toThrow();
  expect(() => assertPrivateCertificateInspection(peer(), ['172.20.0.0/16'])).toThrow();
  expect(() => assertPrivateCertificateInspection(peer({ socket: { remoteAddress: '203.0.113.1' } }), [proxy])).toThrow();
  expect(() => assertPrivateCertificateInspection(peer({ rawHeaders: [...peer().rawHeaders, 'X-Forwarded-Proto', 'https'] }), [proxy])).toThrow();
  expect(() => assertPrivateCertificateInspection(peer({ headers: { ...peer().headers, 'x-forwarded-host': 'other.test' } }), [proxy])).toThrow();
  expect(() =>
    assertPrivateCertificateInspection(peer({ headers: { 'x-real-ip': '192.168.10.30' }, rawHeaders: ['X-Real-IP', '192.168.10.30'] }), [proxy]),
  ).toThrow();
});
async function application(throttle = false) {
  const ingress = mock<TransferIngress>();
  ingress.addresses.mockImplementation(async (address) => (address === proxy ? [proxy] : []));
  const module = await Test.createTestingModule({
    imports: throttle ? [ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])] : [],
    controllers: [HostTransferController],
    providers: [
      AuthGuard,
      ...(throttle ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }] : []),
      { provide: LoggerService, useValue: mock<LoggerService>() },
      { provide: HostTransferService, useValue: mock<HostTransferService>() },
      { provide: TransferIngress, useValue: ingress },
    ],
  }).compile();
  const app = module.createNestApplication();
  app.getHttpAdapter().getInstance().set('trust proxy', true);
  app.use(((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: proxy });
    const identity = req.headers.authorization?.replace('Bearer ', '');
    if (identity) {
      req.user = { id: 7, operator: identity !== 'member' };
      req.authMethod = identity === 'cli' ? 'cli' : 'session';
    }
    next();
  }) as NestMiddleware['use']);
  await app.init();
  return app;
}
function inspect(app: INestApplication, identity?: string, origin = 'http://192.168.10.20:8080', chain = '192.168.10.30') {
  const action = request(app.getHttpServer())
    .post('/system-backups/transfers/certificates/fingerprint')
    .set('Host', '192.168.10.20:8080')
    .set('Origin', origin)
    .set('X-Forwarded-For', chain)
    .set('X-Forwarded-Proto', 'http');
  if (identity) action.set('Authorization', `Bearer ${identity}`);
  return action.send({ certificatePem: fixture.root });
}
it('actual HTTP route enforces session/operator/origin/private chain and returns no-store fingerprint only', async () => {
  const app = await application();
  try {
    expect((await inspect(app)).status).toBe(401);
    expect((await inspect(app, 'member')).status).toBe(403);
    expect((await inspect(app, 'cli')).status).toBe(403);
    expect((await inspect(app, 'operator', 'http://other.test')).status).toBe(403);
    expect((await inspect(app, 'operator', undefined, '192.168.10.30, 203.0.113.8')).status).toBe(403);
    const result = await inspect(app, 'operator');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ sha256: hash(fixture.root) });
    expect(result.headers['cache-control']).toBe('no-store');
  } finally {
    await app.close();
  }
});
it('actual route throttles inspection after four requests without introducing a transfer or trust action', async () => {
  const app = await application(true);
  try {
    for (let attempt = 0; attempt < 4; attempt++) expect((await inspect(app, 'operator')).status).toBe(200);
    expect((await inspect(app, 'operator')).status).toBe(429);
  } finally {
    await app.close();
  }
});
