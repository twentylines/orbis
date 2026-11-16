import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectCoreDatabase, prepareCoreCleanTarget, verifyCoreCleanTarget, type CoreCleanTargetReconciliation } from './time-machine-core-database';
import {
  coreCleanTargetFailureDiagnostic,
  coreCleanTargetWorkerCapability,
  coreCleanTargetWorkerCapabilityV2,
  prepareCoreCleanTargetWorker,
  verifyCoreCleanTargetWorker,
  coreCleanTargetVerifyCapabilityV2,
} from './time-machine-core-clean-target-worker';
import { canonicalCoreJson } from './time-machine-core-payload';

type FakeClient = { config: Record<string, unknown>; ended: number; connected: boolean };
const state = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  connectError: undefined as unknown,
  connectHook: undefined as ((client: FakeClient) => Promise<void>) | undefined,
  sessionHook: undefined as ((client: FakeClient, row: Record<string, unknown>) => void) | undefined,
  migrations: [{ id: 1, hash: 'synthetic-migration', created_at: '1700000000000' }],
  mutation: undefined as ((receipt: Record<string, unknown>) => void) | undefined,
  beforeSql: undefined as (() => Promise<void>) | undefined,
  afterSql: undefined as (() => Promise<void>) | undefined,
  sqlWrites: 0,
  actualSourceAuth: undefined as unknown,
  actualDestinationAuth: undefined as unknown,
}));
vi.mock('pg', async (original) => ({
  ...(await original<typeof import('pg')>()),
  Client: class {
    config: Record<string, unknown>;
    ended = 0;
    connected = false;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      state.clients.push(this);
    }
    on() {
      return this;
    }
    async connect() {
      if (state.connectError !== undefined) throw state.connectError;
      this.connected = true;
      await state.connectHook?.(this);
    }
    async query(sql: string) {
      if (sql.startsWith('SELECT CURRENT_USER')) {
        const row = {
          current_user: this.config.user,
          session_user: this.config.user,
          database: this.config.database,
          search_path: 'pg_catalog',
          read_only: this.config.host === '/clean-target-target-socket' ? 'off' : 'on',
        };
        state.sessionHook?.(this, row);
        return { rows: [row] };
      }
      if (sql.startsWith('SELECT * FROM drizzle.__drizzle_migrations LIMIT')) return { rows: structuredClone(state.migrations) };
      throw new Error('Unexpected fixture query');
    }
    async end() {
      this.ended += 1;
    }
  },
}));
vi.mock('./time-machine-core-database', () => ({
  inspectCoreDatabase: vi.fn(),
  prepareCoreCleanTarget: vi.fn(),
  verifyCoreCleanTarget: vi.fn(),
}));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(canonicalCoreJson(value));
const sourceKey = 'synthetic captured authentication candidate '.repeat(2);
const destinationKey = 'synthetic destination authentication candidate '.repeat(2);
const sourceAuth = () => ({ jwtSecret: sourceKey, passkeys: null as unknown });
const destinationAuth = () => ({ jwtSecret: destinationKey, passkeys: null as unknown });
const request = () => ({
  schema: 'orbis.core-clean-target-worker-input.v1',
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  nonce: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  rootPreparationSha256: '4'.repeat(64),
  rootIntentSha256: '5'.repeat(64),
  source: { role: 'captured_role', database: 'captured', snapshotSha256: '1'.repeat(64), authenticationSha256: digest(sourceAuth()) },
  destination: { role: 'destination_role', database: 'destination', snapshotSha256: '2'.repeat(64), authenticationSha256: digest(destinationAuth()) },
  target: { systemIdentifier: '7000000000000000003', databaseOid: '16384', database: 'clean_target' },
  targetRole: 'clean_target_role',
  expected: { catalogSha256: '3'.repeat(64), migrationsSha256: digest(state.migrations), catalogOwnershipSha256: '6'.repeat(64) },
  sourceOwnerId: 11,
  destinationOwnerId: 11,
  catalogOwnerIds: [11],
  scope: 'prepare-clean-target-only',
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
});
type Request = ReturnType<typeof request>;
const authorization = (value: Request = request()) => ({
  schema: 'orbis.core-clean-target-authorization.v1',
  decision: 'approved',
  id: value.id,
  nonce: value.nonce,
  requestSha256: digest(value),
  rootPreparationSha256: value.rootPreparationSha256,
  rootIntentSha256: value.rootIntentSha256,
  sourceSha256: value.source.snapshotSha256,
  destinationSha256: value.destination.snapshotSha256,
  target: value.target,
  catalogOwnershipSha256: value.expected.catalogOwnershipSha256,
  scope: 'prepare-clean-target-only',
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
});
let root: string;
let input: string;
let output: string;
const options = () => ({ input, output, signal: new AbortController().signal });
async function write(name: string, value: unknown, raw = false) {
  const file = path.join(input, name);
  await fs.chmod(file, 0o600).catch(() => undefined);
  await fs.writeFile(file, raw ? String(value) : canonicalCoreJson(value), { mode: 0o600 });
  await fs.chmod(file, 0o400);
}
async function writeRequest(value: Request) {
  await write('request.json', value);
  await write('authorization.json', authorization(value));
}
async function outputNames() {
  return (await fs.readdir(output)).sort();
}
async function result(name: string) {
  return JSON.parse(await fs.readFile(path.join(output, name), 'utf8'));
}
beforeEach(async () => {
  vi.clearAllMocks();
  state.clients = [];
  state.connectError = undefined;
  state.connectHook = undefined;
  state.sessionHook = undefined;
  state.mutation = undefined;
  state.beforeSql = undefined;
  state.afterSql = undefined;
  state.sqlWrites = 0;
  state.actualSourceAuth = undefined;
  state.actualDestinationAuth = undefined;
  state.migrations = [{ id: 1, hash: 'synthetic-migration', created_at: '1700000000000' }];
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'core-clean-target-worker-')));
  input = path.join(root, 'input');
  output = path.join(root, 'output');
  await fs.mkdir(input, { mode: 0o700 });
  await fs.mkdir(output, { mode: 0o700 });
  await writeRequest(request());
  await write('source-authentication.json', sourceAuth());
  await write('destination-authentication.json', destinationAuth());
  vi.mocked(inspectCoreDatabase).mockImplementation(async (options) => {
    const source = (options.client as unknown as FakeClient).config.host === '/clean-target-source-socket';
    if (source) state.actualSourceAuth = options.authentication;
    else state.actualDestinationAuth = options.authentication;
    return {
      token: Object.freeze({}) as never,
      summary: {
        schema: 'orbis.core-database-snapshot.v1',
        sha256: (source ? '1' : '2').repeat(64),
        major: 17,
        catalogSha256: '3'.repeat(64),
        rows: {},
      },
    };
  });
  vi.mocked(prepareCoreCleanTarget).mockImplementation(async (options) => {
    const r = request();
    const descriptor = {
      schema: options.sequencePolicy
        ? ('orbis.core-clean-target-reconciliation.v2' as const)
        : ('orbis.core-clean-target-reconciliation.v1' as const),
      ...(options.sequencePolicy ? { sequencePolicy: options.sequencePolicy } : {}),
      id: options.id,
      nonce: options.nonce,
      sourceIdentity: { systemIdentifier: '7000000000000000001', databaseOid: '16384', database: 'captured' },
      destinationIdentity: { systemIdentifier: '7000000000000000002', databaseOid: '16384', database: 'destination' },
      targetIdentity: r.target,
      sourceSha256: '1'.repeat(64),
      destinationSha256: '2'.repeat(64),
      catalogSha256: '3'.repeat(64),
      authenticationSha256: digest(state.actualSourceAuth),
      sourceAccountsSha256: '7'.repeat(64),
      destinationAppsSha256: '8'.repeat(64),
      destinationRecoverySha256: '9'.repeat(64),
      sourceOwnerId: 11,
      destinationOwnerId: 11,
      catalogOwnershipSha256: '6'.repeat(64),
      catalogContext: 'pg_catalog' as const,
      major: 17,
      environmentProved: false as const,
      restoreAuthority: false as const,
    };
    const prepared = {
      ...descriptor,
      marker: `orbis.core-clean-target.${options.sequencePolicy ? 'v2' : 'v1'}/${options.id}/${options.nonce}/${digest(descriptor)}`,
    } as CoreCleanTargetReconciliation;
    state.mutation?.(prepared);
    await options.authorize(prepared);
    await state.beforeSql?.();
    state.sqlWrites += 1;
    await state.afterSql?.();
    await options.committed(prepared);
    return prepared;
  });
  vi.mocked(verifyCoreCleanTarget).mockResolvedValue(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.chmod(input, 0o700).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

it('requires a separate Root-sealed authorization and persists intent before any target write', async () => {
  state.beforeSql = async () => {
    expect(state.sqlWrites).toBe(0);
    expect(await outputNames()).toEqual(['worker-start.json', 'write-intent.json']);
    const intent = await result('write-intent.json');
    expect(intent).toMatchObject({
      schema: 'orbis.core-clean-target-write-intent.v1',
      requestSha256: digest(request()),
      authorizationSha256: digest(authorization()),
      rootPreparationSha256: request().rootPreparationSha256,
      rootIntentSha256: request().rootIntentSha256,
      scope: 'prepare-clean-target-only',
      activation: false,
      restoreAuthority: false,
    });
    expect((await fs.stat(path.join(output, 'write-intent.json'))).mode & 0o777).toBe(0o400);
  };
  const report = await prepareCoreCleanTargetWorker(options());
  expect(state.sqlWrites).toBe(1);
  expect(report).toMatchObject({
    schema: 'orbis.core-clean-target-worker-result.v1',
    targetVerified: true,
    activation: false,
    environmentProved: false,
    restoreAuthority: false,
    serverQuiescenceProved: false,
  });
  expect(await outputNames()).toEqual(['completion.json', 'result.json', 'worker-start.json', 'write-intent.json']);
  expect(await result('completion.json')).toMatchObject({ databaseCommitAcknowledged: true, targetVerified: false });
  expect(await result('result.json')).toEqual(report);
  for (const name of await outputNames()) {
    expect((await fs.stat(path.join(output, name))).mode & 0o777).toBe(0o400);
    const bytes = await fs.readFile(path.join(output, name), 'utf8');
    expect(bytes).not.toContain(sourceKey);
    expect(bytes).not.toContain(destinationKey);
    expect(bytes).toBe(canonicalCoreJson(JSON.parse(bytes)));
  }
  expect(state.clients).toHaveLength(3);
  expect(state.clients.every((client) => client.ended === 1)).toBe(true);
  expect(state.clients.map((client) => client.config.host)).toEqual([
    '/clean-target-source-socket',
    '/clean-target-destination-socket',
    '/clean-target-target-socket',
  ]);
  for (const [index, client] of state.clients.entries()) {
    expect(client.config).toMatchObject({
      password: '',
      ssl: false,
      port: 5432,
      connectionTimeoutMillis: 10000,
      query_timeout: 20000,
      statement_timeout: 15000,
    });
    expect(client.config.options).toContain(`default_transaction_read_only=${index < 2 ? 'on' : 'off'}`);
    expect(client.config.options).toContain('search_path=pg_catalog');
    expect(client.config.options).toContain('lock_timeout=5000');
    expect(client.config.types).toHaveProperty('getTypeParser');
  }
  expect(coreCleanTargetWorkerCapability).toMatchObject({
    operatingSystem: 'linux',
    uid: 0,
    scope: 'prepare-clean-target-only',
    restoreAuthority: false,
  });
});

it('accepts an owner-only sealed input directory and passes private auth only to row validators', async () => {
  const auth = { ...sourceAuth(), passkeys: { privateSyntheticCredential: 'never export fixture credential' } };
  await write('source-authentication.json', auth);
  const r = request();
  r.source.authenticationSha256 = digest(auth);
  await writeRequest(r);
  await fs.chmod(input, 0o500);
  await prepareCoreCleanTargetWorker(options());
  expect(state.actualSourceAuth).toEqual({ jwtSecret: sourceKey, passkeys: auth.passkeys });
  expect(state.actualDestinationAuth).toEqual({ jwtSecret: destinationKey });
  expect(JSON.stringify(await result('result.json'))).not.toContain('never export fixture credential');
  expect(state.clients.every((client) => !JSON.stringify(client.config).includes(sourceKey))).toBe(true);
});

it.each([
  'missing',
  'schema',
  'decision',
  'requestSha256',
  'id',
  'nonce',
  'target',
  'sourceSha256',
  'destinationSha256',
  'rootPreparationSha256',
  'rootIntentSha256',
  'catalogOwnershipSha256',
  'scope',
  'activation',
  'environmentProved',
  'restoreAuthority',
  'extra',
])('refuses independent authorization mismatch %s before opening SQL clients', async (field) => {
  const value: Record<string, unknown> = authorization();
  if (field === 'missing') await fs.unlink(path.join(input, 'authorization.json'));
  else {
    value[field] = field === 'target' ? { ...request().target, databaseOid: '16385' } : 'unapproved';
    await write('authorization.json', value);
  }
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow('Core clean target preparation failed.');
  expect(state.clients).toEqual([]);
  expect(await outputNames()).toEqual([]);
});

it.each([
  'schema',
  'id',
  'nonce',
  'rootPreparationSha256',
  'rootIntentSha256',
  'targetRole',
  'sourceOwnerId',
  'destinationOwnerId',
  'catalogOwnerIds',
  'scope',
  'activation',
  'environmentProved',
  'restoreAuthority',
  'extra-host',
])('rejects malformed or expanded request %s without writing', async (field) => {
  const r = request() as unknown as Record<string, unknown>;
  r[field] = 'invalid';
  await write('request.json', r);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.clients).toEqual([]);
  expect(state.sqlWrites).toBe(0);
  expect(await outputNames()).toEqual([]);
});

it.each(['role', 'database', 'snapshotSha256', 'authenticationSha256'])('rejects invalid endpoint %s', async (field) => {
  const r = request();
  Object.assign(r.source, { [field]: 'bad\n host=attacker' });
  await writeRequest(r);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.clients).toEqual([]);
});

it.each(['systemIdentifier', 'databaseOid', 'database'])('rejects malformed target identity %s', async (field) => {
  const r = request();
  Object.assign(r.target, { [field]: 'invalid/' });
  await writeRequest(r);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.clients).toEqual([]);
});

it.each(['request.json', 'authorization.json', 'source-authentication.json', 'destination-authentication.json'])(
  'requires canonical bytes and no duplicate keys for %s',
  async (name) => {
    const body = await fs.readFile(path.join(input, name), 'utf8');
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const key = Object.keys(parsed)[0] ?? 'schema';
    for (const candidate of [`${body}\n`, `${body.slice(0, -1)},${JSON.stringify(key)}:${JSON.stringify(parsed[key])}}`]) {
      await write(name, candidate, true);
      await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
    }
    expect(state.clients).toEqual([]);
  },
);

it.each(['source-authentication.json', 'destination-authentication.json'])('binds exact private %s bytes before connecting', async (name) => {
  await write(name, { jwtSecret: 'different synthetic secret longer than thirty-two characters', passkeys: null });
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.clients).toEqual([]);
});

it.each(['writable', 'shared', 'symlink', 'hardlink', 'directory'])('refuses %s authorization custody', async (attack) => {
  const file = path.join(input, 'authorization.json');
  if (attack === 'writable') await fs.chmod(file, 0o600);
  else if (attack === 'shared') await fs.chmod(file, 0o440);
  else {
    const outside = path.join(root, 'retained-authorization');
    await fs.rename(file, outside);
    if (attack === 'symlink') await fs.symlink(outside, file);
    if (attack === 'hardlink') await fs.link(outside, file);
    if (attack === 'directory') await fs.mkdir(file, { mode: 0o700 });
  }
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.clients).toEqual([]);
  expect(await outputNames()).toEqual([]);
});

it('rejects extra input, overlapping paths, shared directories, and nonempty output', async () => {
  await write('unexpected.json', {});
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  await fs.unlink(path.join(input, 'unexpected.json'));
  await expect(prepareCoreCleanTargetWorker({ ...options(), output: input })).rejects.toThrow();
  await fs.chmod(output, 0o755);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  await fs.chmod(output, 0o700);
  await fs.writeFile(path.join(output, 'retained'), 'preserve', { mode: 0o600 });
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(await fs.readFile(path.join(output, 'retained'), 'utf8')).toBe('preserve');
  expect(state.sqlWrites).toBe(0);
});

it.each(['contents', 'replacement', 'directory'])('rechecks sealed input %s before authorizing SQL writes', async (attack) => {
  let changed = false;
  state.connectHook = async () => {
    if (changed) return;
    changed = true;
    if (attack === 'contents') await write('authorization.json', authorization());
    if (attack === 'replacement') {
      const file = path.join(input, 'authorization.json');
      await fs.rename(file, path.join(root, 'old-authorization'));
      await write('authorization.json', authorization());
    }
    if (attack === 'directory') {
      await fs.rename(input, path.join(root, 'old-input'));
      await fs.mkdir(input, { mode: 0o700 });
    }
  };
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.sqlWrites).toBe(0);
  expect(await outputNames()).toEqual(['worker-start.json']);
});

it.each(['source', 'destination'] as const)('refuses actual %s snapshot mismatch before target preparation', async (side) => {
  const r = request();
  r[side].snapshotSha256 = 'f'.repeat(64);
  await writeRequest(r);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(prepareCoreCleanTarget).not.toHaveBeenCalled();
  expect(state.sqlWrites).toBe(0);
});

it('refuses a different migration ledger before target preparation', async () => {
  const r = request();
  r.expected.migrationsSha256 = 'f'.repeat(64);
  await writeRequest(r);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(prepareCoreCleanTarget).not.toHaveBeenCalled();
});

it('bounds input reads before connecting and rejects a foreign process owner', async () => {
  await write('request.json', 'x'.repeat(32769), true);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  await writeRequest(request());
  const owner = process.getuid?.() ?? -1;
  vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.clients).toEqual([]);
  expect(await outputNames()).toEqual([]);
});

it('rechecks the migration ledger during authorization before publishing write intent', async () => {
  state.mutation = () => {
    state.migrations = [{ id: 2, hash: 'changed-at-authorization', created_at: '1700000000000' }];
  };
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.sqlWrites).toBe(0);
  expect(await outputNames()).toEqual(['worker-start.json']);
});

it.each([
  'sourceSha256',
  'destinationSha256',
  'catalogSha256',
  'catalogOwnershipSha256',
  'authenticationSha256',
  'sourceOwnerId',
  'destinationOwnerId',
  'targetIdentity',
  'catalogContext',
  'environmentProved',
  'restoreAuthority',
  'schema',
])('refuses prepared receipt mismatch %s before durable write authorization', async (field) => {
  state.mutation = (value) => {
    value[field] = field === 'targetIdentity' ? { ...request().target, databaseOid: '16385' } : 'mismatch';
  };
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.sqlWrites).toBe(0);
  expect(await outputNames()).toEqual(['worker-start.json']);
});

it.each(['current_user', 'session_user', 'database', 'search_path', 'read_only'])(
  'refuses mismatched actual session %s before inspection',
  async (field) => {
    state.sessionHook = (_client, row) => {
      row[field] = 'wrong';
    };
    await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
    expect(inspectCoreDatabase).not.toHaveBeenCalled();
    expect(state.sqlWrites).toBe(0);
  },
);

it('retains a committed target and write intent if completion publication fails, without replay or cleanup', async () => {
  state.afterSql = async () => {
    await fs.writeFile(path.join(output, 'completion.json'), 'preserve foreign evidence', { mode: 0o400 });
  };
  const error = await prepareCoreCleanTargetWorker(options()).catch((error: unknown) => error);
  expect(coreCleanTargetFailureDiagnostic(error)).toMatchObject({ phase: 'commit', code: 'unknown' });
  expect(state.sqlWrites).toBe(1);
  expect(verifyCoreCleanTarget).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(output, 'completion.json'), 'utf8')).toBe('preserve foreign evidence');
  expect(await outputNames()).toEqual(['completion.json', 'worker-start.json', 'write-intent.json']);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.sqlWrites).toBe(1);
});

it('does not publish verified success after a target verification failure', async () => {
  vi.mocked(verifyCoreCleanTarget).mockRejectedValue(Object.assign(new Error(sourceKey), { code: '40001' }));
  const error = await prepareCoreCleanTargetWorker(options()).catch((error: unknown) => error);
  expect(coreCleanTargetFailureDiagnostic(error)).toEqual({ event: 'core-clean-target-failed', phase: 'verify', code: '40001' });
  expect(await outputNames()).toEqual(['completion.json', 'worker-start.json', 'write-intent.json']);
  expect(state.sqlWrites).toBe(1);
  expect(String(error)).not.toContain(sourceKey);
});

it('never overwrites or replays existing successful output', async () => {
  await prepareCoreCleanTargetWorker(options());
  const before = await fs.readFile(path.join(output, 'result.json'));
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(await fs.readFile(path.join(output, 'result.json'))).toEqual(before);
  expect(state.sqlWrites).toBe(1);
});

it.each(['28P01', '28P01 private credential', 'untrusted-code', 42501])(
  'only reports an exact allowlisted transport/SQLSTATE code %j',
  async (code) => {
    state.connectError = Object.assign(new Error(`password=${sourceKey}; /private/secret; SQL rows`), { code, stack: sourceKey });
    const error = await prepareCoreCleanTargetWorker(options()).catch((error: unknown) => error);
    expect(String(error)).toBe('Error: Core clean target preparation failed.');
    expect(coreCleanTargetFailureDiagnostic(error)).toEqual({
      event: 'core-clean-target-failed',
      phase: 'connect',
      code: code === '28P01' ? code : 'unknown',
    });
    expect(Object.keys(coreCleanTargetFailureDiagnostic(error))).toEqual(['event', 'phase', 'code']);
    expect(coreCleanTargetFailureDiagnostic(state.connectError)).toEqual({ event: 'core-clean-target-failed', phase: 'input', code: 'unknown' });
    expect(state.sqlWrites).toBe(0);
    expect(state.clients.every((client) => client.ended === 1)).toBe(true);
  },
);

it('closes clients on abort and preserves uncertain records without claiming server quiescence', async () => {
  const controller = new AbortController();
  state.beforeSql = async () => {
    controller.abort(new Error(sourceKey));
    controller.signal.throwIfAborted();
  };
  const error = await prepareCoreCleanTargetWorker({ ...options(), signal: controller.signal }).catch((error: unknown) => error);
  expect(coreCleanTargetFailureDiagnostic(error)).toMatchObject({ phase: 'prepare', code: 'unknown' });
  expect(state.sqlWrites).toBe(0);
  expect(state.clients.every((client) => client.ended === 1)).toBe(true);
  expect(await outputNames()).toEqual(['worker-start.json', 'write-intent.json']);
});

const requestV2 = () => ({
  ...request(),
  schema: 'orbis.core-clean-target-worker-input.v2',
  sourceControllerImageId: `sha256:${'a'.repeat(64)}`,
  sequencePolicy: {
    schema: 'orbis.core-clean-target-sequence-policy.v2',
    sourceControllerImageId: `sha256:${'a'.repeat(64)}`,
    catalogSha256: request().expected.catalogSha256,
  },
});
async function writeV2(r = requestV2()) {
  await write('request.json', r);
  await write('authorization.json', {
    ...authorization(r),
    schema: 'orbis.core-clean-target-authorization.v2',
    sourceControllerImageId: r.sourceControllerImageId,
    sequencePolicy: r.sequencePolicy,
  });
}

it('v2 passes only the separately approved image/catalog sequence policy and publishes versioned receipts', async () => {
  const r = requestV2();
  await writeV2(r);
  const report = await prepareCoreCleanTargetWorker(options());
  expect(vi.mocked(prepareCoreCleanTarget).mock.calls[0]?.[0].sequencePolicy).toEqual(r.sequencePolicy);
  expect(report).toMatchObject({
    schema: 'orbis.core-clean-target-worker-result.v2',
    sourceControllerImageId: r.sourceControllerImageId,
    sequencePolicy: r.sequencePolicy,
    prepared: { schema: 'orbis.core-clean-target-reconciliation.v2', sequencePolicy: r.sequencePolicy },
    restoreAuthority: false,
  });
  expect(await result('write-intent.json')).toMatchObject({ schema: 'orbis.core-clean-target-write-intent.v2', sequencePolicy: r.sequencePolicy });
  expect(coreCleanTargetWorkerCapabilityV2).toMatchObject({ requestSchema: r.schema, receiptSchema: 'orbis.core-clean-target-reconciliation.v2' });
  expect(coreCleanTargetWorkerCapability.requestSchema).toBe('orbis.core-clean-target-worker-input.v1');
  expect(Object.hasOwn(coreCleanTargetWorkerCapability, 'sequencePolicy')).toBe(false);
});

it.each(['image', 'catalog', 'policy-schema', 'extra-policy', 'v1-smuggle'])('refuses v2 request policy %s before connecting', async (attack) => {
  const r = requestV2();
  if (attack === 'image') r.sequencePolicy.sourceControllerImageId = `sha256:${'b'.repeat(64)}`;
  if (attack === 'catalog') r.sequencePolicy.catalogSha256 = 'f'.repeat(64);
  if (attack === 'policy-schema') r.sequencePolicy.schema = 'unsupported';
  if (attack === 'extra-policy') Object.assign(r.sequencePolicy, { inferredApproval: true });
  if (attack === 'v1-smuggle') r.schema = 'orbis.core-clean-target-worker-input.v1';
  await writeV2(r);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.clients).toEqual([]);
  expect(state.sqlWrites).toBe(0);
});

it.each(['schema', 'policy', 'image'])('refuses v2 independent authorization %s mismatch', async (attack) => {
  const r = requestV2();
  await writeV2(r);
  const auth: Record<string, unknown> = JSON.parse(await fs.readFile(path.join(input, 'authorization.json'), 'utf8'));
  if (attack === 'schema') auth.schema = 'orbis.core-clean-target-authorization.v1';
  if (attack === 'policy') auth.sequencePolicy = { ...r.sequencePolicy, catalogSha256: 'f'.repeat(64) };
  if (attack === 'image') auth.sourceControllerImageId = `sha256:${'b'.repeat(64)}`;
  await write('authorization.json', auth);
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.clients).toEqual([]);
  expect(state.sqlWrites).toBe(0);
});

it('refuses a v2 helper receipt with a different Root policy before authorizing SQL', async () => {
  await writeV2();
  state.mutation = (value) => {
    value.sequencePolicy = { ...requestV2().sequencePolicy, sourceControllerImageId: `sha256:${'b'.repeat(64)}` };
  };
  await expect(prepareCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(state.sqlWrites).toBe(0);
  expect(await outputNames()).toEqual(['worker-start.json']);
});

async function verificationInput() {
  await writeV2();
  await prepareCoreCleanTargetWorker(options());
  const intent = await result('write-intent.json');
  for (const name of await fs.readdir(output)) await fs.unlink(path.join(output, name));
  await fs.unlink(path.join(input, 'source-authentication.json'));
  await fs.unlink(path.join(input, 'destination-authentication.json'));
  await write('write-intent.json', intent);
  vi.clearAllMocks();
  state.clients = [];
  state.sqlWrites = 0;
  state.sessionHook = (_client, row) => {
    row.read_only = 'on';
  };
  return intent;
}

it('verifies the original committed target with a read-only target session and never replays preparation', async () => {
  const intent = await verificationInput();
  const report = await verifyCoreCleanTargetWorker(options());
  expect(report).toMatchObject({
    schema: 'orbis.core-clean-target-verification-result.v2',
    prepared: intent.prepared,
    databaseCommitObserved: true,
    targetVerified: true,
    activation: false,
    environmentProved: false,
    restoreAuthority: false,
    serverQuiescenceProved: false,
  });
  expect(report.writeIntentSha256).toBe(digest(intent));
  expect(await result('result.json')).toEqual(report);
  expect(await outputNames()).toEqual(['result.json']);
  expect(state.clients).toHaveLength(1);
  expect(state.clients[0]?.config).toMatchObject({
    host: '/clean-target-target-socket',
    options: expect.stringContaining('default_transaction_read_only=on'),
  });
  expect(state.clients[0]?.ended).toBe(1);
  expect(prepareCoreCleanTarget).not.toHaveBeenCalled();
  expect(inspectCoreDatabase).not.toHaveBeenCalled();
  expect(verifyCoreCleanTarget).toHaveBeenCalledTimes(1);
  expect(state.sqlWrites).toBe(0);
  expect(coreCleanTargetVerifyCapabilityV2).toMatchObject({ replayPreparation: false, mode: 'verify-committed-target-only' });
});

it.each(['nonce', 'target', 'policy', 'authorization', 'extra'])(
  'refuses verification with a substituted %s binding before connecting',
  async (attack) => {
    const intent = await verificationInput();
    if (attack === 'nonce') intent.nonce = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    if (attack === 'target') intent.prepared.targetIdentity.databaseOid = '99';
    if (attack === 'policy') intent.prepared.sequencePolicy.catalogSha256 = 'a'.repeat(64);
    if (attack === 'extra') intent.extra = 'unapproved';
    if (attack === 'authorization') await write('authorization.json', { ...authorization(), decision: 'denied' });
    await write('write-intent.json', intent);
    await expect(verifyCoreCleanTargetWorker(options())).rejects.toThrow();
    expect(state.clients).toHaveLength(0);
    expect(prepareCoreCleanTarget).not.toHaveBeenCalled();
    expect(await outputNames()).toEqual([]);
  },
);

it('leaves an absent or mismatched commit unresolved without a completion claim or insert retry', async () => {
  await verificationInput();
  vi.mocked(verifyCoreCleanTarget).mockRejectedValueOnce(new Error('synthetic missing commit marker'));
  await expect(verifyCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(await outputNames()).toEqual([]);
  expect(prepareCoreCleanTarget).not.toHaveBeenCalled();
  expect(state.sqlWrites).toBe(0);
  expect(state.clients[0]?.ended).toBe(1);
});

it('refuses a replaced original intent during target connection', async () => {
  const intent = await verificationInput();
  state.connectHook = async () => {
    await fs.rename(path.join(input, 'write-intent.json'), path.join(root, 'retained-intent.json'));
    await write('write-intent.json', intent);
  };
  await expect(verifyCoreCleanTargetWorker(options())).rejects.toThrow();
  expect(verifyCoreCleanTarget).not.toHaveBeenCalled();
  expect(prepareCoreCleanTarget).not.toHaveBeenCalled();
  expect(await outputNames()).toEqual([]);
});
