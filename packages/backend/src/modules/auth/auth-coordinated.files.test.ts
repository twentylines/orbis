import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { hash } from 'argon2';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Database } from '@/core/database/database.module';
import type { User } from '@/core/database/drizzle/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { PasswordService } from '@/core/password/password.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { CacheService } from '@/core/cache/cache.service';
import { UserRepository } from '../user/user.repository';
import { CredentialSynchronization } from '../sentinel-recovery/credential-synchronization.service';
import { RecoveryChangeError } from '../sentinel-recovery/change-coordinator';
import { readRecoveryIdentity, type RecoveryIdentity } from '../sentinel-recovery/identity';
import { AuthService } from './auth.service';
import { PasskeyStore } from './passkey.store';
import { SessionManager } from './session.manager';
import { TotpAuthenticator } from './utils/totp-authenticator';
import { PasskeyService } from './passkey.service';
import { passkeyAuthenticator } from './__tests__/passkey.fixture';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import type { OwnershipGrant } from '../sentinel-recovery/host-broker';
import type { Request } from 'express';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const origin = 'https://orbis.example';
const binding = 'a'.repeat(64);
const operationId = 'b'.repeat(64);
let originalHash: string;
let root: string;
let account: User;
let store: PasskeyStore;
let auth: AuthService;
let passkeys: PasskeyService;
let sessions: ReturnType<typeof mock<SessionManager>>;
let passwords: PasswordService;
let encryption: EncryptionService;
let server: http.Server;
let db: ReturnType<typeof database>;
let host: {
  status: number;
  mode: string;
  protocol?: 'root-ownership';
  ownership?: OwnershipGrant;
  checkFailure?: boolean;
  drop?: 'prepare' | 'complete';
  crossed?: 'prepare' | 'complete';
  prepared?: RecoveryIdentity;
  current?: RecoveryIdentity;
};
let events: string[];

/** Real UserRepository and coordinator; SQL transport is deliberately a fixture.
 * Native acceptance must separately exercise the same Auth path on PostgreSQL.
 */
function database(initial: User) {
  let committed = structuredClone(initial);
  const behavior: { writeError?: boolean; commitError?: boolean } = {};
  const parameter = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return undefined;
    if ('value' in value && 'encoder' in value) return value.value;
    if ('queryChunks' in value && Array.isArray(value.queryChunks)) {
      for (const part of value.queryChunks) {
        const found = parameter(part);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const find = (row: User, query: { where?: unknown }) => {
    const wanted = parameter(query.where);
    return typeof wanted === 'number'
      ? row.id === wanted
        ? structuredClone(row)
        : undefined
      : typeof wanted === 'string'
        ? row.username === wanted
          ? structuredClone(row)
          : undefined
        : wanted === true && row.operator
          ? structuredClone(row)
          : undefined;
  };
  const query = (row: () => User) => ({ user: { findFirst: async (options: { where?: unknown }) => find(row(), options) } });
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
    events.push('sql-open');
    const draft = { row: structuredClone(committed), written: false };
    const operators = () => (draft.row.operator ? [structuredClone(draft.row)] : []);
    const select = () => {
      const selected = Object.assign(Promise.resolve().then(operators), {
        from: () => selected,
        where: () => selected,
        orderBy: () => selected,
        limit: async () => operators(),
      });
      return selected;
    };
    const tx = {
      execute: async () => {
        events.push('sql-lock');
      },
      query: query(() => draft.row),
      select,
      update: () => ({
        set: (patch: Partial<User>) => ({
          where: () => ({
            returning: async () => {
              events.push('sql-write');
              if (behavior.writeError) throw new Error('Synthetic SQL unavailable');
              draft.written = true;
              draft.row = { ...draft.row, ...patch };
              return [structuredClone(draft.row)];
            },
          }),
        }),
      }),
    };
    const result = await work(tx);
    if (draft.written && behavior.commitError) throw new Error('Synthetic COMMIT reply lost');
    committed = draft.row;
    events.push('sql-commit');
    return result;
  });
  return {
    value: { transaction, query: query(() => committed) } as unknown as Database,
    row: () => structuredClone(committed),
    behavior,
    replace: (value: User) => {
      committed = structuredClone(value);
    },
  };
}

beforeAll(async () => {
  originalHash = await hash('synthetic-old-password', { memoryCost: 4096, timeCost: 2, parallelism: 1 });
});

beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required.');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'auth-sync-')));
  account = {
    id: 1,
    username: 'operator',
    password: originalHash,
    operator: true,
    totpEnabled: false,
    totpSecret: null,
    salt: null,
    createdAt: 1,
    updatedAt: 1,
    locale: 'en',
    hasSeenWelcome: true,
  };
  events = [];
  db = database(account);
  const config = {
    get: vi.fn((key: string) =>
      key === 'directories'
        ? { dataDir: root }
        : key === 'demoMode'
          ? false
          : key === 'userSettings'
            ? { domain: 'orbis.example', sslPort: 443 }
            : 'synthetic-jwt-context',
    ),
  };
  store = new PasskeyStore(config as unknown as ConfigurationService);
  await store.change((state) => {
    state.users[1] = { handle: 'aGFuZGxl', credentials: [], totpAfterPasskey: 'c'.repeat(64) };
  });
  encryption = new EncryptionService(config as unknown as ConfigurationService);
  passwords = new PasswordService();
  const verify = passwords.verify.bind(passwords);
  vi.spyOn(passwords, 'verify').mockImplementation(async (...args) => {
    events.push('proof');
    return verify(...args);
  });
  sessions = mock<SessionManager>();
  sessions.destroyAllSessionsByUserId.mockImplementation(async () => {
    events.push('sessions');
  });
  sessions.createSession.mockResolvedValue('550e8400-e29b-41d4-a716-446655440010');
  sessions.generateSalt.mockReturnValue('synthetic-totp-salt');
  sessions.isSessionForUser.mockReturnValue(true);
  const filesystem = mock<FilesystemService>();
  filesystem.readTextFile.mockImplementation((file) => fs.readFile(file, 'utf8').catch(() => null));
  filesystem.removeFile.mockImplementation((file) =>
    fs.unlink(file).then(
      () => true,
      () => false,
    ),
  );
  const users = new UserRepository(db.value);
  const sync = new CredentialSynchronization(users, db.value, store, config as unknown as ConfigurationService, encryption);
  auth = new AuthService(
    users,
    sessions,
    config as unknown as ConfigurationService,
    encryption,
    mock<CacheService>(),
    filesystem,
    passwords,
    store,
    sync,
  );
  passkeys = new PasskeyService(config as unknown as ConfigurationService, store, auth, users, sessions, sync);
  host = { status: 200, mode: 'managed' };
  server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const reply = (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      response.writeHead(host.status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, Connection: 'close' });
      response.end(bytes);
    };
    expect(request.headers.host).toBe('orbis');
    if (request.url === '/v1/credentials/change-admission') {
      reply({ protocol: host.protocol ?? 'prepared-identity', mode: host.protocol ? 'unmanaged' : host.mode, binding });
      return;
    }
    if (host.protocol === 'root-ownership' && request.url?.startsWith('/v1/credentials/ownership-')) {
      const operation = request.url.slice('/v1/credentials/ownership-'.length);
      events.push(`ownership-${operation}`);
      if (operation === 'prepare') {
        expect(body.purpose).toBe('credential-change');
        expect(Object.keys(body).sort()).toEqual(['purpose', 'requestId']);
        host.ownership = { operationId, requestId: body.requestId, purpose: body.purpose, admissionBinding: binding, state: 'pending' };
        if (host.drop === 'prepare') {
          request.socket.destroy();
          return;
        }
        reply({ ...host.ownership, admissionBinding: host.crossed === 'prepare' ? 'd'.repeat(64) : binding });
      } else {
        expect(body.operationId).toBe(operationId);
        if (operation === 'check' && host.checkFailure) {
          request.socket.destroy();
          return;
        }
        if (operation === 'complete') {
          if (host.drop === 'complete') {
            request.socket.destroy();
            return;
          }
          if (!host.ownership) throw new Error('Expected prepared fixture grant.');
          host.ownership = { ...host.ownership, state: 'completed' };
        }
        reply(host.ownership);
      }
      return;
    }
    if (request.url === '/v1/credentials/admission') {
      events.push('admission');
      reply({ mode: host.mode, binding });
      return;
    }
    if (request.url === '/v1/credentials/counter-floors') {
      events.push('counter-floors');
      const bytes = Buffer.from(body.identityBase64, 'base64');
      const identity = readRecoveryIdentity(bytes, digest(bytes));
      reply({
        schema: 'orbis.sentinel-main-counter-floors.v1',
        admissionBinding: binding,
        sourceSha256: digest(bytes),
        generation: 1,
        revision: 'e'.repeat(64),
        counters: Object.fromEntries(identity.credentials.map((key) => [key.id, key.counter])),
      });
      return;
    }
    if (request.url === '/v1/credentials/prepare') {
      events.push('prepare');
      expect(db.row().password).toBe(originalHash);
      const baseline = Buffer.from(body.baselineIdentityBase64, 'base64');
      const planned = Buffer.from(body.plannedIdentityBase64, 'base64');
      host.prepared = readRecoveryIdentity(planned, digest(planned));
      if (host.drop === 'prepare') {
        request.socket.destroy();
        return;
      }
      reply({
        operationId,
        state: 'pending',
        admissionBinding: binding,
        baselineSha256: digest(baseline),
        plannedSha256: host.crossed === 'prepare' ? 'd'.repeat(64) : digest(planned),
      });
      return;
    }
    if (request.url === '/v1/credentials/complete') {
      events.push('complete');
      const source = Buffer.from(body.currentIdentityBase64, 'base64');
      host.current = readRecoveryIdentity(source, digest(source));
      expect(host.current).toEqual(host.prepared);
      if (host.drop === 'complete') {
        request.socket.destroy();
        return;
      }
      reply({
        operationId,
        state: 'completed',
        admissionBinding: binding,
        plannedSha256: host.crossed === 'complete' ? 'd'.repeat(64) : digest(source),
      });
      return;
    }
    response.writeHead(404).end();
  });
  const socket = path.join(root, 'host.sock');
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await fs.chmod(socket, 0o600);
  vi.stubEnv('ORBIS_HOST_SOCKET', socket);
  vi.stubEnv('ORBIS_SENTINEL_RECOVERY_ORIGIN', origin);
});

const browser = () =>
  ({
    headers: { origin, host: 'orbis.example' },
    socket: { remoteAddress: '127.0.0.1' },
    cookies: { [SESSION_COOKIE_NAME]: 'synthetic-browser-session' },
    authMethod: 'session',
    user: { id: 1, operator: true },
  }) as unknown as Request;
async function enroll() {
  const key = passkeyAuthenticator();
  const { options } = await passkeys.registrationOptions(browser(), { password: 'synthetic-old-password', name: 'Fixture key' });
  await passkeys.verifyRegistration(browser(), { response: key.register(options.challenge, origin, 'orbis.example') });
  return key;
}

describe('production noncounter passkey authority changes', () => {
  it.each(['add', 'policy', 'remove'] as const)('holds %s without a host instead of falling back to local writes', async (action) => {
    const key = await enroll();
    const pending = await passkeys.registrationOptions(browser(), { password: 'synthetic-old-password', name: 'Another key' });
    const next = passkeyAuthenticator();
    const before = await fs.readFile(path.join(root, 'state/auth/passkeys.json'));
    vi.stubEnv('ORBIS_HOST_SOCKET', '');
    events.length = 0;
    const attempt =
      action === 'add'
        ? passkeys.verifyRegistration(browser(), { response: next.register(pending.options.challenge, origin, 'orbis.example') })
        : action === 'policy'
          ? passkeys.updatePolicy(browser(), { requireTotpAfterPasskey: false, password: 'synthetic-old-password' })
          : passkeys.remove(browser(), { id: key.id, password: 'synthetic-old-password' });
    await expect(attempt).rejects.toMatchObject({ status: 503 });
    expect(await fs.readFile(path.join(root, 'state/auth/passkeys.json'))).toEqual(before);
    expect(events).not.toContain('prepare');
    expect(events).not.toContain('proof');
    expect(events).not.toContain('sessions');
  });
  it('prepares an existing handle under a read fence without a Root lease or passkey write', async () => {
    vi.stubEnv('ORBIS_HOST_SOCKET', '');
    const before = await fs.readFile(path.join(root, 'state/auth/passkeys.json'));
    const { options } = await passkeys.registrationOptions(browser(), { password: 'synthetic-old-password', name: 'Fixture key' });
    expect(options.user.id).toBe('aGFuZGxl');
    expect(await fs.readFile(path.join(root, 'state/auth/passkeys.json'))).toEqual(before);
    expect(events).not.toContain('admission');
    expect(events).toContain('proof');
  });
  it('creates the first handle through Root completion and refuses missing admission without mutation', async () => {
    await store.change((state) => {
      delete state.users[1];
    });
    vi.stubEnv('ORBIS_HOST_SOCKET', '');
    await expect(passkeys.registrationOptions(browser(), { password: 'synthetic-old-password', name: 'Fixture key' })).rejects.toMatchObject({
      status: 503,
    });
    expect((await store.snapshot()).users[1]).toBeUndefined();
    vi.stubEnv('ORBIS_HOST_SOCKET', path.join(root, 'host.sock'));
    const { options } = await passkeys.registrationOptions(browser(), { password: 'synthetic-old-password', name: 'Fixture key' });
    expect(options.user.id).toBe((await store.snapshot()).users[1]?.handle);
    expect(events).toContain('complete');
    expect(events).not.toContain('sessions');
  });
  it('adds a genuinely verified P256 credential inside the coordinator and synchronizes its exact Root candidate', async () => {
    const key = await enroll();
    expect((await store.snapshot()).users[1]?.credentials[0]?.id).toBe(key.id);
    expect(host.current?.credentials[0]?.id).toBe(key.id);
    expect(events.filter((event) => event === 'prepare')).toHaveLength(1);
    expect(events.filter((event) => event === 'complete')).toHaveLength(1);
  });
  it('preserves WebAuthn rejection before prepare and leaves no authority mutation', async () => {
    const { options } = await passkeys.registrationOptions(browser(), { password: 'synthetic-old-password', name: 'Fixture key' });
    const key = passkeyAuthenticator();
    await expect(passkeys.verifyRegistration(browser(), { response: key.register(options.challenge, origin, 'evil.example') })).rejects.toMatchObject(
      { status: 400 },
    );
    expect((await store.snapshot()).users[1]?.credentials).toEqual([]);
    expect(events).not.toContain('prepare');
  });
  it('changes extra TOTP policy under locked password/code proof and completes the exact source', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    await enroll();
    const salt = 'synthetic-salt';
    const secret = 'JBSWY3DPEHPK3PXP';
    db.replace({ ...db.row(), totpEnabled: true, salt, totpSecret: encryption.encrypt(secret, salt) });
    events.length = 0;
    expect(
      await passkeys.updatePolicy(browser(), {
        requireTotpAfterPasskey: true,
        password: 'synthetic-old-password',
        totpCode: TotpAuthenticator.generate(secret),
      }),
    ).toEqual({ requireTotpAfterPasskey: true, totpEnabled: true });
    expect((await store.snapshot()).users[1]?.totpAfterPasskey).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(host.current?.totpEnabled).toBe(true);
    expect(events.indexOf('proof')).toBeLessThan(events.indexOf('prepare'));
    expect(events).toContain('complete');
  });
  it('removes a credential before Root completion and invalidates sessions only afterward', async () => {
    const key = await enroll();
    events.length = 0;
    expect(await passkeys.remove(browser(), { id: key.id, password: 'synthetic-old-password' })).toEqual({ success: true });
    expect((await store.snapshot()).users[1]?.credentials).toEqual([]);
    expect(host.current?.credentials).toEqual([]);
    expect(events.indexOf('complete')).toBeLessThan(events.indexOf('sessions'));
  });
  it('holds a lost removal completion without granting session cleanup or claiming rollback', async () => {
    const key = await enroll();
    events.length = 0;
    host.drop = 'complete';
    await expect(passkeys.remove(browser(), { id: key.id, password: 'synthetic-old-password' })).rejects.toMatchObject({
      outcome: { passkeys: 'committed', recovery: 'unknown' },
    });
    expect((await store.snapshot()).users[1]?.credentials).toEqual([]);
    expect(events).not.toContain('sessions');
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function passwordChange() {
  return auth.changePassword({ userId: 1, currentPassword: 'synthetic-old-password', newPassword: 'synthetic-new-password' });
}
async function marker() {
  await fs.mkdir(path.join(root, 'state'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'state/password-change-request'), String(Math.floor(Date.now() / 1000)), { mode: 0o600 });
}

describe('production Auth coordinated credential changes', () => {
  it.each(['managed', 'unmanaged'])('uses the actual client and coordinator before changing a password in %s mode', async (mode) => {
    host.mode = mode;
    expect(await passwordChange()).toBe(true);
    expect(await passwords.verify('synthetic-new-password', db.row().password)).toBe(true);
    expect(events.indexOf('admission')).toBeLessThan(events.indexOf('proof'));
    expect(events.indexOf('proof')).toBeLessThan(events.indexOf('prepare'));
    expect(events.indexOf('prepare')).toBeLessThan(events.indexOf('sql-write'));
    expect(events.indexOf('sql-write')).toBeLessThan(events.indexOf('complete'));
    expect(events.indexOf('complete')).toBeLessThan(events.indexOf('sessions'));
    expect(host.current?.passwordHash).toBe(db.row().password);
  });
  it.each(['missing-socket', 'missing-origin', 'bad-origin', 'unknown', 'service-failure'])(
    'refuses %s before password proof, mutation or session cleanup',
    async (failure) => {
      if (failure === 'missing-socket') vi.stubEnv('ORBIS_HOST_SOCKET', '');
      if (failure === 'missing-origin') vi.stubEnv('ORBIS_SENTINEL_RECOVERY_ORIGIN', '');
      if (failure === 'bad-origin') vi.stubEnv('ORBIS_SENTINEL_RECOVERY_ORIGIN', 'http://orbis.example');
      if (failure === 'unknown') host.mode = 'unknown';
      if (failure === 'service-failure') host.status = 503;
      await expect(passwordChange()).rejects.toMatchObject({ status: 503 });
      expect(db.row().password).toBe(originalHash);
      expect(events).not.toContain('proof');
      expect(events).not.toContain('sql-write');
      expect(events).not.toContain('sessions');
    },
  );
  it('ordinary password sign-in still works without host configuration', async () => {
    vi.stubEnv('ORBIS_HOST_SOCKET', '');
    vi.stubEnv('ORBIS_SENTINEL_RECOVERY_ORIGIN', '');
    expect(await auth.login({ username: 'operator', password: 'synthetic-old-password' })).toEqual({
      sessionId: '550e8400-e29b-41d4-a716-446655440010',
    });
    expect(events).not.toContain('admission');
  });
  it('preserves wrong-password policy inside the locked proof before any prepare', async () => {
    await expect(auth.changePassword({ userId: 1, currentPassword: 'wrong', newPassword: 'synthetic-new-password' })).rejects.toMatchObject({
      message: 'AUTH_ERROR_INVALID_PASSWORD',
      status: 500,
    });
    expect(events.filter((event) => event === 'sql-lock').length).toBeGreaterThanOrEqual(2);
    expect(events.indexOf('sql-lock')).toBeLessThan(events.indexOf('proof'));
    expect(events).not.toContain('prepare');
    expect(events).not.toContain('sql-write');
  });
  it.each(['prepare', 'complete'] as const)('does not clean sessions after a lost %s reply and preserves the actual outcome', async (drop) => {
    host.drop = drop;
    let failure: unknown;
    try {
      await passwordChange();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RecoveryChangeError);
    expect((failure as RecoveryChangeError).outcome.recovery).toBe('unknown');
    expect((failure as RecoveryChangeError).outcome.sql).toBe(drop === 'prepare' ? 'not-written' : 'committed');
    expect(db.row().password === originalHash).toBe(drop === 'prepare');
    expect(events).not.toContain('sessions');
    expect(events.filter((event) => event === drop)).toHaveLength(1);
  });
  it.each(['prepare', 'complete'] as const)('rejects crossed %s receipts without claiming success', async (crossed) => {
    host.crossed = crossed;
    await expect(passwordChange()).rejects.toBeInstanceOf(RecoveryChangeError);
    expect(events).not.toContain('sessions');
    expect(db.row().password === originalHash).toBe(crossed === 'prepare');
  });
  it('changes the username with locked uniqueness proof and invalidates sessions only after completion', async () => {
    expect(await auth.changeUsername({ userId: 1, password: 'synthetic-old-password', newUsername: 'New-Name' })).toBe(true);
    expect(db.row().username).toBe('new-name');
    expect(host.current?.username).toBe('new-name');
    expect(events.indexOf('complete')).toBeLessThan(events.indexOf('sessions'));
  });
  it('stages and enables TOTP through the same prepared boundary', async () => {
    vi.spyOn(TotpAuthenticator, 'generateSecret').mockReturnValue('JBSWY3DPEHPK3PXP');
    const staged = await auth.getTotpUri({ userId: 1, password: 'synthetic-old-password' });
    expect(staged.key).toBe('JBSWY3DPEHPK3PXP');
    expect(db.row().totpEnabled).toBe(false);
    expect(host.current?.totpEnabled).toBe(false);
    vi.spyOn(TotpAuthenticator, 'check').mockReturnValue(true);
    expect(await auth.setupTotp({ userId: 1, totpCode: '123456' })).toBe(true);
    expect(db.row().totpEnabled).toBe(true);
    expect(host.current?.totpSecret).toBe(staged.key);
  });
  it('disables TOTP and clears extra passkey policy only in the prepared draft', async () => {
    const salt = 'synthetic-salt';
    db.replace({ ...db.row(), totpEnabled: true, salt, totpSecret: encryption.encrypt('JBSWY3DPEHPK3PXP', salt) });
    expect(await auth.disableTotp({ userId: 1, password: 'synthetic-old-password' })).toBe(true);
    expect(db.row().totpEnabled).toBe(false);
    expect(db.row().totpSecret).toBeNull();
    expect((await store.snapshot()).users[1]?.totpAfterPasskey).toBeUndefined();
    expect(host.current?.totpEnabled).toBe(false);
  });
  it('local operator reset removes passkeys and TOTP before source completion, then retires the local request', async () => {
    await marker();
    await store.change((state) => {
      const keys = state.users[1];
      if (!keys) throw new Error('Expected fixture passkey owner.');
      keys.credentials.push({
        id: 'YQ',
        publicKey: 'a2V5',
        counter: 0,
        rpID: 'orbis.example',
        name: 'Fixture key',
        createdAt: 1,
        lastUsedAt: null,
        transports: [],
      });
    });
    expect(await auth.changeOperatorPassword({ newPassword: 'synthetic-new-password' })).toEqual({ email: 'operator' });
    expect((await store.snapshot()).users[1]).toBeUndefined();
    expect(host.current?.credentials).toEqual([]);
    expect(host.current?.totpEnabled).toBe(false);
    await expect(fs.readFile(path.join(root, 'state/password-change-request'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events.indexOf('complete')).toBeLessThan(events.indexOf('sessions'));
  });
  it('lost reset completion keeps the request and sessions while recording committed credential stores', async () => {
    await marker();
    host.drop = 'complete';
    await expect(auth.changeOperatorPassword({ newPassword: 'synthetic-new-password' })).rejects.toMatchObject({
      outcome: { sql: 'committed', recovery: 'unknown' },
    });
    expect(await fs.readFile(path.join(root, 'state/password-change-request'), 'utf8')).not.toBe('');
    expect(events).not.toContain('sessions');
    expect((await store.snapshot()).users[1]).toBeUndefined();
  });
  it.each(['writeError', 'commitError'] as const)('preserves reset evidence and precise partial outcomes after %s', async (phase) => {
    await marker();
    db.behavior[phase] = true;
    await expect(auth.changeOperatorPassword({ newPassword: 'synthetic-new-password' })).rejects.toMatchObject({
      outcome: { phase: 'write', sql: 'uncertain', passkeys: phase === 'commitError' ? 'committed' : 'uncommitted', recovery: 'pending' },
    });
    expect(db.row().password).toBe(originalHash);
    expect(Boolean((await store.snapshot()).users[1])).toBe(phase === 'writeError');
    expect(await fs.readFile(path.join(root, 'state/password-change-request'), 'utf8')).not.toBe('');
    expect(events).not.toContain('complete');
    expect(events).not.toContain('sessions');
  });
  it('keeps committed/completed outcome while preserving existing reset session-cleanup guidance', async () => {
    await marker();
    sessions.destroyAllSessionsByUserId.mockRejectedValue(new Error('private cleanup details'));
    await expect(auth.changeOperatorPassword({ newPassword: 'synthetic-new-password' })).rejects.toMatchObject({
      message: 'AUTH_ERROR_RESET_SESSION_CLEANUP',
      recoveryOutcome: { phase: 'after-success', sql: 'committed', recovery: 'completed' },
    });
    expect(await fs.readFile(path.join(root, 'state/password-change-request'), 'utf8')).not.toBe('');
    expect(await passwords.verify('synthetic-new-password', db.row().password)).toBe(true);
  });
  it('unsupported nonoperator mutations cannot silently bypass Root coordination', async () => {
    db.replace({ ...db.row(), operator: false });
    await expect(passwordChange()).rejects.toMatchObject({ status: 503 });
    expect(events).not.toContain('proof');
    expect(events).not.toContain('sql-write');
  });
});

describe('Root birth account changes without a recovery realm', () => {
  beforeEach(() => {
    host.protocol = 'root-ownership';
    vi.stubEnv('ORBIS_SENTINEL_RECOVERY_ORIGIN', undefined);
  });

  it('changes a password through the actual Root client before cleaning sessions', async () => {
    expect(await passwordChange()).toBe(true);
    expect(await passwords.verify('synthetic-new-password', db.row().password)).toBe(true);
    expect(events.indexOf('proof')).toBeLessThan(events.indexOf('ownership-prepare'));
    expect(events.indexOf('ownership-check')).toBeLessThan(events.indexOf('sql-write'));
    expect(events.indexOf('sql-commit')).toBeLessThan(events.indexOf('ownership-complete'));
    expect(events.indexOf('ownership-complete')).toBeLessThan(events.indexOf('sessions'));
    expect(host.ownership?.state).toBe('completed');
    expect(host.prepared).toBeUndefined();
    expect(host.current).toBeUndefined();
    expect(events).not.toContain('counter-floors');
  });

  it('changes username without manufacturing a recovery identity', async () => {
    expect(await auth.changeUsername({ userId: 1, password: 'synthetic-old-password', newUsername: 'New-Name' })).toBe(true);
    expect(db.row().username).toBe('new-name');
    expect(host.ownership?.state).toBe('completed');
  });

  it('stages and enables TOTP without requiring Sentinel enrollment', async () => {
    vi.spyOn(TotpAuthenticator, 'generateSecret').mockReturnValue('JBSWY3DPEHPK3PXP');
    await auth.getTotpUri({ userId: 1, password: 'synthetic-old-password' });
    vi.spyOn(TotpAuthenticator, 'check').mockReturnValue(true);
    expect(await auth.setupTotp({ userId: 1, totpCode: '123456' })).toBe(true);
    expect(db.row().totpEnabled).toBe(true);
    expect(events.filter((event) => event === 'ownership-complete')).toHaveLength(2);
  });

  it('creates a handle, verifies a real P256 registration and removes it under Root holds', async () => {
    await store.change((draft) => {
      delete draft.users[1];
    });
    const key = await enroll();
    expect((await store.snapshot()).users[1]?.credentials[0]?.id).toBe(key.id);
    await passkeys.remove(browser(), { id: key.id, password: 'synthetic-old-password' });
    expect((await store.snapshot()).users[1]?.credentials).toEqual([]);
    expect(events.filter((event) => event === 'ownership-complete')).toHaveLength(3);
    expect(events).not.toContain('prepare');
  });

  it('keeps the existing wrong-password policy before Root can grant a write', async () => {
    await expect(auth.changePassword({ userId: 1, currentPassword: 'wrong', newPassword: 'synthetic-new-password' })).rejects.toMatchObject({
      message: 'AUTH_ERROR_INVALID_PASSWORD',
    });
    expect(events).not.toContain('ownership-prepare');
    expect(events).not.toContain('sql-write');
  });

  it.each(['prepare', 'complete'] as const)('does not retry or clean sessions after lost Root %s', async (drop) => {
    host.drop = drop;
    await expect(passwordChange()).rejects.toMatchObject({
      outcome: { sql: drop === 'prepare' ? 'not-written' : 'committed', recovery: 'unknown' },
    });
    expect(events.filter((event) => event === `ownership-${drop}`)).toHaveLength(1);
    expect(events).not.toContain('sessions');
    expect(db.row().password === originalHash).toBe(drop === 'prepare');
  });

  it.each(['writeError', 'commitError'] as const)('preserves Root and reset custody after %s', async (failure) => {
    await marker();
    db.behavior[failure] = true;
    await expect(auth.changeOperatorPassword({ newPassword: 'synthetic-new-password' })).rejects.toMatchObject({
      outcome: { sql: 'uncertain', passkeys: failure === 'commitError' ? 'committed' : 'uncommitted', recovery: 'pending' },
    });
    expect(host.ownership?.state).toBe('pending');
    expect(events).not.toContain('ownership-complete');
    expect(events).not.toContain('sessions');
    expect(await fs.readFile(path.join(root, 'state/password-change-request'), 'utf8')).not.toBe('');
  });

  it('rejects a changed admission before invoking SQL or committing passkeys', async () => {
    host.crossed = 'prepare';
    await expect(passwordChange()).rejects.toMatchObject({ outcome: { sql: 'not-written', passkeys: 'uncommitted' } });
    expect(events).not.toContain('ownership-check');
    expect(events).not.toContain('sql-write');
  });

  it('refuses a failed current Root check without a local write', async () => {
    host.checkFailure = true;
    await expect(passwordChange()).rejects.toMatchObject({ status: 503 });
    expect(events).not.toContain('sql-write');
    expect(events).not.toContain('sessions');
  });
});
