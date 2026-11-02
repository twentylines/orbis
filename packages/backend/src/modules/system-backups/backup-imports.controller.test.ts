import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication, NestMiddleware } from '@nestjs/common';
import request from 'supertest';
import { AuthGuard } from '../auth/auth.guard';
import { LoggerService } from '@/core/logger/logger.service';
import { BackupImportsController } from './backup-imports.controller';
import { BackupImportsService } from './backup-imports.service';

describe('uploaded backup operator session', () => {
  let app: INestApplication;
  const service = { createUpload: vi.fn().mockResolvedValue({ id: 'fixture' }), reviewUpload: vi.fn().mockResolvedValue({ status: 'reviewing' }) };
  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [BackupImportsController],
      providers: [AuthGuard, { provide: BackupImportsService, useValue: service }, { provide: LoggerService, useValue: { debug: vi.fn() } }],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization) {
        req.user = { id: 7, operator: req.headers.authorization === 'operator' };
        req.authMethod = 'session';
      }
      next();
    }) as NestMiddleware['use']);
    await app.init();
  });
  afterEach(async () => app.close());

  it('requires an operator session and same origin to reserve an upload', async () => {
    const post = () => request(app.getHttpServer()).post('/system-backups/imports').set('Host', 'orbis.test');
    expect((await post().set('Origin', 'http://orbis.test').send({})).status).toBe(401);
    expect((await post().set('Authorization', 'member').set('Origin', 'http://orbis.test').send({})).status).toBe(403);
    expect((await post().set('Authorization', 'operator').set('Origin', 'https://other.test').send({})).status).toBe(403);
    expect(service.createUpload).not.toHaveBeenCalled();
    expect((await post().set('Authorization', 'operator').set('Origin', 'http://orbis.test').send({})).status).toBe(201);
    expect(service.createUpload).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('requires the archive key and the same session protections for review', async () => {
    const post = () => request(app.getHttpServer()).post('/system-backups/imports/fixture/review').set('Host', 'orbis.test');
    expect((await post().set('Authorization', 'operator').set('Origin', 'https://other.test').send({ passphrase: '12345678' })).status).toBe(403);
    expect((await post().set('Authorization', 'operator').set('Origin', 'http://orbis.test').send({})).status).toBe(400);
    expect((await post().set('Authorization', 'operator').set('Origin', 'http://orbis.test').send({ passphrase: '12345678' })).status).toBe(202);
    expect(service.reviewUpload).toHaveBeenCalledExactlyOnceWith('fixture', 7, '12345678');
  });

  it('rejects cross-origin upload bytes before reaching the import service', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .put('/system-backups/imports/fixture/file')
          .set('Host', 'orbis.test')
          .set('Authorization', 'operator')
          .set('Origin', 'https://other.test')
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.alloc(52))
      ).status,
    ).toBe(403);
  });
});
