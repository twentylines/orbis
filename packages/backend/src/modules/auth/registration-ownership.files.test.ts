import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Database } from '@/core/database/database.module';
import type { User } from '@/core/database/drizzle/types';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { EncryptionService } from '@/core/encryption/encryption.service';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { CacheService } from '@/core/cache/cache.service';
import type { PasswordService } from '@/core/password/password.service';
import type { UserRepository } from '../user/user.repository';
import { CredentialSynchronization } from '../sentinel-recovery/credential-synchronization.service';
import { OwnershipWriteError } from '../sentinel-recovery/ownership-authority';
import { AuthService } from './auth.service';
import type { PasskeyStore } from './passkey.store';
import type { SessionManager } from './session.manager';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const operator: User = {
  id: 1,
  username: 'home.user',
  password: 'synthetic-hash',
  operator: true,
  totpEnabled: false,
  totpSecret: null,
  salt: null,
  createdAt: 1,
  updatedAt: 1,
  locale: 'en',
  hasSeenWelcome: false,
};

/** Real Auth, synchronization service and socket client. SQL and Root policy
 * are explicit ports here; separate issuer tests cover actual Root admission.
 */
async function fixture() {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required.');
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'ro-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, 's');
  const events: string[] = [];
  const state = {
    account: undefined as User | undefined,
    status: 200,
    completedPrepare: false,
    drop: '' as string,
    changedCheck: false,
    writeFailure: '' as '' | 'before' | 'after',
    beforeSql: async () => {},
  };
  const requests: Array<{ operation: string; body: Record<string, string> }> = [];
  let requestId = '';
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const operation = (request.url ?? '').split('/').at(-1) ?? '';
    requests.push({ operation, body });
    events.push(operation);
    if (operation === state.drop) {
      response.destroy();
      return;
    }
    if (operation === 'ownership-prepare') requestId = body.requestId;
    const value = {
      requestId,
      operationId: 'b'.repeat(64),
      admissionBinding: state.changedCheck && operation === 'ownership-check' ? 'd'.repeat(64) : 'a'.repeat(64),
      purpose: 'first-registration',
      state: operation === 'ownership-complete' || state.completedPrepare ? 'completed' : 'pending',
    };
    const bytes = Buffer.from(JSON.stringify(value));
    response.writeHead(state.status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length });
    response.end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await fs.chmod(socket, 0o600);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  vi.stubEnv('ORBIS_HOST_SOCKET', socket);
  vi.stubEnv('ORBIS_SENTINEL_RECOVERY_ORIGIN', '');
  const users = mock<UserRepository>();
  const sessions = mock<SessionManager>();
  const passwords = mock<PasswordService>();
  const config = mock<ConfigurationService>();
  const encryption = mock<EncryptionService>();
  const passkeys = mock<PasskeyStore>();
  users.getFirstOperator.mockImplementation(async () => state.account);
  users.getUserByUsername.mockResolvedValue(undefined);
  passwords.hash.mockResolvedValue('synthetic-hash');
  users.createFirstOperator.mockImplementation(async (input) => {
    events.push('sql-write');
    await state.beforeSql();
    if (state.writeFailure === 'before') throw new Error('Synthetic SQL transport failure');
    state.account = { ...operator, ...input };
    if (state.writeFailure === 'after') throw new Error('Synthetic COMMIT reply lost');
    return state.account;
  });
  sessions.createSession.mockImplementation(async () => {
    events.push('session');
    return '550e8400-e29b-41d4-a716-446655440010';
  });
  const sync = new CredentialSynchronization(users, mock<Database>(), passkeys, config, encryption);
  const auth = new AuthService(users, sessions, config, encryption, mock<CacheService>(), mock<FilesystemService>(), passwords, passkeys, sync);
  return { state, events, requests, users, sessions, auth, sync };
}
const input = { username: 'home.user', password: 'synthetic-password' };

it('requires pending Root preparation and revalidation before SQL, and completes before issuing a session', async () => {
  const f = await fixture();
  expect(await f.auth.register(input)).toEqual({ sessionId: '550e8400-e29b-41d4-a716-446655440010' });
  expect(f.events).toEqual(['ownership-prepare', 'ownership-check', 'sql-write', 'ownership-complete', 'session']);
  expect(f.requests[0]?.body).toMatchObject({ purpose: 'first-registration' });
  expect(f.requests[0]?.body.requestId).toMatch(/^[a-f0-9]{64}$/);
  expect(f.requests[2]?.body.disposition).toBe('committed');
  expect(f.state.account?.username).toBe('home.user');
});

it.each([404, 409, 503])('Root HTTP %s never becomes permission to register on an empty Main database', async (status) => {
  const f = await fixture();
  f.state.status = status;
  await expect(f.auth.register(input)).rejects.toBeInstanceOf(OwnershipWriteError);
  expect(f.users.createFirstOperator).not.toHaveBeenCalled();
  expect(f.sessions.createSession).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(1);
});

it('completed preparation is replay evidence and does not grant first-account writes', async () => {
  const f = await fixture();
  f.state.completedPrepare = true;
  await expect(f.auth.register(input)).rejects.toBeInstanceOf(OwnershipWriteError);
  expect(f.users.createFirstOperator).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(1);
});

it.each(['ownership-prepare', 'ownership-check', 'ownership-complete'])('preserves actual Main effects after a lost %s reply', async (drop) => {
  const f = await fixture();
  f.state.drop = drop;
  await expect(f.auth.register(input)).rejects.toBeInstanceOf(OwnershipWriteError);
  expect(Boolean(f.state.account)).toBe(drop === 'ownership-complete');
  expect(f.users.createFirstOperator).toHaveBeenCalledTimes(drop === 'ownership-complete' ? 1 : 0);
  expect(f.sessions.createSession).not.toHaveBeenCalled();
  expect(f.requests.filter((r) => r.operation === drop)).toHaveLength(1);
  expect(f.requests.some((r) => r.body.disposition === 'not-written')).toBe(drop === 'ownership-check');
});

it('changed Root authority at the final check prevents SQL and only attempts unwritten retirement', async () => {
  const f = await fixture();
  f.state.changedCheck = true;
  await expect(f.auth.register(input)).rejects.toBeInstanceOf(OwnershipWriteError);
  expect(f.users.createFirstOperator).not.toHaveBeenCalled();
  expect(f.requests.at(-1)?.body.disposition).toBe('not-written');
});

it.each(['before', 'after'] as const)(
  'a rejected %s SQL call retains the Root hold without claiming rollback or creating a session',
  async (failure) => {
    const f = await fixture();
    f.state.writeFailure = failure;
    await expect(f.auth.register(input)).rejects.toMatchObject({ outcome: { writes: 'uncertain', authority: 'pending' } });
    expect(Boolean(f.state.account)).toBe(failure === 'after');
    expect(f.requests.map((r) => r.operation)).toEqual(['ownership-prepare', 'ownership-check']);
    expect(f.sessions.createSession).not.toHaveBeenCalled();
  },
);

it('does not undo a committed operator or replay Root completion when session creation fails', async () => {
  const f = await fixture();
  f.sessions.createSession.mockRejectedValue(new Error('Synthetic session unavailable'));
  await expect(f.auth.register(input)).rejects.toThrow('Synthetic session unavailable');
  expect(f.state.account).toBeDefined();
  expect(f.requests.at(-1)?.body.disposition).toBe('committed');
  expect(f.requests).toHaveLength(3);
});

it('queued registrations remain serialized until the first Root completion and see the committed operator', async () => {
  const f = await fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.beforeSql = async () => {
    enter();
    await wait;
  };
  const first = f.auth.register(input);
  await entered;
  const second = f.auth.register(input);
  const denied = expect(second).rejects.toMatchObject({ status: 403 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.requests).toHaveLength(2);
  release();
  await first;
  await denied;
  expect(f.users.createFirstOperator).toHaveBeenCalledTimes(1);
  expect(f.requests).toHaveLength(3);
});

it('missing Host configuration remains unknown while normal already-configured-server policy stays intact', async () => {
  const f = await fixture();
  vi.stubEnv('ORBIS_HOST_SOCKET', '');
  await expect(f.auth.register(input)).rejects.toMatchObject({ status: 503 });
  expect(f.users.createFirstOperator).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(0);
  f.state.account = operator;
  await expect(f.auth.register(input)).rejects.toMatchObject({ status: 403 });
  expect(f.requests).toHaveLength(0);
});
