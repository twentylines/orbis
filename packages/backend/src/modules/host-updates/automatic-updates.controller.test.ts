import { type INestApplication, type NestMiddleware } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { HostUpdatesGuard } from './host-updates.guard';
import { AutomaticUpdatesController } from './automatic-updates.controller';
import { AutomaticUpdatesService } from './automatic-updates.service';
import { BrowserPresenceController } from '@/core/monitoring/browser-presence.controller';
import { MonitoringActivityService } from '@/core/monitoring/monitoring-activity.service';
import { LoggerService } from '@/core/logger/logger.service';

const settings = { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } };
describe('automatic update settings and browser presence authorization', () => {
  let app: INestApplication;
  const automatic = { read: vi.fn(), update: vi.fn(), readApp: vi.fn(), updateApp: vi.fn() };
  const activity = { touchBrowser: vi.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AutomaticUpdatesController, BrowserPresenceController],
      providers: [
        AuthGuard,
        HostUpdatesGuard,
        { provide: AutomaticUpdatesService, useValue: automatic },
        { provide: MonitoringActivityService, useValue: activity },
        { provide: LoggerService, useValue: { debug: vi.fn() } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'Bearer operator') {
        req.user = { id: 1, operator: true };
        req.authMethod = 'session';
      }
      if (req.headers.authorization === 'Bearer guest') {
        req.user = { id: 2, operator: false };
        req.authMethod = 'session';
      }
      if (req.headers.authorization === 'Bearer cli') {
        req.user = { id: 1, operator: true };
        req.authMethod = 'cli';
      }
      next();
    }) as NestMiddleware['use']);
    await app.init();
  });
  beforeEach(() => {
    for (const fn of Object.values(automatic)) fn.mockReset();
    activity.touchBrowser.mockReset();
  });
  afterAll(async () => app.close());
  it('requires an operator browser session for global and per-app reads', async () => {
    for (const path of ['/host-updates/automatic', '/host-updates/automatic/apps/adguard%3Atipi']) {
      expect((await request(app.getHttpServer()).get(path)).status).toBe(401);
      for (const identity of ['guest', 'cli'])
        expect((await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${identity}`)).status).toBe(403);
    }
    expect(automatic.read).not.toHaveBeenCalled();
    expect(automatic.readApp).not.toHaveBeenCalled();
    automatic.read.mockResolvedValue({ settings, available: true });
    expect((await request(app.getHttpServer()).get('/host-updates/automatic').set('Authorization', 'Bearer operator')).status).toBe(200);
  });
  it('enforces same origin for every schedule mutation, including disabling', async () => {
    for (const path of ['/host-updates/automatic', '/host-updates/automatic/apps/adguard%3Atipi']) {
      const body = path.endsWith('automatic') ? settings : { mode: 'disabled' };
      expect((await request(app.getHttpServer()).put(path).send(body)).status).toBe(401);
      for (const identity of ['guest', 'cli'])
        expect(
          (
            await request(app.getHttpServer())
              .put(path)
              .set('Authorization', `Bearer ${identity}`)
              .set('Host', 'orbis.example')
              .set('Origin', 'http://orbis.example')
              .send(body)
          ).status,
        ).toBe(403);
      expect(
        (
          await request(app.getHttpServer())
            .put(path)
            .set('Authorization', 'Bearer operator')
            .set('Host', 'orbis.example')
            .set('Origin', 'http://other.example')
            .send(body)
        ).status,
      ).toBe(403);
    }
    expect(automatic.update).not.toHaveBeenCalled();
    expect(automatic.updateApp).not.toHaveBeenCalled();
    automatic.updateApp.mockResolvedValue({ rule: { mode: 'disabled' }, shared: settings.schedule, available: false });
    expect(
      (
        await request(app.getHttpServer())
          .put('/host-updates/automatic/apps/adguard%3Atipi')
          .set('Authorization', 'Bearer operator')
          .set('Host', 'orbis.example')
          .set('Origin', 'http://orbis.example')
          .send({ mode: 'disabled' })
      ).status,
    ).toBe(200);
    expect(automatic.updateApp).toHaveBeenCalledWith('adguard:tipi', { mode: 'disabled' });
  });
  it('tracks visible browser fallback for every signed-in user but rejects CLI, missing sessions, cross-origin or arbitrary options', async () => {
    const route = '/monitoring/presence';
    expect((await request(app.getHttpServer()).post(route).send({})).status).toBe(401);
    expect((await request(app.getHttpServer()).post(route).set('Authorization', 'Bearer cli').send({})).status).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post(route)
          .set('Authorization', 'Bearer operator')
          .set('Host', 'orbis.example')
          .set('Origin', 'http://other.example')
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post(route)
          .set('Authorization', 'Bearer guest')
          .set('Host', 'orbis.example')
          .set('Origin', 'http://orbis.example')
          .send({ lease: 99999999 })
      ).status,
    ).toBe(400);
    expect(activity.touchBrowser).not.toHaveBeenCalled();
    for (const identity of ['guest', 'operator'])
      expect(
        (
          await request(app.getHttpServer())
            .post(route)
            .set('Authorization', `Bearer ${identity}`)
            .set('Host', 'orbis.example')
            .set('Origin', 'http://orbis.example')
            .send({})
        ).status,
      ).toBe(204);
    expect(activity.touchBrowser).toHaveBeenCalledTimes(2);
  });
});
