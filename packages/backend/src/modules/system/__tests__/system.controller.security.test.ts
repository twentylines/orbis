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
import { HostTelemetryService } from '../host-telemetry.service';
import { HostProcessesService } from '../host-processes.service';
import { HostSensorsService } from '../host-sensors.service';
import { HostDeviceHistoryService } from '../host-device-history.service';

describe('SystemController certificate security', () => {
  let app: INestApplication;
  const systemService = mock<SystemService>();
  const orbisReleases = mock<OrbisReleaseService>();
  const logger = mock<LoggerService>();
  const containers = mock<ContainerTelemetryService>();
  const history = mock<MetricHistoryService>();
  const host = mock<HostTelemetryService>();
  const processes = mock<HostProcessesService>();
  const sensors = mock<HostSensorsService>();
  const hostHistory = mock<HostDeviceHistoryService>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SystemController],
      providers: [
        AuthGuard,
        { provide: ContainerTelemetryService, useValue: containers },
        { provide: MetricHistoryService, useValue: history },
        { provide: HostTelemetryService, useValue: host },
        { provide: HostProcessesService, useValue: processes },
        { provide: HostSensorsService, useValue: sensors },
        { provide: HostDeviceHistoryService, useValue: hostHistory },
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

  it('requires authentication before reading host devices', async () => {
    expect((await request(app.getHttpServer()).get('/system/host-telemetry')).status).toBe(401);
    expect(host.read).not.toHaveBeenCalled();
    host.read.mockResolvedValue({ available: false, reason: 'Collecting host readings.' });
    const result = await request(app.getHttpServer()).get('/system/host-telemetry').set('Authorization', 'Bearer cli-token');
    expect(result.status).toBe(200);
    expect(result.body.reason).toBe('Collecting host readings.');
    expect(host.read).toHaveBeenCalledOnce();
  });

  it('requires authentication before reading host processes', async () => {
    expect((await request(app.getHttpServer()).get('/system/host-processes')).status).toBe(401);
    expect(processes.read).not.toHaveBeenCalled();
    processes.read.mockResolvedValue({ available: false, reason: 'Collecting process readings.' });
    const result = await request(app.getHttpServer()).get('/system/host-processes').set('Authorization', 'Bearer cli-token');
    expect(result.status).toBe(200);
    expect(result.body.reason).toBe('Collecting process readings.');
    expect(processes.read).toHaveBeenCalledOnce();
  });

  it('authenticates sensor reads before calling the fixed helper operation', async () => {
    expect((await request(app.getHttpServer()).get('/system/host-sensors?path=/etc/shadow')).status).toBe(401);
    expect(sensors.read).not.toHaveBeenCalled();
    sensors.read.mockResolvedValue({ available: false, reason: 'Collecting sensor readings.' });
    const result = await request(app.getHttpServer()).get('/system/host-sensors').set('Authorization', 'Bearer cli-token');
    expect(result.status).toBe(200);
    expect(result.body.reason).toBe('Collecting sensor readings.');
    expect(sensors.read).toHaveBeenCalledOnce();
    expect(sensors.read).toHaveBeenCalledWith();
  });

  it('requires authentication for build metadata and reports the installed version', async () => {
    const denied = await request(app.getHttpServer()).get('/system/build');
    expect(denied.status).toBe(401);

    const allowed = await request(app.getHttpServer()).get('/system/build').set('Authorization', 'Bearer cli-token');
    expect(allowed.status).toBe(200);
    expect(allowed.body.version).toBe(process.env.ORBIS_VERSION || 'development');
    expect(allowed.body.runtipiCompatibility).toBe(process.env.TIPI_VERSION || null);
  });

  it('authenticates host history before validating bounded logical lookups', async () => {
    expect((await request(app.getHttpServer()).get('/system/host-history?device=disk:../../etc/passwd')).status).toBe(401);
    expect(hostHistory.read).not.toHaveBeenCalled();
    for (const query of [
      'range=forever',
      'range=5m&range=7d',
      'device=disk:../../etc/passwd',
      'device=disk:sda&device=disk:sdb',
      'device=network:',
    ]) {
      expect((await request(app.getHttpServer()).get(`/system/host-history?${query}`).set('Authorization', 'Bearer cli-token')).status).toBe(400);
    }
    expect(hostHistory.read).not.toHaveBeenCalled();
    expect(
      (await request(app.getHttpServer()).get('/system/host-history?range=24h&device=network:eth0:1').set('Authorization', 'Bearer cli-token'))
        .status,
    ).toBe(200);
    expect(hostHistory.read).toHaveBeenLastCalledWith('24h', { kind: 'network', name: 'eth0:1' });
    expect((await request(app.getHttpServer()).get('/system/host-history').set('Authorization', 'Bearer cli-token')).status).toBe(200);
    expect(hostHistory.read).toHaveBeenLastCalledWith('1h', null);
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
