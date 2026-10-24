import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { CacheService } from '@/core/cache/cache.service';
import { LoggerService } from '@/core/logger/logger.service';
import { UserRepository } from '@/modules/user/user.repository';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { AuthGuard } from '../auth.guard';
import { PasskeyService } from '../passkey.service';
import { PasskeyStore } from '../passkey.store';
import { SessionManager } from '../session.manager';
import { passkeyAuthenticator } from './passkey.fixture';

describe('passkey HTTP boundaries and cookies', () => {
  let app: INestApplication;
  let directory: string;
  const auth = mock<AuthService>();
  const config = mock<ConfigurationService>();
  const users = mock<UserRepository>();
  const sessions = mock<SessionManager>();
  const origin = 'https://orbis.example.test';
  const session = 'runtipi-sid=browser-session';
  const post = (path: string) =>
    request(app.getHttpServer())
      .post(`/api/auth/passkeys${path}`)
      .set('Host', 'orbis.example.test')
      .set('Origin', origin)
      .set('X-Forwarded-Proto', 'https');
  const operator = {
    id: 41,
    username: 'operator@example.test',
    password: 'hash',
    totpEnabled: false,
    totpSecret: null,
    salt: null,
    createdAt: 1,
    updatedAt: 1,
    locale: 'en',
    operator: true,
    hasSeenWelcome: true,
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-passkey-http-'));
    config.get
      .mockReset()
      .mockImplementation(
        (key: string) =>
          (key === 'directories'
            ? { dataDir: directory }
            : key === 'userSettings'
              ? { domain: 'orbis.example.test', localDomain: 'orbis.local', sslPort: 443, experimental: { insecureCookie: false } }
              : false) as never,
      );
    auth.verifySensitiveAction.mockReset().mockResolvedValue(operator);
    sessions.createSession.mockReset().mockResolvedValue('550e8400-e29b-41d4-a716-446655440012');
    auth.beginVerifiedLogin.mockReset().mockResolvedValue({ totpSessionId: '550e8400-e29b-41d4-a716-446655440013' });
    users.getUserById.mockReset().mockResolvedValue(operator);
    sessions.destroyAllSessionsByUserId.mockReset().mockResolvedValue(undefined);
    sessions.isSessionForUser.mockReturnValue(true);
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        PasskeyService,
        PasskeyStore,
        AuthGuard,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: AuthService, useValue: auth },
        { provide: ConfigurationService, useValue: config },
        { provide: UserRepository, useValue: users },
        { provide: SessionManager, useValue: sessions },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: CacheService, useValue: mock<CacheService>() },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('/api');
    app.use(cookieParser());
    app.use((req: Record<string, unknown> & { cookies: Record<string, string>; headers: Record<string, string> }, _: unknown, next: () => void) => {
      if (req.cookies['runtipi-sid'] === 'browser-session') {
        req.user = { id: 41 };
        req.authMethod = 'session';
      } else if (req.headers.authorization === 'fixture-cli') {
        req.user = { id: 41 };
        req.authMethod = 'cli';
      }
      next();
    });
    await app.listen(0, '127.0.0.1');
  });
  afterEach(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('protects all management routes with browser sessions and same-origin guards', async () => {
    expect((await post('/register/options').send({ password: 'test', name: 'Key' })).status).toBe(401);
    expect((await post('/register/options').set('Authorization', 'fixture-cli').send({ password: 'test', name: 'Key' })).status).toBe(401);
    expect(
      (await post('/register/options').set('Cookie', session).set('Origin', 'https://evil.test').send({ password: 'test', name: 'Key' })).status,
    ).toBe(403);
    expect((await post('/remove').set('Cookie', session).set('Origin', 'https://evil.test').send({ id: 'none', password: 'test' })).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/api/auth/passkeys')).status).toBe(401);
    expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  });
  it('uses a secure HttpOnly single-use ceremony cookie and reuses normal session cookie login', async () => {
    const key = passkeyAuthenticator();
    const begin = await post('/register/options').set('Cookie', session).send({ password: 'fresh', name: 'Laptop' });
    expect(begin.status).toBe(201);
    expect(begin.body.options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(
      (
        await post('/register/verify')
          .set('Cookie', session)
          .send({ response: key.register(begin.body.options.challenge) })
      ).status,
    ).toBe(201);
    const options = await post('/login/options').send({});
    const cookies = options.headers['set-cookie'] as unknown as string[];
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('Secure');
    expect(cookies[0]).toContain('SameSite=Strict');
    expect(cookies[0]).toContain('Path=/api/auth/passkeys');
    expect(cookies[0]).toContain('Max-Age=300');
    const assertion = key.authenticate(options.body.options.challenge, begin.body.options.user.id);
    const finish = await post('/login/verify')
      .set('Cookie', cookies[0]?.split(';')[0] ?? '')
      .set('X-Forwarded-Proto', 'https')
      .send({ response: assertion });
    expect(finish.status).toBe(201);
    expect(finish.body).toEqual({ success: true });
    expect(sessions.createSession).toHaveBeenCalledWith(41);
    expect(
      (finish.headers['set-cookie'] as unknown as string[]).some(
        (cookie) => cookie.includes('runtipi-sid=550e8400-e29b-41d4-a716-446655440012') && cookie.includes('HttpOnly') && cookie.includes('Secure'),
      ),
    ).toBe(true);
    expect(
      (
        await post('/login/verify')
          .set('Cookie', cookies[0]?.split(';')[0] ?? '')
          .send({ response: assertion })
      ).status,
    ).toBe(400);
    const listed = await request(app.getHttpServer()).get('/api/auth/passkeys').set('Host', 'orbis.example.test').set('Cookie', session);
    expect(listed.body.credentials[0]).toEqual({ id: key.id, name: 'Laptop', createdAt: expect.any(Number), lastUsedAt: expect.any(Number) });
    expect(JSON.stringify(listed.body)).not.toContain('publicKey');
  });
  it('returns a full passkey session for a TOTP-enabled account and keeps TOTP proof for removal', async () => {
    const protectedAccount = { ...operator, totpEnabled: true, totpSecret: 'retained-secret', salt: 'retained-salt' };
    users.getUserById.mockResolvedValue(protectedAccount);
    auth.verifySensitiveAction.mockResolvedValue(protectedAccount);
    const key = passkeyAuthenticator();
    const begin = await post('/register/options').set('Cookie', session).send({ password: 'fresh', totpCode: '123456', name: 'Key' });
    await post('/register/verify')
      .set('Cookie', session)
      .send({ response: key.register(begin.body.options.challenge) });
    const options = await post('/login/options').send({});
    const cookie = (options.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0] ?? '';
    const finish = await post('/login/verify')
      .set('Cookie', cookie)
      .send({ response: key.authenticate(options.body.options.challenge, begin.body.options.user.id) });
    expect(finish.body).toEqual({ success: true });
    expect(
      (finish.headers['set-cookie'] as unknown as string[]).some((value) => value.startsWith('runtipi-sid=550e8400-e29b-41d4-a716-446655440012')),
    ).toBe(true);
    expect((await post('/remove').set('Cookie', session).send({ id: key.id, password: 'fresh', totpCode: '123456' })).status).toBe(201);
    expect(auth.verifySensitiveAction).toHaveBeenLastCalledWith(41, 'fresh', '123456');
    expect(sessions.destroyAllSessionsByUserId).toHaveBeenCalledWith(41);
  });
  it('changes optional extra verification only through authenticated explicit policy opt-in, without revoking the current session', async () => {
    const policyRequest = () =>
      request(app.getHttpServer())
        .put('/api/auth/passkeys/policy')
        .set('Host', 'orbis.example.test')
        .set('Origin', origin)
        .set('X-Forwarded-Proto', 'https');
    expect((await policyRequest().send({ requireTotpAfterPasskey: true, password: 'fresh' })).status).toBe(401);
    expect(
      (await policyRequest().set('Cookie', session).set('Origin', 'https://evil.test').send({ requireTotpAfterPasskey: true, password: 'fresh' }))
        .status,
    ).toBe(403);
    const protectedAccount = { ...operator, totpEnabled: true, totpSecret: 'retained-secret', salt: 'retained-salt' };
    users.getUserById.mockResolvedValue(protectedAccount);
    auth.verifySensitiveAction.mockResolvedValue(protectedAccount);
    const key = passkeyAuthenticator();
    const begin = await post('/register/options').set('Cookie', session).send({ password: 'fresh', totpCode: '123456', name: 'Key' });
    await post('/register/verify')
      .set('Cookie', session)
      .send({ response: key.register(begin.body.options.challenge) });
    const initial = await request(app.getHttpServer()).get('/api/auth/passkeys/policy').set('Host', 'orbis.example.test').set('Cookie', session);
    expect(initial.body).toEqual({ requireTotpAfterPasskey: false, totpEnabled: true });
    const saved = await policyRequest().set('Cookie', session).send({ requireTotpAfterPasskey: true, password: 'fresh', totpCode: '123456' });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ requireTotpAfterPasskey: true, totpEnabled: true });
    const options = await post('/login/options').send({});
    const cookie = (options.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0] ?? '';
    const finish = await post('/login/verify')
      .set('Cookie', cookie)
      .send({ response: key.authenticate(options.body.options.challenge, begin.body.options.user.id) });
    expect(finish.body).toEqual({ success: true, totpSessionId: '550e8400-e29b-41d4-a716-446655440013' });
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(sessions.destroyAllSessionsByUserId).not.toHaveBeenCalled();
    const listed = await request(app.getHttpServer()).get('/api/auth/passkeys').set('Host', 'orbis.example.test').set('Cookie', session);
    expect(listed.body.policy).toEqual({ requireTotpAfterPasskey: true, totpEnabled: true });
  });
  it('rejects forged origin/proxy options and throttles anonymous ceremony issuance before creating more challenges', async () => {
    expect((await post('/login/options').set('Origin', 'https://evil.test').set('X-Forwarded-Host', 'orbis.example.test').send({})).status).toBe(403);
    for (let i = 0; i < 19; i++) expect((await post('/login/options').send({})).status).toBe(201);
    expect((await post('/login/options').send({})).status).toBe(429);
  });
});
