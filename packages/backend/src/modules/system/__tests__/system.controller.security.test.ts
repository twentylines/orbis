import { LoggerService } from '@/core/logger/logger.service';
import { Test } from '@nestjs/testing';
import { type INestApplication, type NestMiddleware } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AuthGuard } from '../../auth/auth.guard';
import { SystemController } from '../system.controller';
import { SystemService } from '../system.service';
import { OrbisReleaseService } from '../orbis-release.service';
import { ContainerTelemetryService } from '../container-telemetry.service';
import { MetricHistoryService } from '../metric-history.service';

describe('SystemController certificate security', () => {
  let app: INestApplication;
  const systemService = mock<SystemService>();
  const orbisReleases = mock<OrbisReleaseService>();
  const logger = mock<LoggerService>();
  const containers = mock<ContainerTelemetryService>();
  const history = mock<MetricHistoryService>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SystemController],
      providers: [
        AuthGuard,
        { provide: ContainerTelemetryService, useValue: containers },
        { provide: MetricHistoryService, useValue: history },
        { provide: OrbisReleaseService, useValue: orbisReleases },
        {
          provide: SystemService,
          useValue: systemService,
        },
        {
          provide: LoggerService,
          useValue: logger,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'Bearer cli-token') {
        req.user = { id: 1 };
      }
      next();
    }) as NestMiddleware['use']);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    systemService.getLocalCertificate.mockReset();
  });

  it('allows unauthenticated certificate downloads', async () => {
    systemService.getLocalCertificate.mockResolvedValue('test-certificate');

    const response = await request(app.getHttpServer()).get('/system/certificate');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-pem-file');
    expect(response.headers['content-disposition']).toBe('attachment; filename=cert.pem');
    expect(response.text).toBe('test-certificate');
  });

  it('allows authenticated certificate downloads', async () => {
    systemService.getLocalCertificate.mockResolvedValue('test-certificate');

    const response = await request(app.getHttpServer()).get('/system/certificate').set('Authorization', 'Bearer cli-token');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-pem-file');
    expect(response.headers['content-disposition']).toBe('attachment; filename=cert.pem');
    expect(response.text).toBe('test-certificate');
  });

  it('requires authentication for telemetry', async () => {
    const denied = await request(app.getHttpServer()).get('/system/telemetry');
    expect(denied.status).toBe(401);

    systemService.getTelemetry.mockResolvedValue({
      sampledAt: '2026-10-15T00:00:00.000Z',
      cpu: { scope: 'runtime', totalPercent: 0, perCorePercent: [], uptimeSeconds: 0 },
      memory: { scope: 'host-proc', totalBytes: null, availableBytes: null, swapTotalBytes: null, swapFreeBytes: null },
      filesystems: [],
      network: [],
    });
    const allowed = await request(app.getHttpServer()).get('/system/telemetry').set('Authorization', 'Bearer cli-token');
    expect(allowed.status).toBe(200);
    expect(allowed.body.cpu.scope).toBe('runtime');
  });
  it('requires authentication before reading Docker containers', async () => {
    expect((await request(app.getHttpServer()).get('/system/containers')).status).toBe(401);
    expect(containers.read).not.toHaveBeenCalled();
    containers.read.mockResolvedValue({ sampledAt: new Date().toISOString(), available: true, containers: [], omitted: 0 });
    expect((await request(app.getHttpServer()).get('/system/containers').set('Authorization', 'Bearer cli-token')).status).toBe(200);
    expect(containers.read).toHaveBeenCalledOnce();
  });

  it('requires authentication for build metadata and reports the installed version', async () => {
    const denied = await request(app.getHttpServer()).get('/system/build');
    expect(denied.status).toBe(401);

    const allowed = await request(app.getHttpServer()).get('/system/build').set('Authorization', 'Bearer cli-token');
    expect(allowed.status).toBe(200);
    expect(allowed.body.version).toBe(process.env.ORBIS_VERSION || 'development');
    expect(allowed.body.runtipiCompatibility).toBe(process.env.TIPI_VERSION || null);
  });

  it('requires authentication and an allowlisted metric history range', async () => {
    expect((await request(app.getHttpServer()).get('/system/history?range=7d')).status).toBe(401);
    expect(history.read).not.toHaveBeenCalled();
    expect((await request(app.getHttpServer()).get('/system/history?range=forever').set('Authorization', 'Bearer cli-token')).status).toBe(400);
    expect((await request(app.getHttpServer()).get('/system/history?range=5m&range=7d').set('Authorization', 'Bearer cli-token')).status).toBe(400);
    expect((await request(app.getHttpServer()).get('/system/history?range=7d').set('Authorization', 'Bearer cli-token')).status).toBe(200);
    expect(history.read).toHaveBeenCalledWith('7d');
  });

  it('requires authentication for the cached Orbis changelog', async () => {
    const denied = await request(app.getHttpServer()).get('/system/orbis-release');
    expect(denied.status).toBe(401);
    expect(orbisReleases.latest).not.toHaveBeenCalled();

    orbisReleases.latest.mockResolvedValue({
      tag: 'v0.1.0-beta.8',
      publishedAt: '2026-10-15T02:18:39Z',
      body: '# Orbis beta 8',
      url: 'https://github.com/twentylines/orbis/releases/tag/v0.1.0-beta.8',
      imageManifestUrl: 'https://github.com/twentylines/orbis/releases/download/v0.1.0-beta.8/release-manifest.json',
    });
    const allowed = await request(app.getHttpServer()).get('/system/orbis-release').set('Authorization', 'Bearer cli-token');
    expect(allowed.status).toBe(200);
    expect(allowed.body.tag).toBe('v0.1.0-beta.8');
  });
});
