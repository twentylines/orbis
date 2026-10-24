import { LoggerService } from '@/core/logger/logger.service';
import { type INestApplication, type NestMiddleware } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AuthGuard } from '../auth/auth.guard';
import { AppEmbeddingController } from './app-embedding.controller';
import { AppEmbeddingService } from './app-embedding.service';

describe('installed app embedding endpoint security', () => {
  let app: INestApplication;
  const embedding = mock<AppEmbeddingService>();
  const path = '/apps/beszel:store/embedding-compatibility';
  const query = { destination: 'http://10.0.0.2:8090/', parentOrigin: 'http://10.0.0.2' };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AppEmbeddingController],
      providers: [AuthGuard, { provide: LoggerService, useValue: mock<LoggerService>() }, { provide: AppEmbeddingService, useValue: embedding }],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'Bearer user') req.user = { id: 1 };
      if (req.headers.authorization === 'Bearer forward') {
        req.user = { id: 1 };
        req.authMethod = 'forward-auth';
      }
      next();
    }) as NestMiddleware['use']);
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() =>
    embedding.check
      .mockReset()
      .mockResolvedValue({ status: 'unknown', reason: 'unreachable', targetUrl: query.destination, checkedAt: 1, expiresAt: 30001 }),
  );

  it('requires authenticated app access and rejects forward-auth identities', async () => {
    expect((await request(app.getHttpServer()).get(path).query(query)).status).toBe(401);
    expect((await request(app.getHttpServer()).get(path).query(query).set('Authorization', 'Bearer forward')).status).toBe(401);
    expect(embedding.check).not.toHaveBeenCalled();
  });

  it('returns the diagnostic without forwarding user cookies or authorization', async () => {
    const response = await request(app.getHttpServer())
      .get(path)
      .query(query)
      .set('Authorization', 'Bearer user')
      .set('Cookie', 'app-secret=never-forward');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({ status: 'unknown', reason: 'unreachable', targetUrl: query.destination, checkedAt: 1, expiresAt: 30001 });
    expect(embedding.check).toHaveBeenCalledExactlyOnceWith('beszel:store', new URL(query.destination), new URL(query.parentOrigin));
  });

  it.each([
    {},
    { destination: query.destination },
    { ...query, arbitraryUrl: 'http://169.254.169.254/' },
    { ...query, destination: ['http://10.0.0.2:8090', 'http://169.254.169.254'] },
    { ...query, parentOrigin: [query.parentOrigin, 'https://other.example.com'] },
    { ...query, destination: 'http://user:secret@10.0.0.2:8090/' },
    { ...query, destination: 'file:///etc/passwd' },
    { ...query, parentOrigin: 'https://orbis.example.com/path' },
    { ...query, parentOrigin: 'https://orbis.example.com/#fragment' },
  ])('rejects malformed or extra query fields %j', async (input) => {
    expect((await request(app.getHttpServer()).get(path).query(input).set('Authorization', 'Bearer user')).status).toBe(400);
    expect(embedding.check).not.toHaveBeenCalled();
  });

  it('rejects remote or malformed URNs instead of resolving arbitrary servers', async () => {
    for (const urn of ['remote/beszel:store', '../beszel:store', 'not-an-urn']) {
      const url = `/apps/${encodeURIComponent(urn)}/embedding-compatibility`;
      expect((await request(app.getHttpServer()).get(url).query(query).set('Authorization', 'Bearer user')).status).toBe(400);
    }
    expect(embedding.check).not.toHaveBeenCalled();
  });
});
