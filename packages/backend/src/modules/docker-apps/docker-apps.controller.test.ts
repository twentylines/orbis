import { Test } from '@nestjs/testing';
import type { INestApplication, NestMiddleware } from '@nestjs/common';
import { ArkValidationPipe } from 'nestjs-arktype';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import { DockerAppsController } from './docker-apps.controller';
import { DockerAppsService } from './docker-apps.service';

describe('Docker app HTTP permissions', () => {
  let app: INestApplication;
  const service = mock<DockerAppsService>();
  const id = 'a'.repeat(64);

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [DockerAppsController],
      providers: [AuthGuard, { provide: DockerAppsService, useValue: service }, { provide: LoggerService, useValue: mock<LoggerService>() }],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'Bearer test') {
        req.user = { id: 1 };
        req.authMethod = 'session';
      }
      next();
    }) as NestMiddleware['use']);
    app.useGlobalPipes(new ArkValidationPipe());
    await app.listen(0, '127.0.0.1');
  });
  afterEach(async () => app.close());

  it('requires authentication for inventory, review and uninstall', async () => {
    expect((await request(app.getHttpServer()).get('/docker-apps')).status).toBe(401);
    expect((await request(app.getHttpServer()).get(`/docker-apps/${id}/uninstall`)).status).toBe(401);
    expect((await request(app.getHttpServer()).post(`/docker-apps/${id}/uninstall`)).status).toBe(401);
    expect(service.read).not.toHaveBeenCalled();
    expect(service.uninstall).not.toHaveBeenCalled();
  });

  it('rejects session mutations from another origin', async () => {
    const result = await request(app.getHttpServer())
      .post(`/docker-apps/${id}/uninstall`)
      .set('Authorization', 'Bearer test')
      .set('Origin', 'https://untrusted.invalid')
      .send({ reviewId: id, name: 'photos' });
    expect(result.status).toBe(403);
    expect(service.uninstall).not.toHaveBeenCalled();
  });

  it('validates the review fingerprint and name before dispatch', async () => {
    const result = await request(app.getHttpServer())
      .post(`/docker-apps/${id}/uninstall`)
      .set('Authorization', 'Bearer test')
      .set('Host', 'orbis.test')
      .set('Origin', 'http://orbis.test')
      .send({ reviewId: 'invalid', name: '' });
    expect(result.status).toBe(400);
    expect(service.uninstall).not.toHaveBeenCalled();
  });

  it('dispatches a valid authenticated same-origin review', async () => {
    service.uninstall.mockResolvedValue({
      success: true,
      requestId: 'f92e8862-38b5-4e81-bc84-f9131944872d',
      removedContainers: 2,
      retainedData: true,
    });
    const result = await request(app.getHttpServer())
      .post(`/docker-apps/${id}/uninstall`)
      .set('Authorization', 'Bearer test')
      .set('Host', 'orbis.test')
      .set('Origin', 'http://orbis.test')
      .send({ reviewId: id, name: 'photos' });
    expect(result.status).toBe(201);
    expect(service.uninstall).toHaveBeenCalledExactlyOnceWith(id, id, 'photos');
  });
});
