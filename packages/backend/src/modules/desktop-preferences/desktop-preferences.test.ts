import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { type INestApplication, type NestMiddleware } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ArkValidationPipe } from 'nestjs-arktype';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AuthGuard } from '../auth/auth.guard';
import { DesktopPreferencesController } from './desktop-preferences.controller';
import { DEFAULT_DESKTOP_PREFERENCES, DesktopPreferencesService } from './desktop-preferences.service';

describe('desktop preferences', () => {
  let directory: string;
  let app: INestApplication;

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtipi-desktop-test-'));
    const config = mock<ConfigurationService>();
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    const module = await Test.createTestingModule({
      controllers: [DesktopPreferencesController],
      providers: [
        AuthGuard,
        DesktopPreferencesService,
        { provide: ConfigurationService, useValue: config },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'Bearer test') req.user = { id: 7 };
      next();
    }) as NestMiddleware['use']);
    app.useGlobalPipes(new ArkValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('requires authentication for reading and writing', async () => {
    expect((await request(app.getHttpServer()).get('/desktop-preferences')).status).toBe(401);
    expect((await request(app.getHttpServer()).put('/desktop-preferences').send(DEFAULT_DESKTOP_PREFERENCES)).status).toBe(401);
  });

  it('persists validated preferences per user and rejects invalid values', async () => {
    const initial = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test');
    expect(initial.body).toEqual(DEFAULT_DESKTOP_PREFERENCES);

    const invalid = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ serverName: '', preset: 'unknown', density: 'compact' });
    expect(invalid.status).toBe(400);

    const value = { serverName: 'Workshop', preset: 'forest', density: 'compact' };
    const saved = await request(app.getHttpServer()).put('/desktop-preferences').set('Authorization', 'Bearer test').send(value);
    expect(saved.status).toBe(200);
    const fetched = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test');
    expect(fetched.body).toEqual(value);
    const file = await fs.stat(path.join(directory, 'state', 'desktop', '7.json'));
    expect(file.mode & 0o777).toBe(0o600);
  });
});
