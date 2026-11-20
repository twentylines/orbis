import { LoggerService } from '@/core/logger/logger.service';
import { Test } from '@nestjs/testing';
import type { INestApplication, NestMiddleware } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { ExchangeRatesController } from './exchange-rates.controller';
import { ExchangeRatesService } from './exchange-rates.service';
let app: INestApplication;
const read = vi.fn(async () => ({ source: 'ECB', base: 'EUR', asOf: '2026-11-18', stale: false, rates: { EUR: '1', PHP: '69.832', SGD: '1.4144' } }));
beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ExchangeRatesController],
    providers: [{ provide: LoggerService, useValue: { debug: vi.fn() } }, AuthGuard, { provide: ExchangeRatesService, useValue: { read } }],
  }).compile();
  app = module.createNestApplication();
  app.use(((req, _res, next) => {
    if (req.headers.authorization === 'Bearer test-session') req.user = { id: 1 };
    next();
  }) as NestMiddleware['use']);
  await app.init();
});
afterAll(async () => {
  await app?.close();
});
it('authenticates rate discovery before fetching and exposes only the dated fixed-source rate snapshot', async () => {
  expect((await request(app.getHttpServer()).get('/system/exchange-rates')).status).toBe(401);
  expect(read).not.toHaveBeenCalled();
  const result = await request(app.getHttpServer()).get('/system/exchange-rates').set('Authorization', 'Bearer test-session');
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ source: 'ECB', asOf: '2026-11-18', rates: { PHP: '69.832', SGD: '1.4144' } });
  expect(read).toHaveBeenCalledOnce();
});
