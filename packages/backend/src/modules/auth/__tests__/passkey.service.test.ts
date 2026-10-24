import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { CacheService } from '@/core/cache/cache.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { PasswordService } from '@/core/password/password.service';
import { UserRepository } from '@/modules/user/user.repository';
import { AuthService } from '../auth.service';
import { PasskeyStore } from '../passkey.store';
import { PasskeyService, PASSKEY_COOKIE, PASSKEY_TTL } from '../passkey.service';
import { SessionManager } from '../session.manager';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { TotpAuthenticator } from '../utils/totp-authenticator';
import { passkeyAuthenticator } from './passkey.fixture';

describe('audited WebAuthn passkey ceremonies', () => {
  let directory: string;
  let store: PasskeyStore;
  let service: PasskeyService;
  let auth: AuthService;
  const config = mock<ConfigurationService>();
  const users = mock<UserRepository>();
  const password = mock<PasswordService>();
  const encryption = mock<EncryptionService>();
  const cache = mock<CacheService>();
  const sessions = new SessionManager(cache);
  const values = new Map<string, string>();
  let user: {
    id: number;
    username: string;
    password: string;
    createdAt: number;
    updatedAt: number;
    totpEnabled: boolean;
    totpSecret: string | null;
    salt: string | null;
    locale: string;
    operator: boolean;
    hasSeenWelcome: boolean;
  };
  const request = (origin = 'https://orbis.example.test', session = 'browser-session') =>
    ({
      headers: { origin, host: new URL(origin).host },
      socket: { remoteAddress: '127.0.0.1' },
      cookies: { [SESSION_COOKIE_NAME]: session },
      authMethod: 'session',
      user: { id: 41 },
    }) as unknown as Request;
  const enroll = async (authenticator = passkeyAuthenticator()) => {
    const { options } = await service.registrationOptions(request(), {
      password: 'fixture-password',
      name: 'Personal key',
      ...(user.totpEnabled ? { totpCode: TotpAuthenticator.generate('JBSWY3DPEHPK3PXP') } : {}),
    });
    await service.verifyRegistration(request(), { response: authenticator.register(options.challenge) });
    return { authenticator, handle: options.user.id };
  };
  const login = async () => {
    const { id, options } = await service.loginOptions(request(), {});
    const req = request();
    req.cookies = { [PASSKEY_COOKIE]: id };
    return { req, options };
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-passkey-test-'));
    user = {
      id: 41,
      username: 'operator@example.test',
      password: 'retained-hash',
      createdAt: 1,
      updatedAt: 1,
      totpEnabled: false,
      totpSecret: null,
      salt: null,
      locale: 'en',
      operator: true,
      hasSeenWelcome: true,
    };
    config.get
      .mockReset()
      .mockImplementation(
        (key: string) =>
          (key === 'directories'
            ? { dataDir: directory }
            : key === 'userSettings'
              ? { domain: 'orbis.example.test', localDomain: 'orbis.local', sslPort: 443 }
              : false) as never,
      );
    users.getUserById.mockReset().mockImplementation(async (id) => (id === user.id ? { ...user } : undefined));
    users.getUserByUsername.mockReset();
    users.updateUser.mockReset().mockImplementation(async (_id, patch) => {
      Object.assign(user, patch);
      return { ...user };
    });
    password.verify.mockReset().mockImplementation(async (value) => value === 'fixture-password');
    encryption.decrypt.mockReturnValue('JBSWY3DPEHPK3PXP');
    values.clear();
    values.set('session:browser-session', '41');
    cache.set.mockImplementation((key, value) => {
      values.set(key, value);
    });
    cache.get.mockImplementation((key) => values.get(key));
    cache.del.mockImplementation((key) => {
      values.delete(key);
    });
    cache.getByPrefix.mockImplementation(async (prefix) => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, val]) => ({ key, val })));
    store = new PasskeyStore(config);
    auth = new AuthService(users, sessions, config, encryption, cache, mock<FilesystemService>(), password, store);
    service = new PasskeyService(config, store, auth, users, sessions);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('enrolls and verifies a real signed P256 assertion, persists a counter and creates normal sessions', async () => {
    const { authenticator, handle } = await enroll();
    const { req, options } = await login();
    const result = await service.verifyLogin(req, { response: authenticator.authenticate(options.challenge, handle) });
    expect(result.sessionId).toEqual(expect.any(String));
    expect(cache.get(`session:${result.sessionId}`)).toBe('41');
    expect((await service.list(request())).credentials).toEqual([
      expect.objectContaining({ id: authenticator.id, name: 'Personal key', lastUsedAt: expect.any(Number) }),
    ]);
    expect((await fs.stat(path.join(directory, 'state/auth/passkeys.json'))).mode & 0o077).toBe(0);
    expect((await store.snapshot()).users[41]?.credentials[0]?.counter).toBe(1);
    await expect(service.verifyLogin(req, { response: authenticator.authenticate(options.challenge, handle, 2) })).rejects.toThrow();
  });
  it('rejects wrong challenge, RP, origin, userhandle, signature, missing UV and repeated counters', async () => {
    const { authenticator, handle } = await enroll();
    for (const variant of ['challenge', 'rp', 'origin', 'handle', 'signature', 'uv'] as const) {
      const { req, options } = await login();
      const response = authenticator.authenticate(
        variant === 'challenge' ? 'wrong' : options.challenge,
        variant === 'handle' ? 'wrong' : handle,
        1,
        variant === 'origin' ? 'https://evil.test' : undefined,
        variant === 'rp' ? 'evil.test' : undefined,
        variant !== 'uv',
      );
      if (variant === 'signature') response.response.signature = Buffer.alloc(70).toString('base64url');
      await expect(service.verifyLogin(req, { response })).rejects.toThrow();
    }
    const first = await login();
    await service.verifyLogin(first.req, { response: authenticator.authenticate(first.options.challenge, handle) });
    const duplicate = await login();
    await expect(service.verifyLogin(duplicate.req, { response: authenticator.authenticate(duplicate.options.challenge, handle) })).rejects.toThrow();
  });
  it('binds registration to its authenticated session, consumes failed challenges, requires UV, and expires ceremonies', async () => {
    const key = passkeyAuthenticator();
    const { options } = await service.registrationOptions(request(), { password: 'fixture-password', name: 'A key' });
    await expect(service.verifyRegistration(request(undefined, 'another-session'), { response: key.register(options.challenge) })).rejects.toThrow();
    await expect(service.verifyRegistration(request(), { response: key.register(options.challenge, undefined, undefined, false) })).rejects.toThrow();
    await expect(service.verifyRegistration(request(), { response: key.register(options.challenge) })).rejects.toThrow();
    const next = await service.registrationOptions(request(), { password: 'fixture-password', name: 'A key' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PASSKEY_TTL + 1);
    await expect(service.verifyRegistration(request(), { response: key.register(next.options.challenge) })).rejects.toThrow();
  });
  it('signs in directly with a verified passkey while password sign-in and management retain account TOTP', async () => {
    user.totpEnabled = true;
    user.totpSecret = 'retained-encrypted';
    user.salt = 'retained-salt';
    await expect(service.registrationOptions(request(), { password: 'wrong', name: 'A key' })).rejects.toThrow();
    await expect(service.registrationOptions(request(), { password: 'fixture-password', name: 'A key' })).rejects.toThrow();
    const { authenticator, handle } = await enroll();
    const { req, options } = await login();
    const result = await service.verifyLogin(req, { response: authenticator.authenticate(options.challenge, handle) });
    expect(result).toEqual({ sessionId: expect.any(String) });
    expect(values.get(`session:${result.sessionId}`)).toBe('41');
    expect([...values.keys()].some((key) => key.startsWith('totp-by-user:'))).toBe(false);
    const sessionsBeforePassword = [...values.keys()].filter((key) => key.startsWith('session:41:')).length;
    users.getUserByUsername.mockResolvedValue({ ...user });
    const passwordResult = await auth.login({ username: user.username, password: 'fixture-password' });
    expect(passwordResult).toEqual({ totpSessionId: expect.any(String) });
    expect([...values.keys()].filter((key) => key.startsWith('session:41:'))).toHaveLength(sessionsBeforePassword);
    expect(
      await auth.verifyTotp({ totpSessionId: passwordResult.totpSessionId ?? '', totpCode: TotpAuthenticator.generate('JBSWY3DPEHPK3PXP') }),
    ).toEqual({
      sessionId: expect.any(String),
    });
    expect([...values.keys()].filter((key) => key.startsWith('session:41:'))).toHaveLength(sessionsBeforePassword + 1);
    await expect(service.remove(request(), { id: authenticator.id, password: 'fixture-password' })).rejects.toThrow();
  });

  it('requires explicit fresh-password and TOTP opt-in before adding a TOTP step to passkey sign-in', async () => {
    const { authenticator, handle } = await enroll();
    expect(await service.readPolicy(request())).toEqual({ requireTotpAfterPasskey: false, totpEnabled: false });
    await expect(service.updatePolicy(request(), { requireTotpAfterPasskey: true, password: 'fixture-password' })).rejects.toThrow(
      'Enable authenticator codes',
    );
    user.totpEnabled = true;
    user.totpSecret = 'retained-encrypted';
    user.salt = 'retained-salt';
    await expect(service.updatePolicy(request(), { requireTotpAfterPasskey: true, password: 'fixture-password' })).rejects.toThrow();
    const body = { requireTotpAfterPasskey: true, password: 'fixture-password', totpCode: TotpAuthenticator.generate('JBSWY3DPEHPK3PXP') };
    expect(await service.updatePolicy(request(), body)).toEqual({ requireTotpAfterPasskey: true, totpEnabled: true });
    expect(await service.list(request())).toMatchObject({ policy: { requireTotpAfterPasskey: true, totpEnabled: true } });
    const { req, options } = await login();
    const result = await service.verifyLogin(req, { response: authenticator.authenticate(options.challenge, handle) });
    expect(result).toEqual({ totpSessionId: expect.any(String) });
    expect([...values.keys()].filter((key) => key.startsWith('session:41:'))).toHaveLength(0);
    expect(await auth.verifyTotp({ totpSessionId: result.totpSessionId ?? '', totpCode: body.totpCode })).toEqual({ sessionId: expect.any(String) });
    expect(await service.updatePolicy(request(), { ...body, requireTotpAfterPasskey: false })).toEqual({
      requireTotpAfterPasskey: false,
      totpEnabled: true,
    });
    const direct = await login();
    expect(await service.verifyLogin(direct.req, { response: authenticator.authenticate(direct.options.challenge, handle, 2) })).toEqual({
      sessionId: expect.any(String),
    });
  });

  it('persists the explicit opt-in, binds it to current TOTP enrollment, and clears it before TOTP disable or recovery', async () => {
    user.totpEnabled = true;
    user.totpSecret = 'retained-encrypted';
    user.salt = 'retained-salt';
    await enroll();
    const body = { requireTotpAfterPasskey: true, password: 'fixture-password', totpCode: TotpAuthenticator.generate('JBSWY3DPEHPK3PXP') };
    await service.updatePolicy(request(), body);
    store = new PasskeyStore(config);
    auth = new AuthService(users, sessions, config, encryption, cache, mock<FilesystemService>(), password, store);
    service = new PasskeyService(config, store, auth, users, sessions);
    expect((await service.readPolicy(request())).requireTotpAfterPasskey).toBe(true);
    user.totpSecret = 'new-encrypted-secret';
    expect((await service.readPolicy(request())).requireTotpAfterPasskey).toBe(false);
    user.totpSecret = 'retained-encrypted';
    users.updateUser.mockImplementationOnce(async (_id, patch) => {
      expect((await store.snapshot()).users[41]?.totpAfterPasskey).toBeUndefined();
      Object.assign(user, patch);
      return { ...user };
    });
    await auth.disableTotp({ userId: 41, password: 'fixture-password' });
    expect(await service.readPolicy(request())).toEqual({ requireTotpAfterPasskey: false, totpEnabled: false });
    user.totpEnabled = true;
    user.totpSecret = 'retained-encrypted';
    expect((await service.readPolicy(request())).requireTotpAfterPasskey).toBe(false);
    await service.updatePolicy(request(), body);
    await store.removeAll(41);
    expect((await store.snapshot()).users[41]?.totpAfterPasskey).toBeUndefined();
    expect((await service.readPolicy(request())).requireTotpAfterPasskey).toBe(false);
  });

  it.each(['password', 'session'])('rechecks the %s after fresh proof before saving an optional second verification', async (changed) => {
    user.totpEnabled = true;
    user.totpSecret = 'retained-encrypted';
    user.salt = 'retained-salt';
    await enroll();
    password.verify.mockImplementationOnce(async () => {
      if (changed === 'password') user.password = 'replacement-hash';
      else values.delete('session:browser-session');
      return true;
    });
    await expect(
      service.updatePolicy(request(), {
        requireTotpAfterPasskey: true,
        password: 'fixture-password',
        totpCode: TotpAuthenticator.generate('JBSWY3DPEHPK3PXP'),
      }),
    ).rejects.toThrow();
    expect((await store.snapshot()).users[41]?.totpAfterPasskey).toBeUndefined();
  });
  it('removes a key before revoking all its account sessions, remains retryable, and invalidates pending assertions', async () => {
    const { authenticator, handle } = await enroll();
    const old = await sessions.createSession(user.id);
    const other = await sessions.createSession(user.id + 1);
    const pending = await login();
    cache.getByPrefix.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(service.remove(request(), { id: authenticator.id, password: 'fixture-password' })).rejects.toThrow();
    expect((await store.snapshot()).users[41]?.credentials).toEqual([]);
    await expect(service.verifyLogin(pending.req, { response: authenticator.authenticate(pending.options.challenge, handle) })).rejects.toThrow();
    await service.remove(request(), { id: authenticator.id, password: 'fixture-password' });
    expect(cache.get(`session:${old}`)).toBeUndefined();
    expect(cache.get(`session:${other}`)).toBe('42');
  });

  it('keeps direct passkey session creation serialized so queued key removal revokes the new session', async () => {
    const { authenticator, handle } = await enroll();
    const { req, options } = await login();
    const changes = vi.spyOn(store, 'change');
    const createSession = sessions.createSession.bind(sessions);
    let releaseSession!: () => void;
    let creating = false;
    const release = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    vi.spyOn(sessions, 'createSession').mockImplementationOnce(async (userId) => {
      creating = true;
      await release;
      return createSession(userId);
    });
    const signingIn = service.verifyLogin(req, { response: authenticator.authenticate(options.challenge, handle) });
    await vi.waitFor(() => expect(creating).toBe(true));
    let removed = false;
    const removing = service.remove(request(), { id: authenticator.id, password: 'fixture-password' }).then(() => {
      removed = true;
    });
    await vi.waitFor(() => expect(changes).toHaveBeenCalledTimes(2));
    expect(removed).toBe(false);
    releaseSession();
    const result = await signingIn;
    await removing;
    expect(cache.get(`session:${result.sessionId}`)).toBeUndefined();
    expect((await store.snapshot()).users[41]?.credentials).toEqual([]);
  });

  it.each(['password', 'passkey'])('revokes pending %s TOTP grants and an already-verifying grant when a key is removed', async (method) => {
    user.totpEnabled = true;
    user.totpSecret = 'retained-encrypted';
    user.salt = 'retained-salt';
    const { authenticator, handle } = await enroll();
    users.getUserByUsername.mockResolvedValue({ ...user });
    let result: Awaited<ReturnType<AuthService['login']>>;
    if (method === 'password') result = await auth.login({ username: user.username, password: 'fixture-password' });
    else {
      await service.updatePolicy(request(), {
        requireTotpAfterPasskey: true,
        password: 'fixture-password',
        totpCode: TotpAuthenticator.generate('JBSWY3DPEHPK3PXP'),
      });
      const { req, options } = await login();
      result = await service.verifyLogin(req, { response: authenticator.authenticate(options.challenge, handle) });
    }
    expect(result).toEqual({ totpSessionId: expect.any(String) });
    let releaseUser!: (value: typeof user) => void;
    users.getUserById.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUser = resolve;
        }),
    );
    const verification = auth.verifyTotp({ totpSessionId: result.totpSessionId ?? '', totpCode: TotpAuthenticator.generate('JBSWY3DPEHPK3PXP') });
    await vi.waitFor(() => expect(releaseUser).toEqual(expect.any(Function)));
    await service.remove(request(), { id: authenticator.id, password: 'fixture-password', totpCode: TotpAuthenticator.generate('JBSWY3DPEHPK3PXP') });
    releaseUser({ ...user });
    await expect(verification).rejects.toThrow();
    expect(values.has(result.totpSessionId ?? '')).toBe(false);
    expect([...values.keys()].some((key) => key.startsWith('session:41:'))).toBe(false);
  });

  it.each(['password', 'session'])('rejects an enrollment whose %s changed while cryptographic verification was in flight', async (changed) => {
    const key = passkeyAuthenticator();
    const { options } = await service.registrationOptions(request(), { password: 'fixture-password', name: 'A key' });
    users.getUserById.mockImplementationOnce(async () => {
      const before = { ...user };
      queueMicrotask(() => {
        if (changed === 'password') user.password = 'replacement-password-hash';
        else values.delete('session:browser-session');
      });
      return before;
    });
    await expect(service.verifyRegistration(request(), { response: key.register(options.challenge) })).rejects.toThrow();
    expect((await store.snapshot()).users[41]?.credentials).toEqual([]);
  });

  it('rechecks the authenticated session after an awaited removal password proof', async () => {
    const { authenticator } = await enroll();
    let finishProof!: (valid: boolean) => void;
    password.verify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProof = resolve;
        }),
    );
    const removal = service.remove(request(), { id: authenticator.id, password: 'fixture-password' });
    await vi.waitFor(() => expect(finishProof).toEqual(expect.any(Function)));
    values.delete('session:browser-session');
    finishProof(true);
    await expect(removal).rejects.toThrow('Sign in again');
    expect((await store.snapshot()).users[41]?.credentials).toHaveLength(1);
  });

  it('rejects a symlinked storage parent and bounds concurrent outstanding ceremonies', async () => {
    await enroll();
    const directoryAuth = path.join(directory, 'state/auth');
    await fs.rename(directoryAuth, `${directoryAuth}-moved`);
    await fs.symlink(`${directoryAuth}-moved`, directoryAuth);
    await expect(new PasskeyStore(config).snapshot()).rejects.toThrow();
    await fs.unlink(directoryAuth);
    await fs.rename(`${directoryAuth}-moved`, directoryAuth);
    for (let index = 0; index < 256; index++) await service.loginOptions(request(), {});
    await expect(service.loginOptions(request(), {})).rejects.toThrow('Too many passkey requests');
    const concurrent = new PasskeyService(config, store, auth, users, sessions);
    const issued = await Promise.allSettled(Array.from({ length: 270 }, () => concurrent.loginOptions(request(), {})));
    expect(issued.filter((result) => result.status === 'fulfilled')).toHaveLength(256);
    expect(issued.filter((result) => result.status === 'rejected')).toHaveLength(14);
    const remote = request('http://localhost:3000');
    Object.assign(remote.socket, { remoteAddress: '192.0.2.4' });
    await expect(service.loginOptions(remote, {})).rejects.toThrow();
  });
  it('fails closed on demo, forged forwarded origins, IP origins, unsupported hosts, malformed options and unsafe storage', async () => {
    for (const origin of ['http://orbis.example.test', 'https://192.168.0.10', 'https://evil.test', 'https://orbis.example.test.evil.test']) {
      const req = request(origin);
      req.headers['x-forwarded-host'] = 'orbis.example.test';
      req.headers['x-forwarded-proto'] = 'https';
      await expect(service.loginOptions(req, {})).rejects.toThrow();
    }
    expect(service.availability(request('http://localhost:3000')).available).toBe(true);
    await expect(service.loginOptions(request(), { origin: 'https://evil.test' })).rejects.toThrow();
    await enroll();
    await fs.chmod(path.join(directory, 'state/auth/passkeys.json'), 0o644);
    store = new PasskeyStore(config);
    service = new PasskeyService(config, store, auth, users, sessions);
    await expect(service.loginOptions(request(), {})).rejects.toThrow();
    expect((await service.list(request())).available).toBe(false);
    config.get.mockImplementation(
      (key: string) =>
        (key === 'demoMode' ? true : key === 'userSettings' ? { domain: 'orbis.example.test', sslPort: 443 } : { dataDir: directory }) as never,
    );
    await expect(service.loginOptions(request(), {})).rejects.toThrow();
  });
});
