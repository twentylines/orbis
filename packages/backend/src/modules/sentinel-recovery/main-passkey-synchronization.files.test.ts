import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { hash } from 'argon2';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { Request } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Database } from '@/core/database/database.module';
import type { User } from '@/core/database/drizzle/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { UserRepository } from '../user/user.repository';
import { PasskeyStore } from '../auth/passkey.store';
import { PasskeyService, PASSKEY_COOKIE } from '../auth/passkey.service';
import { AuthService } from '../auth/auth.service';
import { SessionManager } from '../auth/session.manager';
import { passkeyAuthenticator } from '../auth/__tests__/passkey.fixture';
import { sensitiveAccountBinding } from '../auth/sensitive-action-context';
import { MainPasskeySynchronization, MainPasskeySynchronizationError } from './main-passkey-synchronization.service';
import { buildRecoveryIdentitySource } from './source';
import { verifyRecoveryPasskeyCounter } from './authentication';
import { describeRecoveryEffectiveIdentityContent, readRecoveryIdentity } from './identity';

const origin = 'https://orbis.example.test';
const rpID = 'orbis.example.test';
const binding = 'a'.repeat(64);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let passwordHash: string;
let directory: string;
let server: http.Server;
let config: ConfigurationService;
let encryption: EncryptionService;
let account: User;
let store: PasskeyStore;
let users: UserRepository;
let service: PasskeyService;
let sync: MainPasskeySynchronization;
let auth: ReturnType<typeof mock<AuthService>>;
let sessions: ReturnType<typeof mock<SessionManager>>;
let key: ReturnType<typeof passkeyAuthenticator>;
let profile: Buffer;
let events: string[];
let sqlActive: boolean;
let commitFailure: boolean;
let fixtureFailure: unknown;
let host: {
  mode: 'managed' | 'unmanaged' | 'unknown';
  floor: number;
  calls: string[];
  status: number;
  binding: string;
  drop: boolean;
  crossed: boolean;
  purpose?: string;
  omitFloor: boolean;
  privateDrift: boolean;
};
const nonces = new Map<string, { purpose: string; ceremonyBinding: string; expiresAtMs: number }>();
const request = (id?: string) =>
  ({
    headers: { origin, host: rpID },
    socket: { remoteAddress: '127.0.0.1' },
    cookies: { [SESSION_COOKIE_NAME]: 'browser', ...(id ? { [PASSKEY_COOKIE]: id } : {}) },
    authMethod: 'session',
    user: { id: 41, operator: true },
  }) as unknown as Request;
const disk = async () => JSON.parse(await fs.readFile(path.join(directory, 'state/auth/passkeys.json'), 'utf8'));

/** Actual UserRepository lock order; SQL transport is a controlled fixture.
 * Installed/PostgreSQL/Root-Python acceptance is deliberately separate.
 */
function database() {
  const query = { user: { findFirst: async () => structuredClone(account) } };
  const select = () => {
    const value = Object.assign(
      Promise.resolve().then(() => (account.operator ? [structuredClone(account)] : [])),
      {
        from: () => value,
        where: () => value,
      },
    );
    return value;
  };
  return {
    query,
    select,
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      events.push('sql-open');
      sqlActive = true;
      try {
        const value = await work({
          query,
          select,
          execute: async () => {
            events.push('sql-lock');
          },
        });
        if (commitFailure) throw new Error('Synthetic SQL commit reply unavailable');
        events.push('sql-commit');
        return value;
      } finally {
        sqlActive = false;
      }
    },
  } as unknown as Database;
}

beforeAll(async () => {
  passwordHash = await hash('synthetic-counter-password', { memoryCost: 4096, timeCost: 2, parallelism: 1 });
});
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required.');
  directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'mc-')));
  events = [];
  sqlActive = false;
  commitFailure = false;
  fixtureFailure = undefined;
  nonces.clear();
  account = {
    id: 41,
    username: 'operator',
    password: passwordHash,
    operator: true,
    totpEnabled: false,
    totpSecret: null,
    salt: null,
    createdAt: 1,
    updatedAt: 1,
    locale: 'en',
    hasSeenWelcome: true,
  };
  config = {
    get: vi.fn((name: string) =>
      name === 'directories'
        ? { dataDir: directory }
        : name === 'demoMode'
          ? false
          : name === 'userSettings'
            ? { domain: rpID, sslPort: 443 }
            : 'synthetic-context',
    ),
  } as unknown as ConfigurationService;
  encryption = mock<EncryptionService>();
  store = new PasskeyStore(config);
  users = new UserRepository(database());
  key = passkeyAuthenticator();
  const challenge = randomBytes(32).toString('base64url');
  const registered = await verifyRegistrationResponse({
    response: key.register(challenge),
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!registered.verified || !registered.registrationInfo) throw new Error('Synthetic authentic key enrollment failed');
  const registeredCredential = registered.registrationInfo.credential;
  await store.change((state) => {
    state.users[41] = {
      handle: 'aGFuZGxl',
      credentials: [
        {
          id: key.id,
          publicKey: Buffer.from(registeredCredential.publicKey).toString('base64url'),
          counter: 0,
          name: 'Genuine test key',
          rpID,
          createdAt: 1,
          lastUsedAt: null,
          transports: ['internal'],
        },
      ],
    };
  });
  profile = buildRecoveryIdentitySource(account, await store.snapshot(), origin, encryption).bytes;
  host = { mode: 'managed', floor: 0, calls: [], status: 200, binding, drop: false, crossed: false, omitFloor: false, privateDrift: false };
  server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const endpoint = req.url?.split('/').at(-1) ?? '';
      host.calls.push(endpoint);
      events.push(endpoint);
      const reply = (value: unknown, status = host.status) => {
        const bytes = Buffer.from(JSON.stringify(value));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, Connection: 'close' });
        res.end(bytes);
      };
      if (host.status !== 200) return reply({});
      if (endpoint === 'admission') return reply({ mode: host.mode, binding: host.binding });
      if (body.admissionBinding !== host.binding) return reply({}, 503);
      if (endpoint === 'counter-challenge') {
        if (host.mode === 'unmanaged') return reply({ mode: 'unmanaged', admissionBinding: host.binding });
        const challenge = randomBytes(32).toString('base64url');
        const expiresAtMs = Date.now() + 120000;
        nonces.set(challenge, { purpose: body.purpose, ceremonyBinding: body.ceremonyBinding, expiresAtMs });
        host.purpose = body.purpose;
        return reply({
          schema: 'orbis.sentinel-main-passkey-challenge.v1',
          mode: 'managed',
          admissionBinding: host.binding,
          challenge,
          expiresAtMs,
          generation: 1,
          revision: 'c'.repeat(64),
          accountId: 41,
          rpID,
          credentialIds: [key.id],
        });
      }
      if (endpoint === 'counter-complete') {
        expect(sqlActive).toBe(true);
        expect(events.slice(events.lastIndexOf('sql-open')).filter((event) => event === 'sql-lock')).toHaveLength(2);
        const nonce = nonces.get(body.challenge);
        nonces.delete(body.challenge);
        if (!nonce || nonce.purpose !== body.purpose || nonce.ceremonyBinding !== body.ceremonyBinding) return reply({}, 503);
        const checked = await verifyRecoveryPasskeyCounter({
          identityBytes: profile,
          expectedIdentitySha256: digest(profile),
          challenge: body.challenge,
          request: { response: body.response },
        });
        if (!checked.verified || ((host.floor !== 0 || checked.credential.newCounter !== 0) && checked.credential.newCounter <= host.floor))
          return reply({}, 503);
        const previousCounter = host.floor;
        host.floor = checked.credential.newCounter;
        expect((await disk()).users[41].credentials[0].counter).toBeLessThanOrEqual(host.floor);
        if (host.drop) {
          res.destroy();
          return;
        }
        return reply({
          schema: 'orbis.sentinel-main-passkey-counter.v1',
          admissionBinding: host.binding,
          challenge: body.challenge,
          generation: 1,
          revision: 'c'.repeat(64),
          accountId: 41,
          credentialId: key.id,
          previousCounter,
          newCounter: host.crossed ? host.floor + 1 : host.floor,
          expiresAtMs: nonce.expiresAtMs,
        });
      }
      if (endpoint === 'counter-floors') {
        expect(sqlActive).toBe(true);
        expect(events).toContain('authorize');
        const source = Buffer.from(body.identityBase64, 'base64');
        const identity = readRecoveryIdentity(source, digest(source));
        if (host.privateDrift || identity.credentials.some((item) => item.counter > host.floor)) return reply({}, 503);
        const counters = host.omitFloor ? {} : { [key.id]: host.floor };
        if (!host.omitFloor) {
          const left = describeRecoveryEffectiveIdentityContent(source, digest(source), { [key.id]: host.floor });
          const right = describeRecoveryEffectiveIdentityContent(profile, digest(profile), { [key.id]: host.floor });
          if (left.contentSha256 !== right.contentSha256) return reply({}, 503);
        }
        return reply({
          schema: 'orbis.sentinel-main-counter-floors.v1',
          admissionBinding: host.binding,
          sourceSha256: digest(source),
          generation: 1,
          revision: 'c'.repeat(64),
          counters,
        });
      }
      reply({}, 503);
    } catch (error) {
      const bytes = Buffer.from(JSON.stringify({ error: 'Synthetic fixture refusal' }));
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, Connection: 'close' });
      res.end(bytes);
      fixtureFailure = error;
    }
  });
  const socket = path.join(directory, 's');
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await fs.chmod(socket, 0o600);
  vi.stubEnv('ORBIS_HOST_SOCKET', socket);
  vi.stubEnv('ORBIS_SENTINEL_RECOVERY_ORIGIN', origin);
  auth = mock<AuthService>();
  sessions = mock<SessionManager>();
  sessions.isSessionForUser.mockReturnValue(true);
  sessions.createSession.mockImplementation(async () => {
    expect(sqlActive).toBe(false);
    expect(events).toContain('sql-commit');
    events.push('session');
    return '550e8400-e29b-41d4-a716-446655440001';
  });
  auth.beginVerifiedLogin.mockImplementation(async () => {
    expect(sqlActive).toBe(false);
    events.push('totp-pending');
    return { totpSessionId: '550e8400-e29b-41d4-a716-446655440002' };
  });
  auth.operatorActionContext.mockImplementation(async () => ({
    userId: 41,
    sessionBinding: digest(Buffer.from('browser')),
    securityBinding: sensitiveAccountBinding(account, await store.snapshot()),
  }));
  sync = new MainPasskeySynchronization(users, store, config, encryption);
  service = new PasskeyService(config, store, auth, users, sessions, undefined, sync);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  profile?.fill(0);
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => resolve());
  });
  await fs.rm(directory, { recursive: true, force: true });
  if (fixtureFailure) throw fixtureFailure;
});
const login = async (count = 1) => {
  const begin = await service.loginOptions(request(), {});
  return { begin, req: request(begin.id), response: key.authenticate(begin.options.challenge, 'aGFuZGxl', count) };
};
const authorize = async () => {
  expect(sqlActive).toBe(true);
  events.push('authorize');
};

describe('Main passkey counter synchronization with genuine ES256 and actual Unix HTTP', () => {
  it('uses Root nonce and ACK before durable file, resolved SQL and Main session', async () => {
    const { begin, req, response } = await login();
    expect(nonces.has(begin.options.challenge)).toBe(true);
    await expect(service.verifyLogin(req, { response })).resolves.toEqual({ sessionId: '550e8400-e29b-41d4-a716-446655440001' });
    expect(host.floor).toBe(1);
    expect((await disk()).users[41].credentials[0].counter).toBe(1);
    expect(events.indexOf('counter-complete')).toBeLessThan(events.indexOf('sql-commit'));
    expect(events.indexOf('sql-commit')).toBeLessThan(events.indexOf('session'));
    expect(host.calls).not.toContain('prepare');
    expect(host.calls).not.toContain('complete');
  });
  it.each(['uv', 'signature', 'handle', 'challenge'] as const)('rejects bad %s locally before Root counter invocation', async (variant) => {
    const { begin, req } = await login();
    const response = key.authenticate(
      variant === 'challenge' ? 'wrong' : begin.options.challenge,
      variant === 'handle' ? 'd3Jvbmc' : 'aGFuZGxl',
      1,
      origin,
      rpID,
      variant !== 'uv',
    );
    if (variant === 'signature') response.response.signature = Buffer.alloc(70).toString('base64url');
    await expect(service.verifyLogin(req, { response })).rejects.toThrow();
    expect(host.calls).not.toContain('counter-complete');
    expect(host.floor).toBe(0);
    expect((await disk()).users[41].credentials[0].counter).toBe(0);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
  it('allows offline Root counter advancement before a later genuine Main assertion', async () => {
    host.floor = 8;
    const { req, response } = await login(9);
    await service.verifyLogin(req, { response });
    expect(host.floor).toBe(9);
    expect((await disk()).users[41].credentials[0].counter).toBe(9);
  });
  it('rejects valid local assertion below the current offline Root floor', async () => {
    host.floor = 8;
    const { req, response } = await login(7);
    await expect(service.verifyLogin(req, { response })).rejects.toBeInstanceOf(MainPasskeySynchronizationError);
    expect(host.floor).toBe(8);
    expect((await disk()).users[41].credentials[0].counter).toBe(0);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
  it.each(['drop', 'crossed'] as const)('does not write or grant after %s counter ACK despite Root advancement', async (failure) => {
    host[failure] = true;
    const { req, response } = await login();
    await expect(service.verifyLogin(req, { response })).rejects.toMatchObject({
      outcome: { phase: 'root-counter', recovery: 'unknown', passkeys: 'uncommitted' },
    });
    expect(host.floor).toBe(1);
    expect((await disk()).users[41].credentials[0].counter).toBe(0);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
  it('reports committed file and acknowledged Root when SQL resolution subsequently fails, without granting', async () => {
    const { req, response } = await login();
    commitFailure = true;
    await expect(service.verifyLogin(req, { response })).rejects.toMatchObject({
      outcome: { phase: 'file', recovery: 'acknowledged', passkeys: 'committed' },
    });
    expect(host.floor).toBe(1);
    expect((await disk()).users[41].credentials[0].counter).toBe(1);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
  it('retains Root advancement when local file commit fails, without claiming rollback or granting', async () => {
    const { req, response } = await login();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic rename denied'));
    await expect(service.verifyLogin(req, { response })).rejects.toMatchObject({ outcome: { recovery: 'acknowledged', passkeys: 'uncertain' } });
    expect(host.floor).toBe(1);
    expect((await disk()).users[41].credentials[0].counter).toBe(0);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
  it('keeps Main TOTP pending grant after ACK and does not send a TOTP code to Root', async () => {
    account.totpEnabled = true;
    account.totpSecret = 'encrypted';
    account.salt = 'salt';
    await store.change((state) => {
      const keys = state.users[41];
      if (!keys) throw new Error('Missing test key');
      keys.totpAfterPasskey = digest(Buffer.from('encrypted/salt'));
    });
    vi.mocked(encryption.decrypt).mockReturnValue('JBSWY3DPEHPK3PXP');
    profile.fill(0);
    profile = buildRecoveryIdentitySource(account, await store.snapshot(), origin, encryption).bytes;
    const { req, response } = await login();
    await expect(service.verifyLogin(req, { response })).resolves.toEqual({ totpSessionId: '550e8400-e29b-41d4-a716-446655440002' });
    expect(host.floor).toBe(1);
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(auth.beginVerifiedLogin).toHaveBeenCalledTimes(1);
  });
  it('uses a bound sensitive assertion and returns the actor without creating a Main login session', async () => {
    const action = 'b'.repeat(64);
    const begin = await service.sensitiveOptions(request(), action);
    await expect(
      service.verifySensitive(request(), action, { challengeId: begin.challengeId, response: key.authenticate(begin.options.challenge, 'aGFuZGxl') }),
    ).resolves.toMatchObject({ userId: 41 });
    expect(host.purpose).toBe('sensitive');
    expect(host.floor).toBe(1);
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(auth.beginVerifiedLogin).not.toHaveBeenCalled();
  });
  it('accepts fresh zero-counter assertions but consumes each Main ceremony only once', async () => {
    const first = await login(0);
    await service.verifyLogin(first.req, { response: first.response });
    await expect(service.verifyLogin(first.req, { response: first.response })).rejects.toThrow();
    const second = await login(0);
    await service.verifyLogin(second.req, { response: second.response });
    expect(host.calls.filter((value) => value === 'counter-complete')).toHaveLength(2);
    expect(host.floor).toBe(0);
  });
  it.each(['unknown', 'missing', 'realm', 'admission-drift', 'nonoperator'] as const)('holds %s without counter write or grant', async (failure) => {
    if (failure === 'unknown') host.mode = 'unknown';
    if (failure === 'missing') vi.stubEnv('ORBIS_HOST_SOCKET', '');
    if (failure === 'realm') vi.stubEnv('ORBIS_SENTINEL_RECOVERY_ORIGIN', 'not a URL');
    if (['unknown', 'missing', 'realm'].includes(failure)) {
      await expect(service.loginOptions(request(), {})).rejects.toMatchObject({ status: 503 });
      return;
    }
    const { req, response } = await login();
    if (failure === 'admission-drift') host.binding = 'd'.repeat(64);
    else account.operator = false;
    await expect(service.verifyLogin(req, { response })).rejects.toMatchObject({ status: 503 });
    expect(host.calls).not.toContain('counter-complete');
    expect(host.floor).toBe(0);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
  it('supports only explicit unchanged unmanaged admission and rechecks it before committing', async () => {
    host.mode = 'unmanaged';
    const { req, response } = await login();
    await service.verifyLogin(req, { response });
    expect(host.calls.filter((value) => value === 'admission')).toHaveLength(3);
    expect(host.calls).not.toContain('counter-complete');
    expect((await disk()).users[41].credentials[0].counter).toBe(1);
  });
});

describe('monotonic metadata-only preflight before authority changes', () => {
  it('authenticates under SQL/file fence before reading Root floors and catches up without Root authority lease', async () => {
    host.floor = 8;
    const before = await store.snapshot();
    await sync.synchronizeCounters(41, async (user, state) => {
      await authorize();
      expect(Object.isFrozen(user)).toBe(true);
      expect(Object.isFrozen(state)).toBe(true);
    });
    const after = await store.snapshot();
    expect(after.users[41]?.credentials[0]?.counter).toBe(8);
    const expectedKey = before.users[41]?.credentials[0];
    if (!expectedKey) throw new Error('Missing test key');
    expectedKey.counter = 8;
    expect(after).toEqual(before);
    expect(events.indexOf('authorize')).toBeLessThan(events.indexOf('counter-floors'));
    expect(host.calls).not.toContain('prepare');
    expect(host.calls).not.toContain('complete');
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
  it('does not rewrite equal counter metadata', async () => {
    const rename = vi.spyOn(fs, 'rename');
    const before = await fs.stat(path.join(directory, 'state/auth/passkeys.json'));
    await sync.synchronizeCounters(41, authorize);
    const after = await fs.stat(path.join(directory, 'state/auth/passkeys.json'));
    expect(rename).not.toHaveBeenCalled();
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
  it.each(['file', 'sql'] as const)('retains truthful %s catchup failure and grants no success', async (failure) => {
    host.floor = 4;
    if (failure === 'file') vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic rename failure'));
    else commitFailure = true;
    await expect(sync.synchronizeCounters(41, authorize)).rejects.toMatchObject({
      outcome: { phase: failure, passkeys: failure === 'file' ? 'uncertain' : 'committed' },
    });
    expect((await disk()).users[41].credentials[0].counter).toBe(failure === 'file' ? 0 : 4);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
  it('does not read floors or publish metadata after a rejected authorization', async () => {
    host.floor = 8;
    await expect(
      sync.synchronizeCounters(41, async () => {
        throw new Error('Synthetic bad password');
      }),
    ).rejects.toThrow('Synthetic bad password');
    expect(host.calls).not.toContain('counter-floors');
    expect((await disk()).users[41].credentials[0].counter).toBe(0);
  });
  it.each(['ahead', 'missing', 'private', 'cancelled'] as const)('rejects %s preflight without metadata or grants', async (failure) => {
    const signal = new AbortController();
    if (failure === 'ahead')
      await store.change((state) => {
        const storedKey = state.users[41]?.credentials[0];
        if (!storedKey) throw new Error('Missing test key');
        storedKey.counter = 4;
      });
    if (failure === 'missing') {
      host.floor = 4;
      host.omitFloor = true;
    }
    if (failure === 'private') {
      host.floor = 4;
      host.privateDrift = true;
    }
    if (failure === 'cancelled') signal.abort();
    const before = await fs.readFile(path.join(directory, 'state/auth/passkeys.json'));
    await expect(sync.synchronizeCounters(41, authorize, signal.signal)).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, 'state/auth/passkeys.json'))).toEqual(before);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
});
