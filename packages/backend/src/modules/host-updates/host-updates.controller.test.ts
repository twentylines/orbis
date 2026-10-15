import { LoggerService } from '@/core/logger/logger.service';
import { type INestApplication, type NestMiddleware } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AuthGuard } from '../auth/auth.guard';
import { HostUpdatesController } from './host-updates.controller';
import { HostUpdatesService } from './host-updates.service';
import { HostUpdatesGuard } from './host-updates.guard';

describe('host update authorization', () => {
  let app: INestApplication;
  const hostUpdates = mock<HostUpdatesService>();
  const logger = mock<LoggerService>();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HostUpdatesController],
      providers: [AuthGuard, HostUpdatesGuard, { provide: HostUpdatesService, useValue: hostUpdates }, { provide: LoggerService, useValue: logger }],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'Bearer fixture-session') {
        req.user = { id: 1, operator: true };
        req.authMethod = 'session';
      }
      if (req.headers.authorization === 'Bearer guest-session') {
        req.user = { id: 2, operator: false };
        req.authMethod = 'session';
      }
      if (req.headers.authorization === 'Bearer fixture-cli') {
        req.user = { id: 1, operator: true };
        req.authMethod = 'cli';
      }
      next();
    }) as NestMiddleware['use']);
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    hostUpdates.status.mockReset();
    hostUpdates.packages.mockReset();
    hostUpdates.packageChangelog.mockReset();
    hostUpdates.packageJob.mockReset();
    hostUpdates.packagePlan.mockReset();
    hostUpdates.packageApply.mockReset();
    hostUpdates.plan.mockReset();
    hostUpdates.apply.mockReset();
    hostUpdates.recover.mockReset();
  });

  it('requires a session for status and rejects a cross-origin update request', async () => {
    expect((await request(app.getHttpServer()).get('/host-updates/status')).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/host-updates/packages')).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/host-updates/packages/apply').send({ planId: 'fixture' })).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/host-updates/apply').send({ planId: 'fixture' })).status).toBe(401);
    const crossOrigin = await request(app.getHttpServer())
      .post('/host-updates/apply')
      .set('Authorization', 'Bearer fixture-session')
      .set('Host', 'orbis.example')
      .set('Origin', 'https://unrelated.example')
      .send({ planId: 'fixture' });
    expect(crossOrigin.status).toBe(403);
    expect(hostUpdates.apply).not.toHaveBeenCalled();
    expect((await request(app.getHttpServer()).get('/host-updates/status').set('Authorization', 'Bearer guest-session')).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/host-updates/packages').set('Authorization', 'Bearer guest-session')).status).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post('/host-updates/packages/plan')
          .set('Authorization', 'Bearer guest-session')
          .send({ names: ['base-files:arm64'] })
      ).status,
    ).toBe(403);
    expect((await request(app.getHttpServer()).get('/host-updates/status').set('Authorization', 'Bearer fixture-cli')).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/host-updates/packages').set('Authorization', 'Bearer fixture-cli')).status).toBe(403);
    expect(
      (await request(app.getHttpServer()).post('/host-updates/packages/apply').set('Authorization', 'Bearer fixture-cli').send({ planId: 'fixture' }))
        .status,
    ).toBe(403);
  });

  it('lets an operator read host packages and their changelog', async () => {
    hostUpdates.packages.mockResolvedValue({ available: true, packageCount: 1, packages: [] });
    hostUpdates.packageChangelog.mockResolvedValue({
      name: 'base-files:arm64',
      candidateVersion: '13ubuntu10.5',
      available: true,
      source: 'APT distribution changelog',
      body: 'Ubuntu changelog',
    });
    const base = request(app.getHttpServer());
    const headers = { Authorization: 'Bearer fixture-session' };
    expect((await base.get('/host-updates/packages').set(headers)).body.packageCount).toBe(1);
    expect((await base.get('/host-updates/packages/changelog?name=base-files%3Aarm64').set(headers)).body.available).toBe(true);
    expect(hostUpdates.packageChangelog).toHaveBeenCalledWith('base-files:arm64');
  });

  it('requires a same-origin operator request for a reviewed package apply', async () => {
    hostUpdates.packagePlan.mockResolvedValue({
      planId: '00000000-0000-4000-8000-000000000000',
      createdAt: 1,
      selected: [],
      operations: [],
    });
    hostUpdates.packageApply.mockResolvedValue({ jobId: '00000000-0000-4000-8000-000000000000', state: 'queued' });
    const base = request(app.getHttpServer());
    const headers = { Authorization: 'Bearer fixture-session', Host: 'orbis.example', Origin: 'http://orbis.example' };
    const rejected = await base
      .post('/host-updates/packages/apply')
      .set({ ...headers, Origin: 'https://other.example' })
      .send({ planId: 'fixture' });
    expect(rejected.status).toBe(403);
    expect(hostUpdates.packageApply).not.toHaveBeenCalled();
    expect(
      (
        await base
          .post('/host-updates/packages/plan')
          .set(headers)
          .send({ names: ['base-files:arm64'], command: 'shell' })
      ).status,
    ).toBe(400);
    expect(
      (
        await base
          .post('/host-updates/packages/plan')
          .set(headers)
          .send({ names: ['base-files:arm64'] })
      ).status,
    ).toBe(200);
    expect((await base.post('/host-updates/packages/apply').set(headers).send({ planId: '00000000-0000-4000-8000-000000000000' })).status).toBe(202);
    expect(hostUpdates.packageApply).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000000');
  });

  it('accepts a same-origin plan and apply request with exact fields', async () => {
    hostUpdates.plan.mockResolvedValue({
      planId: '00000000-0000-4000-8000-000000000000',
      currentTag: 'v0.1.0-beta.6',
      targetTag: 'v0.1.0-beta.7',
      targetDigest: `sha256:${'a'.repeat(64)}`,
      snapshotBytes: 123,
      appsMustBeStopped: true,
    });
    hostUpdates.apply.mockResolvedValue({ jobId: '00000000-0000-4000-8000-000000000000', state: 'running' });
    const base = request(app.getHttpServer());
    const headers = { Authorization: 'Bearer fixture-session', Host: 'orbis.example', Origin: 'http://orbis.example' };
    const plan = await base.post('/host-updates/plan').set(headers).send({ tag: 'v0.1.0-beta.7' });
    expect(plan.status).toBe(200);
    expect(hostUpdates.plan).toHaveBeenCalledWith('v0.1.0-beta.7');
    const extra = await base.post('/host-updates/apply').set(headers).send({ planId: 'fixture', command: 'shell' });
    expect(extra.status).toBe(400);
    const accepted = await base.post('/host-updates/apply').set(headers).send({ planId: '00000000-0000-4000-8000-000000000000' });
    expect(accepted.status).toBe(202);
    expect(hostUpdates.apply).toHaveBeenCalledTimes(1);
  });
});
