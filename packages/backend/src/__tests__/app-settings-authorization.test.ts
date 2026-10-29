import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type INestApplication, type NestMiddleware } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ArkValidationPipe } from 'nestjs-arktype';
import { AppController } from '../app.controller';
import { AppService } from '../app.service';
import { ConfigurationService } from '../core/config/configuration.service';
import { LoggerService } from '../core/logger/logger.service';
import { UserRepository } from '../modules/user/user.repository';
import { AppsService } from '../modules/apps/apps.service';
import { MarketplaceService } from '../modules/marketplace/marketplace.service';
import { AuthGuard } from '../modules/auth/auth.guard';
import { DesktopPreferencesController } from '../modules/desktop-preferences/desktop-preferences.controller';
import { DesktopPreferencesService, DEFAULT_DESKTOP_PREFERENCES } from '../modules/desktop-preferences/desktop-preferences.service';
import { DesktopWallpaperService } from '../modules/desktop-preferences/desktop-wallpaper.service';

describe('shared server settings authorization', () => {
  let app: INestApplication;
  let directory: string;
  const configuration = mock<ConfigurationService>();
  const change = { localDomain: 'orbis.private.test', domain: 'orbis.example.net', sslPort: 8443, trustedProxyIps: '192.168.5.2' };
  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-settings-authorization-'));
    configuration.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    const module = await Test.createTestingModule({
      controllers: [AppController, DesktopPreferencesController],
      providers: [
        AuthGuard,
        DesktopPreferencesService,
        { provide: DesktopWallpaperService, useValue: mock<DesktopWallpaperService>() },
        { provide: AppService, useValue: mock<AppService>() },
        { provide: UserRepository, useValue: mock<UserRepository>() },
        { provide: ConfigurationService, useValue: configuration },
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: MarketplaceService, useValue: mock<MarketplaceService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      const identity = req.headers.authorization?.replace('Bearer ', '');
      if (identity && ['operator', 'member', 'cli', 'forward'].includes(identity)) {
        req.user = { id: identity === 'member' ? 8 : 7, operator: identity !== 'member' };
        req.authMethod = identity === 'cli' ? 'cli' : identity === 'forward' ? 'forward-auth' : 'session';
      }
      next();
    }) as NestMiddleware['use']);
    app.useGlobalPipes(new ArkValidationPipe());
    await app.init();
  });
  beforeEach(() => configuration.setUserSettings.mockClear());
  afterAll(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const patch = (identity?: string, origin = 'http://orbis.example.test') => {
    const action = request(app.getHttpServer()).patch('/user-settings').set('Host', 'orbis.example.test').set('Origin', origin);
    return identity ? action.set('Authorization', `Bearer ${identity}`).send(change) : action.send(change);
  };
  it('refuses unauthenticated, nonoperator, CLI and forward-auth writes before mutating shared settings', async () => {
    expect((await patch()).status).toBe(401);
    expect((await patch('member')).status).toBe(403);
    expect((await patch('cli')).status).toBe(403);
    expect((await patch('forward')).status).toBe(401);
    expect(configuration.setUserSettings).not.toHaveBeenCalled();
  });
  it('retains the same-origin check for an operator session', async () => {
    expect((await patch('operator', 'https://another.example.test')).status).toBe(403);
    expect(configuration.setUserSettings).not.toHaveBeenCalled();
  });
  it('allows the operator browser to save validated shared HTTPS settings', async () => {
    expect((await patch('operator')).status).toBe(200);
    expect(configuration.setUserSettings).toHaveBeenCalledExactlyOnceWith(change);
  });
  it('preserves nonoperator account-local preference persistence and account isolation', async () => {
    const own = { ...DEFAULT_DESKTOP_PREFERENCES, preset: 'forest', serverName: 'My workspace' };
    const saved = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Host', 'orbis.example.test')
      .set('Origin', 'http://orbis.example.test')
      .set('Authorization', 'Bearer member')
      .send(own);
    expect(saved.status).toBe(200);
    expect(saved.body.preset).toBe('forest');
    const ownRead = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer member');
    expect(ownRead.body.serverName).toBe('My workspace');
    const otherRead = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer operator');
    expect(otherRead.body.preset).toBe(DEFAULT_DESKTOP_PREFERENCES.preset);
    expect(configuration.setUserSettings).not.toHaveBeenCalled();
  });
});
