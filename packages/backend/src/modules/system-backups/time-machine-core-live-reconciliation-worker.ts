import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Client, types } from 'pg';
import { backupDatabaseLimits } from './backup-database-records';
import {
  type CoreCleanTargetIdentity,
  type CoreCleanTargetSequencePolicy,
  type CoreCleanTargetReconciliation,
  inspectCoreDatabase,
} from './time-machine-core-database';
import {
  observeCoreLiveDatabase,
  holdCoreLiveDatabase,
  reconcileCoreLiveDatabase,
  assertCoreLiveReconciliationHeld,
  type CoreLiveDatabaseFenceIntent,
  type CoreLiveReconciliationEvidence,
} from './time-machine-core-live-database-fence';
import { canonicalCoreJson } from './time-machine-core-payload';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(canonicalCoreJson(value));
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const fail = () => new Error('Core live reconciliation failed.');
const scope = 'reconcile-held-live-database-only' as const;
export const coreLiveReconciliationWorkerCapability = Object.freeze({
  schema: 'orbis.core-live-reconciliation-worker-capability.v1',
  requestSchema: 'orbis.core-live-reconciliation-worker-input.v1',
  authorizationSchema: 'orbis.core-live-reconciliation-authorization.v1',
  operatingSystem: 'linux',
  uid: 0,
  input: '/core-live-input',
  output: '/core-live-output',
  sourceSocket: '/core-live-source-socket',
  targetSocket: '/core-live-target-socket',
  port: 5432,
  deadlineMs: 300000,
  connectionTimeoutMs: 10000,
  statementTimeoutMs: 15000,
  queryTimeoutMs: 20000,
  lockTimeoutMs: 5000,
  rowCodec: 'pg-default-inspection-compatible.v1',
  scope,
  admissionReopened: false,
  rootMustVerifyRetiredFence: true,
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
});
type Phase = 'input' | 'connect' | 'inspect' | 'authorize' | 'hold' | 'reconcile' | 'commit' | 'verify' | 'output';
const codes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOENT',
  'EACCES',
  'EEXIST',
  '28000',
  '28P01',
  '3D000',
  '57P03',
  '25006',
  '42501',
  '42P01',
  '42703',
  '42883',
  '53300',
  '53200',
  '57014',
  '40001',
  '40P01',
  '55P03',
  'XX000',
]);
const failures = new WeakMap<object, { phase: Phase; code: string }>();
export function coreLiveReconciliationFailureDiagnostic(error: unknown) {
  const detail = error !== null && typeof error === 'object' ? failures.get(error) : undefined;
  return { event: 'core-live-reconciliation-failed' as const, phase: detail?.phase ?? 'input', code: detail?.code ?? 'unknown' };
}
function failure(error: unknown, phase: Phase) {
  let code = 'unknown';
  try {
    const candidate = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (typeof candidate === 'string' && codes.has(candidate)) code = candidate;
  } catch {
    code = 'unknown';
  }
  const result = fail();
  failures.set(result, { phase, code });
  return result;
}
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const same = (a: BigIntStats, b: BigIntStats) =>
  ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const sameDirectory = (a: BigIntStats, b: BigIntStats) =>
  ['dev', 'ino', 'mode', 'uid', 'gid'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
type Endpoint = { role: string; database: string; snapshotSha256: string; authenticationSha256: string };
type Identity = CoreLiveDatabaseFenceIntent['identity'];
type Request = {
  schema: 'orbis.core-live-reconciliation-worker-input.v1';
  id: string;
  nonce: string;
  rootIntentSha256: string;
  sourceControllerImageId: string;
  source: Endpoint;
  destination: { identity: Identity; address: string; postmasterEpochUs: string; authenticationSha256: string };
  target: { identity: CoreCleanTargetIdentity; role: string };
  expected: {
    catalogSha256: string;
    migrationsSha256: string;
    catalogOwnership: {
      schema: 'orbis.core-catalog-ownership-identities.v1';
      sourceOwnerId: number;
      destinationOwnerId: number;
      owners: { ownerId: number; identitySha256: string }[];
      aliases: false;
      restoreAuthority: false;
    };
  };
  sourceOwnerId: number;
  destinationOwnerId: number;
  catalogOwnerIds: number[];
  sequencePolicy: CoreCleanTargetSequencePolicy;
  scope: typeof scope;
  activation: false;
  environmentProved: false;
  restoreAuthority: false;
};
type Pinned = { name: string; handle: FileHandle; stat: BigIntStats; bytes: Buffer };
async function directory(directory: string, output = false) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || (await fs.realpath(directory)) !== directory) throw fail();
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid?.() ?? -1) || !(output ? [0o700n] : [0o500n, 0o700n]).includes(stat.mode & 0o7777n))
    throw fail();
  return stat;
}
async function read(directory: string, name: string, maximum: number): Promise<Pinned> {
  const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      stat.nlink !== 1n ||
      ![0o400n, 0o600n].includes(stat.mode & 0o7777n) ||
      stat.size < 1n ||
      stat.size > maximum
    )
      throw fail();
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw fail();
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) throw fail();
    if (
      BigInt(bytes.length) !== stat.size ||
      !same(stat, await handle.stat({ bigint: true })) ||
      !same(stat, await fs.lstat(path.join(directory, name), { bigint: true }))
    )
      throw fail();
    return { name, handle, stat, bytes };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function canonical(file: Pinned): unknown {
  const result: unknown = JSON.parse(file.bytes.toString('utf8'));
  if (canonicalCoreJson(result) !== file.bytes.toString('utf8')) throw fail();
  return result;
}
function validTarget(value: unknown): value is CoreCleanTargetIdentity {
  return (
    exact(value, ['systemIdentifier', 'databaseOid', 'database']) &&
    typeof value.database === 'string' &&
    identifier.test(value.database) &&
    typeof value.systemIdentifier === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value.systemIdentifier) &&
    BigInt(value.systemIdentifier) <= 18446744073709551615n &&
    typeof value.databaseOid === 'string' &&
    /^[1-9][0-9]{0,9}$/.test(value.databaseOid) &&
    BigInt(value.databaseOid) <= 4294967295n
  );
}
function validEndpoint(value: unknown): value is Endpoint {
  return (
    exact(value, ['role', 'database', 'snapshotSha256', 'authenticationSha256']) &&
    typeof value.role === 'string' &&
    identifier.test(value.role) &&
    typeof value.database === 'string' &&
    identifier.test(value.database) &&
    typeof value.snapshotSha256 === 'string' &&
    hex.test(value.snapshotSha256) &&
    typeof value.authenticationSha256 === 'string' &&
    hex.test(value.authenticationSha256)
  );
}
const positive = (value: unknown, maximum: bigint): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= maximum;
const oid = (value: unknown) => positive(value, 4294967295n);
const ipv4 = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.split('.').length === 4 &&
  value.split('.').every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
function requestFrom(file: Pinned): Request {
  const v = canonical(file);
  const owner = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0 && (x as number) <= 2147483647;
  if (
    !exact(v, [
      'schema',
      'id',
      'nonce',
      'rootIntentSha256',
      'sourceControllerImageId',
      'source',
      'destination',
      'target',
      'expected',
      'sourceOwnerId',
      'destinationOwnerId',
      'catalogOwnerIds',
      'sequencePolicy',
      'scope',
      'activation',
      'environmentProved',
      'restoreAuthority',
    ]) ||
    v.schema !== 'orbis.core-live-reconciliation-worker-input.v1' ||
    typeof v.id !== 'string' ||
    !uuid.test(v.id) ||
    typeof v.nonce !== 'string' ||
    !uuid.test(v.nonce) ||
    v.id === v.nonce ||
    typeof v.rootIntentSha256 !== 'string' ||
    !hex.test(v.rootIntentSha256) ||
    typeof v.sourceControllerImageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(v.sourceControllerImageId) ||
    !validEndpoint(v.source) ||
    !exact(v.destination, ['identity', 'address', 'postmasterEpochUs', 'authenticationSha256']) ||
    !ipv4(v.destination.address) ||
    !positive(v.destination.postmasterEpochUs, 9223372036854775807n) ||
    typeof v.destination.authenticationSha256 !== 'string' ||
    !hex.test(v.destination.authenticationSha256) ||
    !exact(v.destination.identity, ['systemIdentifier', 'database', 'databaseOid', 'role', 'roleOid', 'serverVersionNum']) ||
    !positive(v.destination.identity.systemIdentifier, 18446744073709551615n) ||
    !oid(v.destination.identity.databaseOid) ||
    !oid(v.destination.identity.roleOid) ||
    typeof v.destination.identity.database !== 'string' ||
    !identifier.test(v.destination.identity.database) ||
    ['postgres', 'template0', 'template1'].includes(v.destination.identity.database) ||
    typeof v.destination.identity.role !== 'string' ||
    !identifier.test(v.destination.identity.role) ||
    !Number.isSafeInteger(v.destination.identity.serverVersionNum) ||
    ![14, 17].includes(Math.floor((v.destination.identity.serverVersionNum as number) / 10000)) ||
    !exact(v.target, ['identity', 'role']) ||
    !validTarget(v.target.identity) ||
    typeof v.target.role !== 'string' ||
    !identifier.test(v.target.role) ||
    v.target.identity.systemIdentifier === v.destination.identity.systemIdentifier ||
    !exact(v.expected, ['catalogSha256', 'migrationsSha256', 'catalogOwnership']) ||
    ![v.expected.catalogSha256, v.expected.migrationsSha256].every((x) => typeof x === 'string' && hex.test(x)) ||
    !exact(v.expected.catalogOwnership, ['schema', 'sourceOwnerId', 'destinationOwnerId', 'owners', 'aliases', 'restoreAuthority']) ||
    v.expected.catalogOwnership.schema !== 'orbis.core-catalog-ownership-identities.v1' ||
    v.expected.catalogOwnership.sourceOwnerId !== v.sourceOwnerId ||
    v.expected.catalogOwnership.destinationOwnerId !== v.destinationOwnerId ||
    v.expected.catalogOwnership.aliases !== false ||
    v.expected.catalogOwnership.restoreAuthority !== false ||
    !Array.isArray(v.expected.catalogOwnership.owners) ||
    v.expected.catalogOwnership.owners.length < 1 ||
    v.expected.catalogOwnership.owners.length > 4096 ||
    v.expected.catalogOwnership.owners.some(
      (x, i, a) =>
        !exact(x, ['ownerId', 'identitySha256']) ||
        !owner(x.ownerId) ||
        typeof x.identitySha256 !== 'string' ||
        !hex.test(x.identitySha256) ||
        (i > 0 && x.ownerId <= a[i - 1].ownerId),
    ) ||
    !exact(v.sequencePolicy, ['schema', 'sourceControllerImageId', 'catalogSha256']) ||
    v.sequencePolicy.schema !== 'orbis.core-clean-target-sequence-policy.v2' ||
    v.sequencePolicy.sourceControllerImageId !== v.sourceControllerImageId ||
    v.sequencePolicy.catalogSha256 !== v.expected.catalogSha256 ||
    !owner(v.sourceOwnerId) ||
    !owner(v.destinationOwnerId) ||
    !Array.isArray(v.catalogOwnerIds) ||
    v.catalogOwnerIds.length > 4096 ||
    v.catalogOwnerIds.some((x, i, a) => !owner(x) || (i > 0 && x <= a[i - 1])) ||
    v.scope !== scope ||
    v.activation !== false ||
    v.environmentProved !== false ||
    v.restoreAuthority !== false
  )
    throw fail();
  return v as Request;
}
function requireAuthorization(file: Pinned, request: Request, requestSha256: string) {
  const v = canonical(file);
  if (
    !exact(v, [
      'schema',
      'decision',
      'id',
      'nonce',
      'requestSha256',
      'rootIntentSha256',
      'controllerStopped',
      'queueDrained',
      'scope',
      'activation',
      'environmentProved',
      'restoreAuthority',
    ]) ||
    v.schema !== 'orbis.core-live-reconciliation-authorization.v1' ||
    v.decision !== 'approved' ||
    v.id !== request.id ||
    v.nonce !== request.nonce ||
    v.requestSha256 !== requestSha256 ||
    v.rootIntentSha256 !== request.rootIntentSha256 ||
    v.controllerStopped !== true ||
    v.queueDrained !== true ||
    v.scope !== scope ||
    v.activation !== false ||
    v.environmentProved !== false ||
    v.restoreAuthority !== false
  )
    throw fail();
}
function connection(file: Pinned, request: Request) {
  const v = canonical(file);
  if (
    !exact(v, ['host', 'port', 'user', 'password', 'database']) ||
    v.host !== request.destination.address ||
    v.port !== 5432 ||
    v.user !== request.destination.identity.role ||
    v.database !== request.destination.identity.database ||
    typeof v.password !== 'string' ||
    v.password.length < 1 ||
    Buffer.byteLength(v.password) > 4096 ||
    /[\r\n\0]/.test(v.password)
  )
    throw fail();
  return v.password;
}
function authentication(file: Pinned, expected: string) {
  if (hash(file.bytes) !== expected) throw fail();
  const value = canonical(file);
  if (!exact(value, ['jwtSecret', 'passkeys']) || typeof value.jwtSecret !== 'string' || value.jwtSecret.length < 32 || value.jwtSecret.length > 4096)
    throw fail();
  return { jwtSecret: value.jwtSecret, ...(value.passkeys !== null ? { passkeys: value.passkeys } : {}) };
}
async function session(client: Client, role: string, database: string, readOnly: boolean) {
  const result = await client.query(`SELECT CURRENT_USER AS current_user,SESSION_USER AS session_user,pg_catalog.current_database() AS database,
    pg_catalog.current_setting('search_path') AS search_path,pg_catalog.current_setting('default_transaction_read_only') AS read_only`);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !exact(row, ['current_user', 'session_user', 'database', 'search_path', 'read_only']) ||
    row.current_user !== role ||
    row.session_user !== role ||
    row.database !== database ||
    row.search_path !== 'pg_catalog' ||
    row.read_only !== (readOnly ? 'on' : 'off')
  )
    throw fail();
}
async function migrations(client: Client, expected: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const result = await client.query(`SELECT * FROM drizzle.__drizzle_migrations LIMIT ${backupDatabaseLimits.rows + 1}`);
  if (result.rows.length > backupDatabaseLimits.rows || Buffer.byteLength(canonicalCoreJson(result.rows)) > backupDatabaseLimits.totalBytes)
    throw fail();
  result.rows.sort((a, b) => canonicalCoreJson(a).localeCompare(canonicalCoreJson(b), 'en'));
  if (digest(result.rows) !== expected) throw fail();
}

async function tcpBinding(client: Client, request: Request) {
  const result = await client.query(`SELECT pg_catalog.host(pg_catalog.inet_server_addr()) AS address,
    pg_catalog.inet_server_port() AS port,pg_catalog.current_setting('server_version_num')::integer AS version,
    (EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())*1000000)::bigint::text AS epoch`);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !exact(row, ['address', 'port', 'version', 'epoch']) ||
    row.address !== request.destination.address ||
    row.port !== 5432 ||
    row.version !== request.destination.identity.serverVersionNum ||
    row.epoch !== request.destination.postmasterEpochUs
  )
    throw fail();
}
async function targetIdentity(client: Client, request: Request) {
  const result = await client.query(`SELECT c.system_identifier::text AS "systemIdentifier",d.oid::text AS "databaseOid",d.datname AS database
    FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() c WHERE d.datname=pg_catalog.current_database()`);
  if (result.rows.length !== 1 || canonicalCoreJson(result.rows[0]) !== canonicalCoreJson(request.target.identity)) throw fail();
}

/** Root attests controller and queue shutdown independently. Closing this process never reopens admission. */
export async function reconcileCoreLiveDatabaseWorker(options: { input: string; output: string; signal: AbortSignal }) {
  let phase: Phase = 'input';
  const pinned: Pinned[] = [];
  const published: Pinned[] = [];
  const clients: Client[] = [];
  const endings = new Map<Client, Promise<void>>();
  const broken = new Set<Client>();
  const close = async () => {
    const results = await Promise.allSettled(
      clients.map((client) => {
        let ending = endings.get(client);
        if (!ending) {
          ending = Promise.resolve().then(() => client.end());
          endings.set(client, ending);
        }
        return ending;
      }),
    );
    if (results.some((result) => result.status !== 'fulfilled')) throw fail();
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.signal.throwIfAborted();
    const inputStat = await directory(options.input);
    const outputStat = await directory(options.output, true);
    if (
      (inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) ||
      options.input === options.output ||
      options.input.startsWith(`${options.output}/`) ||
      options.output.startsWith(`${options.input}/`) ||
      (await fs.readdir(options.output)).length
    )
      throw fail();
    const names = ['request.json', 'authorization.json', 'connection.json', 'source-authentication.json', 'destination-authentication.json'];
    if ((await fs.readdir(options.input)).sort().join(',') !== [...names].sort().join(',')) throw fail();
    for (const name of names)
      pinned.push(
        await read(options.input, name, name.endsWith('authentication.json') ? 2 * 1024 * 1024 : name === 'request.json' ? 1048576 : 65536),
      );
    const [manifest, authorization, connectionFile, sourceFile, destinationFile] = pinned;
    if (!manifest || !authorization || !connectionFile || !sourceFile || !destinationFile) throw fail();
    const request = requestFrom(manifest);
    const requestSha256 = hash(manifest.bytes);
    requireAuthorization(authorization, request, requestSha256);
    const password = connection(connectionFile, request);
    const sourceAuth = authentication(sourceFile, request.source.authenticationSha256);
    const destinationAuth = authentication(destinationFile, request.destination.authenticationSha256);
    const unchanged = async () => {
      options.signal.throwIfAborted();
      if (
        broken.size ||
        !same(inputStat, await directory(options.input)) ||
        !sameDirectory(outputStat, await directory(options.output, true)) ||
        (await fs.readdir(options.input)).sort().join(',') !== [...names].sort().join(',') ||
        (await fs.readdir(options.output)).sort().join(',') !==
          published
            .map((f) => f.name)
            .sort()
            .join(',')
      )
        throw fail();
      for (const file of [...pinned, ...published]) {
        const parent = pinned.includes(file) ? options.input : options.output;
        if (
          !same(file.stat, await file.handle.stat({ bigint: true })) ||
          !same(file.stat, await fs.lstat(path.join(parent, file.name), { bigint: true }))
        )
          throw fail();
      }
      requireAuthorization(authorization, request, requestSha256);
    };
    const write = async (name: string, value: unknown) => {
      await unchanged();
      const body = canonicalCoreJson(value);
      if (Buffer.byteLength(body) > 65536) throw fail();
      const handle = await fs.open(
        path.join(options.output, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      let stat: BigIntStats;
      try {
        await handle.writeFile(body);
        await handle.chmod(0o400);
        await handle.sync();
        stat = await handle.stat({ bigint: true });
      } finally {
        await handle.close();
      }
      const file = await read(options.output, name, 65536);
      published.push(file);
      if (!same(stat, file.stat) || !file.bytes.equals(Buffer.from(body)) || (file.stat.mode & 0o7777n) !== 0o400n) throw fail();
      const parent = await fs.open(options.output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!sameDirectory(outputStat, await parent.stat({ bigint: true }))) throw fail();
        await parent.sync();
      } finally {
        await parent.close();
      }
      await unchanged();
      return hash(body);
    };
    const bound = {
      id: request.id,
      nonce: request.nonce,
      requestSha256,
      authorizationSha256: hash(authorization.bytes),
      rootIntentSha256: request.rootIntentSha256,
      scope,
      activation: false as const,
      environmentProved: false as const,
      restoreAuthority: false as const,
    };
    await write('worker-start.json', { schema: 'orbis.core-live-reconciliation-start.v1', ...bound });
    const connect = (host: string, role: string, database: string, readOnly: boolean, secret = '') => {
      const client = new Client({
        host,
        port: 5432,
        user: role,
        database,
        password: secret,
        ssl: false,
        types,
        application_name: 'orbis-core-live-reconciliation',
        connectionTimeoutMillis: 10000,
        query_timeout: 20000,
        statement_timeout: 15000,
        options: `-c search_path=pg_catalog -c default_transaction_read_only=${readOnly ? 'on' : 'off'} -c session_preload_libraries= -c local_preload_libraries= -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000`,
      });
      client.on('error', () => {
        broken.add(client);
      });
      clients.push(client);
      return client;
    };
    const source = connect(coreLiveReconciliationWorkerCapability.sourceSocket, request.source.role, request.source.database, true);
    const live = connect(request.destination.address, request.destination.identity.role, request.destination.identity.database, true, password);
    const maintenance = connect(request.destination.address, request.destination.identity.role, 'postgres', false, password);
    const target = connect(coreLiveReconciliationWorkerCapability.targetSocket, request.target.role, request.target.identity.database, false);
    phase = 'connect';
    for (const client of clients) {
      options.signal.throwIfAborted();
      await client.connect();
    }
    const sessions = async () => {
      await session(source, request.source.role, request.source.database, true);
      await session(live, request.destination.identity.role, request.destination.identity.database, true);
      await session(maintenance, request.destination.identity.role, 'postgres', false);
      await session(target, request.target.role, request.target.identity.database, false);
      await tcpBinding(live, request);
      await tcpBinding(maintenance, request);
      await targetIdentity(target, request);
      await unchanged();
    };
    await sessions();
    phase = 'inspect';
    const inspectedSource = await inspectCoreDatabase({ client: source, authentication: sourceAuth, signal: options.signal });
    if (inspectedSource.summary.sha256 !== request.source.snapshotSha256 || inspectedSource.summary.catalogSha256 !== request.expected.catalogSha256)
      throw fail();
    await migrations(source, request.expected.migrationsSha256, options.signal);
    await migrations(target, request.expected.migrationsSha256, options.signal);
    const observation = await observeCoreLiveDatabase({ live, maintenance, expected: request.destination.identity, signal: options.signal });
    let fence: Readonly<CoreLiveDatabaseFenceIntent> | undefined;
    let fenceIntentSha256: string | undefined;
    const verifyFence = async (intent: Readonly<CoreLiveDatabaseFenceIntent>) => {
      await unchanged();
      if (!fence || !fenceIntentSha256 || canonicalCoreJson(intent) !== canonicalCoreJson(fence)) throw fail();
    };
    phase = 'hold';
    const held = await holdCoreLiveDatabase({
      observation,
      id: request.id,
      nonce: request.nonce,
      rootIntentSha256: request.rootIntentSha256,
      signal: options.signal,
      journal: {
        persist: async (intent) => {
          await sessions();
          if (
            fence ||
            intent.id !== request.id ||
            intent.nonce !== request.nonce ||
            intent.rootIntentSha256 !== request.rootIntentSha256 ||
            canonicalCoreJson(intent.identity) !== canonicalCoreJson(request.destination.identity)
          )
            throw fail();
          fence = structuredClone(intent);
          fenceIntentSha256 = await write('fence-intent.json', { schema: 'orbis.core-live-reconciliation-fence-intent.v1', ...bound, fence: intent });
        },
        verify: verifyFence,
      },
    });
    let authorizedSha256: string | undefined;
    let evidenceSha256: string | undefined;
    let writeIntentSha256: string | undefined;
    let completed = false;
    const checkBinding = (prepared: CoreCleanTargetReconciliation, evidence: CoreLiveReconciliationEvidence) => {
      if (
        !fence ||
        !fenceIntentSha256 ||
        prepared.schema !== 'orbis.core-clean-target-reconciliation.v2' ||
        prepared.id !== request.id ||
        prepared.nonce !== request.nonce ||
        prepared.sourceSha256 !== request.source.snapshotSha256 ||
        prepared.catalogSha256 !== request.expected.catalogSha256 ||
        prepared.catalogOwnershipSha256 !==
          digest({
            schema: 'orbis.core-catalog-ownership-compatibility.v1',
            sourceSha256: request.source.snapshotSha256,
            destinationSha256: prepared.destinationSha256,
            sourceOwnerId: request.sourceOwnerId,
            destinationOwnerId: request.destinationOwnerId,
            owners: request.expected.catalogOwnership.owners,
            aliases: false,
            restoreAuthority: false,
          }) ||
        prepared.authenticationSha256 !== digest(sourceAuth) ||
        prepared.sourceIdentity.database !== request.source.database ||
        canonicalCoreJson(prepared.targetIdentity) !== canonicalCoreJson(request.target.identity) ||
        canonicalCoreJson(prepared.sequencePolicy) !== canonicalCoreJson(request.sequencePolicy) ||
        prepared.sourceOwnerId !== request.sourceOwnerId ||
        prepared.destinationOwnerId !== request.destinationOwnerId ||
        prepared.catalogContext !== 'pg_catalog' ||
        prepared.environmentProved !== false ||
        prepared.restoreAuthority !== false ||
        prepared.destinationIdentity.systemIdentifier !== request.destination.identity.systemIdentifier ||
        prepared.destinationIdentity.databaseOid !== request.destination.identity.databaseOid ||
        prepared.destinationIdentity.database !== request.destination.identity.database ||
        evidence.schema !== 'orbis.core-live-target-reconciliation.v1' ||
        evidence.id !== request.id ||
        evidence.nonce !== request.nonce ||
        evidence.rootIntentSha256 !== request.rootIntentSha256 ||
        evidence.fenceIntentSha256 !== digest(fence) ||
        evidence.preparedSha256 !== digest(prepared) ||
        evidence.destinationSha256 !== prepared.destinationSha256 ||
        evidence.destinationEvidence !== 'held-live-database' ||
        evidence.activation !== false ||
        evidence.environmentProved !== false ||
        evidence.restoreAuthority !== false
      )
        throw fail();
    };
    const verify = async (prepared: CoreCleanTargetReconciliation, evidence: CoreLiveReconciliationEvidence) => {
      checkBinding(prepared, evidence);
      if (!authorizedSha256 || !evidenceSha256 || !writeIntentSha256 || digest(prepared) !== authorizedSha256 || digest(evidence) !== evidenceSha256)
        throw fail();
      await sessions();
      await migrations(source, request.expected.migrationsSha256, options.signal);
      await migrations(target, request.expected.migrationsSha256, options.signal);
    };
    phase = 'reconcile';
    const reconciliation = await reconcileCoreLiveDatabase({
      held,
      id: request.id,
      nonce: request.nonce,
      source: inspectedSource.token,
      destinationAuthentication: destinationAuth,
      sourceOwnerId: request.sourceOwnerId,
      destinationOwnerId: request.destinationOwnerId,
      catalogOwnerIds: request.catalogOwnerIds,
      target,
      sequencePolicy: request.sequencePolicy,
      signal: options.signal,
      authorize: async (prepared, evidence) => {
        phase = 'authorize';
        checkBinding(prepared, evidence);
        if (authorizedSha256) throw fail();
        await sessions();
        await migrations(source, request.expected.migrationsSha256, options.signal);
        await migrations(target, request.expected.migrationsSha256, options.signal);
        writeIntentSha256 = await write('write-intent.json', {
          schema: 'orbis.core-live-reconciliation-write-intent.v1',
          ...bound,
          fenceIntentSha256,
          prepared,
          evidence,
        });
        authorizedSha256 = digest(prepared);
        evidenceSha256 = digest(evidence);
        phase = 'reconcile';
      },
      committed: async (prepared, evidence) => {
        phase = 'commit';
        await verify(prepared, evidence);
        if (completed) throw fail();
        await write('completion.json', {
          schema: 'orbis.core-live-reconciliation-completion.v1',
          ...bound,
          writeIntentSha256,
          preparedSha256: digest(prepared),
          databaseCommitAcknowledged: true,
          targetVerified: false,
        });
        completed = true;
      },
      verify,
    });
    phase = 'verify';
    if (!completed || !writeIntentSha256 || !fenceIntentSha256) throw fail();
    await assertCoreLiveReconciliationHeld(reconciliation.token, options.signal);
    await unchanged();
    await close();
    await unchanged();
    phase = 'output';
    const report = {
      schema: 'orbis.core-live-reconciliation-result.v1',
      ...bound,
      fenceIntentSha256,
      writeIntentSha256,
      prepared: reconciliation.prepared,
      evidence: reconciliation.evidence,
      targetVerified: true,
      admissionReopened: false,
      rootMustVerifyRetiredFence: true,
    };
    await write('result.json', report);
    return report;
  } catch (error) {
    throw failure(error, phase);
  } finally {
    options.signal.removeEventListener('abort', abort);
    await close().catch(() => undefined);
    for (const file of [...pinned, ...published]) {
      file.bytes.fill(0);
      await file.handle.close().catch(() => undefined);
    }
  }
}
