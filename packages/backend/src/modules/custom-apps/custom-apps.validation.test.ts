import { Test } from '@nestjs/testing';
import { APP_PIPE } from '@nestjs/core';
import { ArkValidationPipe } from 'nestjs-arktype';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import { expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { CustomAppController } from './custom-apps.controller';
import { CustomAppService } from './custom-apps.service';

it('refuses inline migrations through the actual create/update HTTP validation before calling the app service', async () => {
  const service = mock<CustomAppService>();
  service.createCustomApp.mockResolvedValue({ appUrn: 'demo:_user', appName: 'demo', storeId: '_user' } as never);
  const module = await Test.createTestingModule({
    controllers: [CustomAppController],
    providers: [
      { provide: CustomAppService, useValue: service },
      { provide: LoggerService, useValue: mock<LoggerService>() },
      { provide: APP_PIPE, useClass: ArkValidationPipe },
    ],
  }).compile();
  const app = module.createNestApplication();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: 7, operator: true } as Request['user'];
    req.authMethod = 'session';
    next();
  });
  await app.init();
  try {
    const api = request(app.getHttpServer());
    const valid = { services: { web: { image: 'example:latest' } }, 'x-runtipi': { schema_version: 2 } };
    for (const migrations of [[], [{ id: '001-schema', service: 'migration' }], null]) {
      const config = { ...valid, 'x-runtipi': { schema_version: 2, migrations } };
      await api.post('/custom-apps').set('Host', 'orbis.test').set('Origin', 'http://orbis.test').send({ name: 'demo', config }).expect(400);
      await api.patch('/custom-apps/demo:_user').set('Host', 'orbis.test').set('Origin', 'http://orbis.test').send({ config }).expect(400);
    }
    expect(service.createCustomApp).not.toHaveBeenCalled();
    expect(service.updateCustomApp).not.toHaveBeenCalled();
    await api.post('/custom-apps').set('Host', 'orbis.test').set('Origin', 'http://orbis.test').send({ name: 'demo', config: valid }).expect(201);
    expect(service.createCustomApp).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
