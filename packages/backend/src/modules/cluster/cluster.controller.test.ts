import { type INestApplication, type NestMiddleware } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { ClusterController } from './cluster.controller';
import { ClusterService } from './cluster.service';
import { ClusterStateService } from './cluster-state.service';

describe('cluster installation authorization', () => {
  let app: INestApplication;
  const cluster = mock<ClusterService>();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ClusterController],
      providers: [
        AuthGuard,
        HostUpdatesGuard,
        { provide: ClusterService, useValue: cluster },
        { provide: ClusterStateService, useValue: mock<ClusterStateService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      const credential = req.headers.authorization;
      if (credential === 'Bearer operator' || credential === 'Bearer guest' || credential === 'Bearer cli') {
        req.user = { id: 1, operator: credential !== 'Bearer guest' };
        req.authMethod = credential === 'Bearer cli' ? 'cli' : 'session';
      }
      next();
    }) as NestMiddleware['use']);
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    cluster.command.mockReset();
    cluster.invite.mockReset();
    cluster.pair.mockReset();
  });
  const payload = { action: 'install-app', payload: { urn: 'tools:target', form: { port: 18765 } } };

  it.each(['invite', 'pair'])('protects new %s trust with operator session, same origin and exact actor forwarding', async (action) => {
    const body = {
      password: 'disposable-pairing-password',
      totpCode: '123456',
      ...(action === 'pair' ? { url: 'https://peer.example.test', code: 'A'.repeat(24) } : {}),
    };
    const endpoint = `/cluster/${action}`;
    const base = request(app.getHttpServer());
    expect((await base.post(endpoint).send(body)).status).toBe(401);
    for (const role of ['guest', 'cli'])
      expect(
        (
          await base
            .post(endpoint)
            .set('Authorization', `Bearer ${role}`)
            .set('Host', 'orbis.example')
            .set('Origin', 'http://orbis.example')
            .send(body)
        ).status,
      ).toBe(403);
    expect(
      (
        await base
          .post(endpoint)
          .set('Authorization', 'Bearer operator')
          .set('Host', 'orbis.example')
          .set('Origin', 'https://other.example')
          .send(body)
      ).status,
    ).toBe(403);
    expect(cluster.invite).not.toHaveBeenCalled();
    expect(cluster.pair).not.toHaveBeenCalled();
    const response = await base
      .post(endpoint)
      .set('Authorization', 'Bearer operator')
      .set('Host', 'orbis.example')
      .set('Origin', 'http://orbis.example')
      .send(body);
    expect(response.status).toBe(201);
    expect(action === 'invite' ? cluster.invite : cluster.pair).toHaveBeenCalledWith(body, 1);
  });

  it('requires an operator browser session and matching origin before dispatching an install', async () => {
    const base = request(app.getHttpServer());
    expect((await base.post('/cluster/servers/target/command').send(payload)).status).toBe(401);
    for (const credential of ['guest', 'cli']) {
      expect(
        (
          await base
            .post('/cluster/servers/target/command')
            .set('Authorization', `Bearer ${credential}`)
            .set('Host', 'orbis.example')
            .set('Origin', 'http://orbis.example')
            .send(payload)
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await base
          .post('/cluster/servers/target/command')
          .set('Authorization', 'Bearer operator')
          .set('Host', 'orbis.example')
          .set('Origin', 'https://another.example')
          .send(payload)
      ).status,
    ).toBe(403);
    expect(cluster.command).not.toHaveBeenCalled();
  });

  it('dispatches one host-scoped command for an authorized operator', async () => {
    cluster.command.mockResolvedValue({ accepted: true, urn: 'tools:target', requestId: 'request' });
    const response = await request(app.getHttpServer())
      .post('/cluster/servers/target/command')
      .set('Authorization', 'Bearer operator')
      .set('Host', 'orbis.example')
      .set('Origin', 'http://orbis.example')
      .send(payload);
    expect(response.status).toBe(201);
    expect(response.body.accepted).toBe(true);
    expect(cluster.command).toHaveBeenCalledExactlyOnceWith('target', 'install-app', payload.payload);
  });

  it('rejects a malformed command without touching the lifecycle', async () => {
    const response = await request(app.getHttpServer())
      .post('/cluster/servers/target/command')
      .set('Authorization', 'Bearer operator')
      .set('Host', 'orbis.example')
      .set('Origin', 'http://orbis.example')
      .send({ action: 'install-app', payload: [] });
    expect(response.status).toBe(400);
    expect(cluster.command).not.toHaveBeenCalled();
  });

  it('requires an operator browser session and matching origin for a drive self-test', async () => {
    const command = { action: 'drive-self-test', payload: { id: `drive:${'a'.repeat(24)}`, kind: 'short' } };
    const base = request(app.getHttpServer());
    expect((await base.post('/cluster/servers/target/command').send(command)).status).toBe(401);
    for (const credential of ['guest', 'cli']) {
      const response = await base
        .post('/cluster/servers/target/command')
        .set('Authorization', `Bearer ${credential}`)
        .set('Host', 'orbis.example')
        .set('Origin', 'http://orbis.example')
        .send(command);
      expect(response.status).toBe(403);
    }
    const crossOrigin = await base
      .post('/cluster/servers/target/command')
      .set('Authorization', 'Bearer operator')
      .set('Host', 'orbis.example')
      .set('Origin', 'https://another.example')
      .send(command);
    expect(crossOrigin.status).toBe(403);
    expect(cluster.command).not.toHaveBeenCalled();
    cluster.command.mockResolvedValue({ accepted: true, message: 'Test requested.' });
    const accepted = await base
      .post('/cluster/servers/target/command')
      .set('Authorization', 'Bearer operator')
      .set('Host', 'orbis.example')
      .set('Origin', 'http://orbis.example')
      .send(command);
    expect(accepted.status).toBe(201);
    expect(accepted.body.accepted).toBe(true);
    expect(cluster.command).toHaveBeenCalledExactlyOnceWith('target', 'drive-self-test', command.payload);
  });
});
