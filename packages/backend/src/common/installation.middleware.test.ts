import { Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallationController } from '@/core/health/installation.controller';
import { installationMiddleware } from './installation.middleware';

const transaction = 'f92e8862-38b5-4e81-bc84-f9131944872d';
const appOperation = vi.fn();

@Controller()
class ProbeController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('apps')
  apps() {
    appOperation();
    return {};
  }

  @Post('apps')
  install() {
    appOperation();
    return {};
  }

  @Post('health')
  mutateHealth() {
    appOperation();
    return {};
  }
}

@Module({ controllers: [ProbeController, InstallationController] })
class ProbeModule {}

describe('installation HTTP boundary', () => {
  let app: INestApplication;

  beforeEach(async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', transaction);
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    appOperation.mockClear();
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(installationMiddleware);
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('serves only read-only health and transaction status while holding the controller', async () => {
    expect((await request(app.getHttpServer()).get('/api/health')).status).toBe(200);
    expect((await request(app.getHttpServer()).head('/api/health')).status).toBe(200);
    const status = await request(app.getHttpServer()).get('/api/installation/status');
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body).toEqual({
      schema: 'orbis.installation-state.v1',
      phase: 'hold',
      transactionId: transaction,
      applicationsHeld: true,
      requiresRecreateToRelease: true,
    });
    expect(appOperation).not.toHaveBeenCalled();
  });

  it('rejects reads, writes and misleading health paths before application handlers', async () => {
    for (const [method, url] of [
      ['get', '/api/apps'],
      ['post', '/api/apps'],
      ['post', '/api/health'],
      ['get', '/api/health/other'],
      ['get', '/api/installation/status/other'],
    ] as const) {
      const response = await request(app.getHttpServer())[method](url);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('ORBIS_INSTALLATION_IN_PROGRESS');
      expect(response.headers['retry-after']).toBe('2');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(appOperation).not.toHaveBeenCalled();
  });

  it('allows normal handlers on an explicitly recreated resume controller', async () => {
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'resume');
    expect((await request(app.getHttpServer()).get('/api/apps')).status).toBe(200);
    expect((await request(app.getHttpServer()).post('/api/apps')).status).toBe(201);
    expect(appOperation).toHaveBeenCalledTimes(2);
  });
});
