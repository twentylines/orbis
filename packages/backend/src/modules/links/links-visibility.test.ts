import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { type INestApplication, type NestMiddleware, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { fromAny } from '@total-typescript/shoehorn';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ArkValidationPipe } from 'nestjs-arktype';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { LINK_GUEST_VISIBILITY_PATCH } from './dto/links.dto';
import { LinksController } from './links.controller';
import { LinksRepository } from './links.repository';
import { LinksService } from './links.service';

const original = {
  id: 101,
  title: 'Saved link',
  url: 'https://example.test/',
  iconUrl: 'https://example.test/icon.png',
  createdAt: 1,
  updatedAt: 1,
  userId: 7,
  description: 'Saved description',
  isVisibleOnGuestDashboard: false,
};

function result(row: typeof original) {
  return {
    rows: [[row.id, row.title, row.url, row.iconUrl, row.createdAt, row.updatedAt, row.userId, row.description, row.isVisibleOnGuestDashboard]],
  };
}

describe('Guest dashboard visibility for saved links', () => {
  let app: INestApplication;
  const query = vi.fn<({ text }: { text: string }, values: unknown[]) => Promise<{ rows: unknown[][] }>>();

  beforeAll(async () => {
    const db = drizzle({ query } as unknown as Pool);
    const module = await Test.createTestingModule({
      controllers: [LinksController],
      providers: [
        AuthGuard,
        LinksService,
        { provide: LinksRepository, useValue: new LinksRepository(fromAny(db)) },
        { provide: ConfigurationService, useValue: { get: () => ({ guestDashboard: true }) } },
        { provide: LoggerService, useValue: { debug: vi.fn() } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'Bearer synthetic-owner') {
        req.user = { id: 7 };
        req.authMethod = 'session';
      }
      if (req.headers.authorization === 'Bearer synthetic-visitor') {
        req.user = { id: 8 };
        req.authMethod = 'session';
      }
      next();
    }) as NestMiddleware['use']);
    app.useGlobalPipes(new ArkValidationPipe(), new ValidationPipe());
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    query.mockReset();
  });
  afterAll(async () => app?.close());

  const edit = (body: object, account = 'synthetic-owner') =>
    request(app.getHttpServer())
      .patch('/links/101')
      .set('Authorization', `Bearer ${account}`)
      .set('Origin', `http://127.0.0.1:${app.getHttpServer().address().port}`)
      .send(body);

  it('advertises the contract only to the authenticated owned-link list', async () => {
    query.mockResolvedValue(result(original));
    const http = request(app.getHttpServer());
    await http.get('/links').expect(401);
    await http.patch('/links/101').send({ isVisibleOnGuestDashboard: true }).expect(401);
    await http.patch('/links/101').set('Authorization', 'Bearer synthetic-owner').send({ isVisibleOnGuestDashboard: true }).expect(403);
    const owned = await http.get('/links').set('Authorization', 'Bearer synthetic-owner').expect(200);
    expect(owned.body).toMatchObject({ links: [original], editCapabilities: [LINK_GUEST_VISIBILITY_PATCH] });
    const guest = await http.get('/links/guest').expect(200);
    expect(guest.body).not.toHaveProperty('editCapabilities');
  });

  it.each([true, false])('only updates visibility for an owned link (%s)', async (visible) => {
    query.mockResolvedValueOnce(result({ ...original, isVisibleOnGuestDashboard: visible }));
    const response = await edit({ isVisibleOnGuestDashboard: visible }).expect(200);
    expect(response.body).toMatchObject({ ...original, isVisibleOnGuestDashboard: visible });
    expect(query).toHaveBeenCalledTimes(1);
    const statement = query.mock.calls[0]?.[0].text;
    expect(statement?.split(' where ')[0]).toBe('update "link" set "updated_at" = $1, "is_visible_on_guest_dashboard" = $2');
    expect(statement).toContain('where ("link"."id" = $3 and "link"."user_id" = $4)');
    expect(query.mock.calls[0]?.[1].slice(1)).toEqual([visible, '101', 7]);
  });

  it('keeps legacy full edits and metadata-only saves compatible', async () => {
    const metadata = { title: 'Renamed link', url: original.url, iconUrl: original.iconUrl, description: original.description };
    query.mockResolvedValueOnce(result({ ...original, ...metadata, isVisibleOnGuestDashboard: true }));
    query.mockResolvedValueOnce(result({ ...original, ...metadata, isVisibleOnGuestDashboard: true }));
    expect((await edit({ ...metadata, isVisibleOnGuestDashboard: true }).expect(200)).body.isVisibleOnGuestDashboard).toBe(true);
    expect((await edit(metadata).expect(200)).body.isVisibleOnGuestDashboard).toBe(true);
    expect(query.mock.calls[0]?.[0].text.split(' where ')[0]).toContain('"is_visible_on_guest_dashboard"');
    expect(query.mock.calls[1]?.[0].text.split(' where ')[0]).not.toContain('"is_visible_on_guest_dashboard"');
  });

  it.each([
    {},
    { isVisibleOnGuestDashboard: 'true' },
    { isVisibleOnGuestDashboard: true, title: 'A' },
    { isVisibleOnGuestDashboard: true, userId: 8 },
  ])('rejects an invalid partial payload without reaching the database (%j)', async (body) => {
    await edit(body).expect(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('scopes the write to the caller even for a different account’s link id', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const response = await edit({ isVisibleOnGuestDashboard: true }, 'synthetic-visitor').expect(200);
    expect(response.text).toBe('');
    expect(query.mock.calls[0]?.[0].text).toContain('"link"."user_id" = $4');
    expect(query.mock.calls[0]?.[1].at(-1)).toBe(8);
  });
});
