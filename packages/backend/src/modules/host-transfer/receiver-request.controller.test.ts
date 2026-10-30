import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { ReceiverRequestController, ReceiverRequestPeerController } from './receiver-request.controller';
import { ReceiverRequestService } from './receiver-request.service';
import { TransferIngress } from './transfer-ingress';

let app: INestApplication;
const incoming = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const service = {
  list: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  cancelIncoming: vi.fn(),
  start: vi.fn(),
  cancelOutgoing: vi.fn(),
  peerRequest: vi.fn(),
  peerStatus: vi.fn(),
  peerCancel: vi.fn(),
  peerFile: vi.fn(),
};
const ingress = { addresses: vi.fn() };
beforeEach(async () => {
  vi.resetAllMocks();
  service.list.mockReturnValue({ version: 1, incoming: [], outgoing: [] });
  service.create.mockResolvedValue({ version: 1, status: 'awaiting-source-approval' });
  service.approve.mockResolvedValue({ version: 1, status: 'exporting' });
  ingress.addresses.mockResolvedValue(['172.20.0.2']);
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 1000 }])],
    controllers: [ReceiverRequestController, ReceiverRequestPeerController],
    providers: [
      { provide: ReceiverRequestService, useValue: service },
      { provide: TransferIngress, useValue: ingress },
      { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
  })
    .overrideGuard(AuthGuard)
    .useValue({ canActivate: () => true })
    .compile();
  app = module.createNestApplication({ logger: false });
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: 7, operator: req.headers['x-fixture-role'] !== 'viewer' } as Request['user'];
    req.authMethod = (req.headers['x-fixture-auth'] ?? 'session') as Request['authMethod'];
    next();
  });
  await app.init();
});
afterEach(async () => {
  await app.close();
});

it('uses only the local operator-session identity for request listing and approval, rejecting API keys, CLI and viewers', async () => {
  await request(app.getHttpServer()).get('/system-backups/transfers/requests').expect(200).expect('Cache-Control', 'no-store');
  expect(service.list).toHaveBeenCalledWith(7);
  for (const method of ['api-key', 'cli', 'none'])
    await request(app.getHttpServer()).get('/system-backups/transfers/requests').set('x-fixture-auth', method).expect(403);
  await request(app.getHttpServer()).get('/system-backups/transfers/requests').set('x-fixture-role', 'viewer').expect(403);
  await request(app.getHttpServer())
    .post(`/system-backups/transfers/requests/incoming/${incoming}/approve`)
    .send({ password: 'example account password', destinationFingerprint: 'a'.repeat(64), encryption: 'source-account-password' })
    .expect(202);
  expect(service.approve).toHaveBeenCalledWith(
    incoming,
    7,
    expect.objectContaining({ password: 'example account password' }),
    'a'.repeat(64),
    'source-account-password',
    undefined,
  );
});
it('rejects callback, owner, code, malformed MFA and extra selectors before invoking any new protocol action', async () => {
  for (const body of [
    { password: 'example account password', sourceOrigin: 'https://source.example.test', confirmRequest: true, ownerId: 1 },
    {
      password: 'example account password',
      sourceOrigin: 'https://source.example.test',
      confirmRequest: true,
      callbackUrl: 'https://other.example.test',
    },
    { password: 'example account password', sourceOrigin: 'https://source.example.test', confirmRequest: true, code: 'a'.repeat(64) },
    { password: 'example account password', sourceOrigin: 'https://source.example.test', confirmRequest: true, totpCode: 'wrong' },
  ])
    await request(app.getHttpServer()).post('/system-backups/transfers/requests').send(body).expect(400);
  expect(service.create).not.toHaveBeenCalled();
});
it('keeps unauthenticated peer routes behind the strict private HTTPS gate and rate-limits rejected requests', async () => {
  for (let count = 0; count < 5; count++)
    await request(app.getHttpServer()).post('/system-backups/transfers/peer/request').send({ version: 1 }).expect(403);
  await request(app.getHttpServer()).post('/system-backups/transfers/peer/request').send({ version: 1 }).expect(429);
  expect(service.peerRequest).not.toHaveBeenCalled();
  await request(app.getHttpServer()).post('/system-backups/transfers/peer/request-file').send({}).expect(403);
  expect(service.peerFile).not.toHaveBeenCalled();
});
it('passes the verified original client IP to capability binding and refuses spoofed/private-public chains', async () => {
  const controller = new ReceiverRequestPeerController(service as unknown as ReceiverRequestService, ingress as unknown as TransferIngress);
  const response = { setHeader: vi.fn() } as unknown as Response;
  const peer = {
    socket: { remoteAddress: '172.20.0.2' },
    secure: true,
    ip: '192.168.20.11',
    headers: { 'x-forwarded-for': '192.168.20.11', 'x-forwarded-proto': 'https' },
    rawHeaders: ['X-Forwarded-For', '192.168.20.11', 'X-Forwarded-Proto', 'https'],
  } as unknown as Request;
  await controller.create(peer, { version: 1 }, response);
  expect(service.peerRequest).toHaveBeenCalledWith({ version: 1 }, '192.168.20.11');
  service.peerRequest.mockClear();
  for (const forwarded of ['192.168.20.11, 203.0.113.10', '192.168.20.11, 192.168.20.99', 'malformed']) {
    const forged = {
      ...peer,
      headers: { ...peer.headers, 'x-forwarded-for': forwarded },
      rawHeaders: ['X-Forwarded-For', forwarded, 'X-Forwarded-Proto', 'https'],
    } as unknown as Request;
    await expect(controller.create(forged, { version: 1 }, response)).rejects.toThrow('private LAN HTTPS');
  }
  expect(service.peerRequest).not.toHaveBeenCalled();
});
