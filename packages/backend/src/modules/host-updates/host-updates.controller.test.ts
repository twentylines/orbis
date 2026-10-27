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
import { OrbisDowngradeService } from './orbis-downgrade.service';

describe('host update authorization', () => {
  let app: INestApplication;
  const hostUpdates = mock<HostUpdatesService>();
  const downgrades = mock<OrbisDowngradeService>();
  const logger = mock<LoggerService>();

  it('restricts physical drive tests to an operator session and exact action fields', async () => {
    const route = '/host-updates/drives/test';
    const body = { id: `drive:${'a'.repeat(24)}`, kind: 'short' };
    for (const authorization of ['Bearer guest-session', 'Bearer fixture-cli']) {
      expect(
        (
          await request(app.getHttpServer())
            .post(route)
            .set({ Authorization: authorization, Host: 'orbis.example', Origin: 'http://orbis.example' })
            .send(body)
        ).status,
      ).toBe(403);
    }
    const headers = { Authorization: 'Bearer fixture-session', Host: 'orbis.example', Origin: 'http://orbis.example' };
    expect(
      (
        await request(app.getHttpServer())
          .post(route)
          .set({ ...headers, Origin: 'https://other.example' })
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post(route)
          .set(headers)
          .send({ ...body, command: 'shell' })
      ).status,
    ).toBe(400);
    expect(hostUpdates.driveTest).not.toHaveBeenCalled();
    hostUpdates.driveTest.mockResolvedValue({ accepted: true, message: 'Self-test started.' });
    expect((await request(app.getHttpServer()).post(route).set(headers).send(body)).status).toBe(202);
    expect(hostUpdates.driveTest).toHaveBeenCalledExactlyOnceWith(body.id, 'short');
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HostUpdatesController],
      providers: [
        AuthGuard,
        HostUpdatesGuard,
        { provide: HostUpdatesService, useValue: hostUpdates },
        { provide: OrbisDowngradeService, useValue: downgrades },
        { provide: LoggerService, useValue: logger },
      ],
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
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    hostUpdates.status.mockReset();
    hostUpdates.packages.mockReset();
    hostUpdates.packageChangelog.mockReset();
    hostUpdates.packageJob.mockReset();
    hostUpdates.packageRefresh.mockReset();
    hostUpdates.packagePlan.mockReset();
    hostUpdates.packageApply.mockReset();
    hostUpdates.plan.mockReset();
    hostUpdates.apply.mockReset();
    hostUpdates.recover.mockReset();
    hostUpdates.restartStatus.mockReset();
    hostUpdates.restartPlan.mockReset();
    hostUpdates.restartApply.mockReset();
    downgrades.plan.mockReset();
    downgrades.apply.mockReset();
    downgrades.releaseCompatibility.mockReset();
  });

  it('accepts only strict boolean force flags and exact downgrade request shapes', async () => {
    const headers = { Authorization: 'Bearer fixture-session', Host: 'orbis.example', Origin: 'http://orbis.example' };
    for (const action of ['plan', 'apply']) {
      const required = action === 'plan' ? { tag: 'v0.1.0-beta.90' } : { planId: 'reviewed-plan' };
      const route = `/host-updates/downgrade/${action}`;
      for (const force of ['true', 'false', 1, 0, null, [], {}]) {
        expect(
          (
            await request(app.getHttpServer())
              .post(route)
              .set(headers)
              .send({ ...required, force })
          ).status,
        ).toBe(400);
      }
      for (const body of [
        {},
        [],
        { ...required, extra: true },
        { ...required, ...Object.fromEntries(Object.keys(required).map((key) => [key, 1])) },
      ]) {
        expect((await request(app.getHttpServer()).post(route).set(headers).send(body)).status).toBe(400);
      }
    }
    expect(downgrades.plan).not.toHaveBeenCalled();
    expect(downgrades.apply).not.toHaveBeenCalled();
    downgrades.plan.mockResolvedValue({ planId: 'reviewed-plan', forced: true, warnings: ['Data may be unreadable.'] } as never);
    const plan = await request(app.getHttpServer()).post('/host-updates/downgrade/plan').set(headers).send({ tag: 'v0.1.0-beta.90', force: true });
    expect(plan.status).toBe(200);
    expect(plan.body.forced).toBe(true);
    expect(plan.body.warnings).toEqual(['Data may be unreadable.']);
    expect(downgrades.plan).toHaveBeenCalledWith('v0.1.0-beta.90', true);
    downgrades.apply.mockResolvedValue({ jobId: 'reviewed-plan', state: 'running' });
    expect(
      (await request(app.getHttpServer()).post('/host-updates/downgrade/apply').set(headers).send({ planId: 'reviewed-plan', force: true })).status,
    ).toBe(202);
    expect(downgrades.apply).toHaveBeenCalledWith('reviewed-plan', true);
    expect(
      (await request(app.getHttpServer()).post('/host-updates/downgrade/plan').set(headers).send({ tag: 'v0.1.0-beta.90', force: false })).status,
    ).toBe(200);
    expect(downgrades.plan).toHaveBeenLastCalledWith('v0.1.0-beta.90', false);
  });

  it('restricts release compatibility metadata to an operator session and one exact tag query', async () => {
    const route = '/host-updates/release-compatibility';
    expect((await request(app.getHttpServer()).get(route).query({ tag: 'v0.1.0-beta.99' })).status).toBe(401);
    for (const authorization of ['guest-session', 'fixture-cli']) {
      expect(
        (await request(app.getHttpServer()).get(route).set('Authorization', `Bearer ${authorization}`).query({ tag: 'v0.1.0-beta.99' })).status,
      ).toBe(403);
    }
    for (const query of ['', '?extra=value', '?tag=a&tag=b', '?tag=a&force=true']) {
      expect(
        (
          await request(app.getHttpServer())
            .get(route + query)
            .set('Authorization', 'Bearer fixture-session')
        ).status,
      ).toBe(400);
    }
    expect(downgrades.releaseCompatibility).not.toHaveBeenCalled();
    downgrades.releaseCompatibility.mockResolvedValue({
      tag: 'v0.1.0-beta.99',
      currentRuntipiVersion: '4.10.1',
      targetRuntipiVersion: '4.11.0',
      crossesRuntipiBoundary: true,
      hostUpdateSupported: false,
      warning: 'This update cannot be applied by the current host updater.',
    });
    const response = await request(app.getHttpServer()).get(route).set('Authorization', 'Bearer fixture-session').query({ tag: 'v0.1.0-beta.99' });
    expect(response.status).toBe(200);
    expect(response.body.crossesRuntipiBoundary).toBe(true);
    expect(response.body.hostUpdateSupported).toBe(false);
    expect(downgrades.releaseCompatibility).toHaveBeenCalledWith('v0.1.0-beta.99');
    expect(hostUpdates.plan).not.toHaveBeenCalled();
    expect(hostUpdates.apply).not.toHaveBeenCalled();
  });

  it('requires an operator session and same origin for downgrade review and apply', async () => {
    for (const action of ['plan', 'apply']) {
      const route = `/host-updates/downgrade/${action}`;
      const body = action === 'plan' ? { tag: 'v0.1.0-beta.90' } : { planId: 'reviewed-plan' };
      expect((await request(app.getHttpServer()).post(route).send(body)).status).toBe(401);
      for (const authorization of ['guest-session', 'fixture-cli']) {
        expect((await request(app.getHttpServer()).post(route).set('Authorization', `Bearer ${authorization}`).send(body)).status).toBe(403);
      }
      expect(
        (
          await request(app.getHttpServer())
            .post(route)
            .set('Authorization', 'Bearer fixture-session')
            .set('Host', 'orbis.example')
            .set('Origin', 'https://other.example')
            .send(body)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app.getHttpServer())
            .post(route)
            .set('Authorization', 'Bearer fixture-session')
            .set('Host', 'orbis.example')
            .set('Origin', 'http://orbis.example')
            .send({ ...body, command: 'unsafe' })
        ).status,
      ).toBe(400);
    }
    expect(downgrades.plan).not.toHaveBeenCalled();
    expect(downgrades.apply).not.toHaveBeenCalled();
    downgrades.plan.mockResolvedValue({ planId: 'reviewed-plan' } as never);
    expect(
      (
        await request(app.getHttpServer())
          .post('/host-updates/downgrade/plan')
          .set('Authorization', 'Bearer fixture-session')
          .set('Host', 'orbis.example')
          .set('Origin', 'http://orbis.example')
          .send({ tag: 'v0.1.0-beta.90' })
      ).status,
    ).toBe(200);
    downgrades.apply.mockResolvedValue({ jobId: 'reviewed-plan', state: 'running' });
    expect(
      (
        await request(app.getHttpServer())
          .post('/host-updates/downgrade/apply')
          .set('Authorization', 'Bearer fixture-session')
          .set('Host', 'orbis.example')
          .set('Origin', 'http://orbis.example')
          .send({ planId: 'reviewed-plan' })
      ).status,
    ).toBe(202);
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

  it('limits restart review and apply to exact same-origin operator session requests', async () => {
    const base = request(app.getHttpServer());
    const planId = '00000000-0000-4000-8000-000000000000';
    hostUpdates.restartStatus.mockResolvedValue({ available: true, job: null });
    hostUpdates.restartPlan.mockResolvedValue({ planId, expiresAt: 123, rebootRequired: true });
    hostUpdates.restartApply.mockResolvedValue({ jobId: planId, state: 'restarting' });
    for (const authorization of [undefined, 'Bearer guest-session', 'Bearer fixture-cli']) {
      const headers = authorization ? { Authorization: authorization } : {};
      const denied = authorization ? 403 : 401;
      expect((await base.get('/host-updates/restart').set(headers)).status).toBe(denied);
      expect((await base.post('/host-updates/restart/plan').set(headers).send({})).status).toBe(denied);
      expect((await base.post('/host-updates/restart/apply').set(headers).send({ planId })).status).toBe(denied);
    }
    const headers = { Authorization: 'Bearer fixture-session', Host: 'orbis.example', Origin: 'http://orbis.example' };
    expect(
      (
        await base
          .post('/host-updates/restart/plan')
          .set({ ...headers, Origin: 'https://other.example' })
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await base
          .post('/host-updates/restart/apply')
          .set({ ...headers, Origin: 'https://other.example' })
          .send({ planId })
      ).status,
    ).toBe(403);
    expect((await base.post('/host-updates/restart/plan').set(headers).send({ command: 'reboot' })).status).toBe(400);
    expect((await base.post('/host-updates/restart/apply').set(headers).send({ planId, force: true })).status).toBe(400);
    expect(hostUpdates.restartPlan).not.toHaveBeenCalled();
    expect(hostUpdates.restartApply).not.toHaveBeenCalled();
    expect((await base.get('/host-updates/restart').set(headers)).body).toEqual({ available: true, job: null });
    expect((await base.post('/host-updates/restart/plan').set(headers).send({})).status).toBe(200);
    expect((await base.post('/host-updates/restart/apply').set(headers).send({ planId })).status).toBe(202);
    expect(hostUpdates.restartPlan).toHaveBeenCalledOnce();
    expect(hostUpdates.restartApply).toHaveBeenCalledExactlyOnceWith(planId);
  });

  it('requires a same-origin operator request for a reviewed package apply', async () => {
    hostUpdates.packagePlan.mockResolvedValue({
      planId: '00000000-0000-4000-8000-000000000000',
      createdAt: 1,
      expiresAt: 901,
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

  it('requires an exact same-origin operator session request to refresh package lists', async () => {
    const route = '/host-updates/packages/refresh';
    for (const identity of [undefined, 'guest-session', 'fixture-cli']) {
      const headers = identity ? { Authorization: `Bearer ${identity}` } : {};
      expect((await request(app.getHttpServer()).post(route).set(headers).send({})).status).toBe(identity ? 403 : 401);
    }
    const headers = { Authorization: 'Bearer fixture-session', Host: 'orbis.example', Origin: 'http://orbis.example' };
    expect(
      (
        await request(app.getHttpServer())
          .post(route)
          .set({ ...headers, Origin: 'http://other.example' })
          .send({})
      ).status,
    ).toBe(403);
    for (const body of [[], { command: 'apt-get update' }, { names: [] }, { options: [] }]) {
      expect((await request(app.getHttpServer()).post(route).set(headers).send(body)).status).toBe(400);
    }
    expect((await request(app.getHttpServer()).post(route).set(headers).set('Content-Type', 'application/json').send('null')).status).toBe(400);
    expect(hostUpdates.packageRefresh).not.toHaveBeenCalled();
    hostUpdates.packageRefresh.mockResolvedValue({ jobId: '00000000-0000-4000-8000-000000000000', state: 'queued' });
    const result = await request(app.getHttpServer()).post(route).set(headers).send({});
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ jobId: '00000000-0000-4000-8000-000000000000', state: 'queued' });
    expect(hostUpdates.packageRefresh).toHaveBeenCalledExactlyOnceWith();
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
