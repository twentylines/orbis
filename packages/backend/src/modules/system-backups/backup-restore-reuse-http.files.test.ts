import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import { BackupRestoresController } from './backup-restores.controller';
import { BackupRestoresService } from './backup-restores.service';
let app: INestApplication;
let origin: string;
const reuse = vi.fn();
beforeEach(async () => {
  reuse.mockReset().mockImplementation(async (_id, owner) => ({ id: randomUUID(), owner, status: 'uploaded' }));
  const module = await Test.createTestingModule({
    controllers: [BackupRestoresController],
    providers: [AuthGuard, { provide: BackupRestoresService, useValue: { reuse } }, { provide: LoggerService, useValue: { debug: vi.fn() } }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.use((req: Request, _response: Response, next: NextFunction) => {
    const role = req.headers['x-fixture-role'];
    if (role) {
      req.authMethod = role === 'forward' ? 'forward-auth' : 'session';
      req.user = { id: 7, operator: role !== 'viewer' } as Request['user'];
    }
    next();
  });
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});
afterEach(async () => {
  await app.close();
});
it('requires actual session, operator and same-origin admission on the reuse route without account proof', async () => {
  const route = `/api/system-backups/restores/${randomUUID()}/reuse`;
  const api = () => request(app.getHttpServer());
  await api().post(route).set('Origin', origin).send({}).expect(401);
  await api().post(route).set('x-fixture-role', 'forward').set('Origin', origin).send({}).expect(401);
  await api().post(route).set('x-fixture-role', 'viewer').set('Origin', origin).send({}).expect(403);
  await api().post(route).set('x-fixture-role', 'operator').set('Origin', 'https://unrelated.invalid').send({}).expect(403);
  await api().post(route).set('x-fixture-role', 'operator').send({}).expect(403);
  expect(reuse).not.toHaveBeenCalled();
  const result = await api().post(route).set('x-fixture-role', 'operator').set('Origin', origin).send({}).expect(201);
  expect(result.body.status).toBe('uploaded');
  expect(reuse).toHaveBeenCalledOnce();
  expect(reuse.mock.calls[0]?.[1]).toBe(7);
});
