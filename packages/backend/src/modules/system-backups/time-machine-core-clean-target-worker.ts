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
  prepareCoreCleanTarget,
  verifyCoreCleanTarget,
} from './time-machine-core-database';
import { canonicalCoreJson } from './time-machine-core-payload';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(canonicalCoreJson(value));
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const fail = () => new Error('Core clean target preparation failed.');
const scope = 'prepare-clean-target-only' as const;
export const coreCleanTargetWorkerCapability = Object.freeze({
  schema: 'orbis.core-clean-target-worker-capability.v1',
  requestSchema: 'orbis.core-clean-target-worker-input.v1',
  authorizationSchema: 'orbis.core-clean-target-authorization.v1',
  operatingSystem: 'linux',
  uid: 0,
  input: '/clean-target-input',
  output: '/clean-target-output',
  sourceSocket: '/clean-target-source-socket',
  destinationSocket: '/clean-target-destination-socket',
  targetSocket: '/clean-target-target-socket',
  port: 5432,
  deadlineMs: 300000,
  connectionTimeoutMs: 10000,
  statementTimeoutMs: 15000,
  queryTimeoutMs: 20000,
  lockTimeoutMs: 5000,
  rowCodec: 'pg-default-inspection-compatible.v1',
  inputAuthority: 'independently-sealed-root-authorization-required',
  scope,
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
});
export const coreCleanTargetWorkerCapabilityV2 = Object.freeze({
  ...coreCleanTargetWorkerCapability,
  schema: 'orbis.core-clean-target-worker-capability.v2',
  requestSchema: 'orbis.core-clean-target-worker-input.v2',
  authorizationSchema: 'orbis.core-clean-target-authorization.v2',
  receiptSchema: 'orbis.core-clean-target-reconciliation.v2',
  sequencePolicy: 'orbis.core-clean-target-sequence-policy.v2',
});
export const coreCleanTargetVerifyCapabilityV2 = Object.freeze({
  ...coreCleanTargetWorkerCapabilityV2,
  schema: 'orbis.core-clean-target-verify-capability.v2',
  mode: 'verify-committed-target-only',
  input: '/clean-target-verify-input',
  output: '/clean-target-verify-output',
  resultSchema: 'orbis.core-clean-target-verification-result.v2',
  replayPreparation: false,
});
type Phase = 'input' | 'connect' | 'inspect' | 'authorize' | 'prepare' | 'commit' | 'verify' | 'output';
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
export function coreCleanTargetFailureDiagnostic(error: unknown) {
  const detail = error !== null && typeof error === 'object' ? failures.get(error) : undefined;
  return { event: 'core-clean-target-failed' as const, phase: detail?.phase ?? 'input', code: detail?.code ?? 'unknown' };
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
type RequestV1 = {
  schema: 'orbis.core-clean-target-worker-input.v1';
  id: string;
  nonce: string;
  rootPreparationSha256: string;
  rootIntentSha256: string;
  source: Endpoint;
  destination: Endpoint;
  target: CoreCleanTargetIdentity;
  targetRole: string;
  expected: { catalogSha256: string; migrationsSha256: string; catalogOwnershipSha256: string };
  sourceOwnerId: number;
  destinationOwnerId: number;
  catalogOwnerIds: number[];
  scope: typeof scope;
  activation: false;
  environmentProved: false;
  restoreAuthority: false;
};
type Request =
  | RequestV1
  | (Omit<RequestV1, 'schema'> & {
      schema: 'orbis.core-clean-target-worker-input.v2';
      sourceControllerImageId: string;
      sequencePolicy: CoreCleanTargetSequencePolicy;
    });
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
      (stat.mode & 0o7777n) !== 0o400n ||
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
function requestFrom(file: Pinned): Request {
  const value = canonical(file);
  const v2 = value !== null && typeof value === 'object' && Reflect.get(value, 'schema') === 'orbis.core-clean-target-worker-input.v2';
  const owner = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2147483647;
  if (
    !exact(value, [
      'schema',
      'id',
      'nonce',
      'rootPreparationSha256',
      'rootIntentSha256',
      'source',
      'destination',
      'target',
      'targetRole',
      'expected',
      'sourceOwnerId',
      'destinationOwnerId',
      'catalogOwnerIds',
      'scope',
      'activation',
      'environmentProved',
      'restoreAuthority',
      ...(v2 ? ['sourceControllerImageId', 'sequencePolicy'] : []),
    ]) ||
    value.schema !== (v2 ? 'orbis.core-clean-target-worker-input.v2' : 'orbis.core-clean-target-worker-input.v1') ||
    typeof value.id !== 'string' ||
    !uuid.test(value.id) ||
    typeof value.nonce !== 'string' ||
    !uuid.test(value.nonce) ||
    ![value.rootPreparationSha256, value.rootIntentSha256].every((item) => typeof item === 'string' && hex.test(item)) ||
    !validEndpoint(value.source) ||
    !validEndpoint(value.destination) ||
    !validTarget(value.target) ||
    typeof value.targetRole !== 'string' ||
    !identifier.test(value.targetRole) ||
    !exact(value.expected, ['catalogSha256', 'migrationsSha256', 'catalogOwnershipSha256']) ||
    !Object.values(value.expected).every((item) => typeof item === 'string' && hex.test(item)) ||
    (v2 &&
      (!exact(value.sequencePolicy, ['schema', 'sourceControllerImageId', 'catalogSha256']) ||
        value.sequencePolicy.schema !== 'orbis.core-clean-target-sequence-policy.v2' ||
        typeof value.sourceControllerImageId !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(value.sourceControllerImageId) ||
        value.sequencePolicy.sourceControllerImageId !== value.sourceControllerImageId ||
        value.sequencePolicy.catalogSha256 !== value.expected.catalogSha256)) ||
    !owner(value.sourceOwnerId) ||
    !owner(value.destinationOwnerId) ||
    !Array.isArray(value.catalogOwnerIds) ||
    value.catalogOwnerIds.length > 4096 ||
    value.catalogOwnerIds.some((item, index, values) => !owner(item) || (index > 0 && item <= values[index - 1])) ||
    value.scope !== scope ||
    value.activation !== false ||
    value.environmentProved !== false ||
    value.restoreAuthority !== false
  )
    throw fail();
  return value as Request;
}
function requireAuthorization(file: Pinned, request: Request, requestSha256: string) {
  const value = canonical(file);
  const v2 = request.schema === 'orbis.core-clean-target-worker-input.v2';
  if (
    !exact(value, [
      'schema',
      'decision',
      'id',
      'nonce',
      'requestSha256',
      'rootPreparationSha256',
      'rootIntentSha256',
      'sourceSha256',
      'destinationSha256',
      'target',
      'catalogOwnershipSha256',
      'scope',
      'activation',
      'environmentProved',
      'restoreAuthority',
      ...(v2 ? ['sourceControllerImageId', 'sequencePolicy'] : []),
    ]) ||
    value.schema !== (v2 ? 'orbis.core-clean-target-authorization.v2' : 'orbis.core-clean-target-authorization.v1') ||
    value.decision !== 'approved' ||
    value.id !== request.id ||
    value.nonce !== request.nonce ||
    value.requestSha256 !== requestSha256 ||
    value.rootPreparationSha256 !== request.rootPreparationSha256 ||
    value.rootIntentSha256 !== request.rootIntentSha256 ||
    value.sourceSha256 !== request.source.snapshotSha256 ||
    value.destinationSha256 !== request.destination.snapshotSha256 ||
    !validTarget(value.target) ||
    canonicalCoreJson(value.target) !== canonicalCoreJson(request.target) ||
    value.catalogOwnershipSha256 !== request.expected.catalogOwnershipSha256 ||
    (v2 &&
      (value.sourceControllerImageId !== request.sourceControllerImageId ||
        canonicalCoreJson(value.sequencePolicy) !== canonicalCoreJson(request.sequencePolicy))) ||
    value.scope !== scope ||
    value.activation !== false ||
    value.environmentProved !== false ||
    value.restoreAuthority !== false
  )
    throw fail();
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

/** Root must qualify/pin code, socket mounts, target creation/migrations and stable inputs independently.
 * The CLI fixes all mount paths. Input files require a Root-owned read-only mount; outputs never grant activation. */
export async function prepareCoreCleanTargetWorker(options: { input: string; output: string; signal: AbortSignal }) {
  let phase: Phase = 'input';
  const pinned: Pinned[] = [];
  const clients: Client[] = [];
  const endings = new Map<Client, Promise<void>>();
  const close = () =>
    Promise.all(
      clients.map((client) => {
        let ending = endings.get(client);
        if (!ending) {
          ending = Promise.resolve()
            .then(() => client.end())
            .catch(() => undefined);
          endings.set(client, ending);
        }
        return ending;
      }),
    );
  const abort = () => {
    void close();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.signal.throwIfAborted();
    const inputStat = await directory(options.input);
    const outputStat = await directory(options.output, true);
    if (
      options.input === options.output ||
      options.input.startsWith(`${options.output}/`) ||
      options.output.startsWith(`${options.input}/`) ||
      (await fs.readdir(options.output)).length
    )
      throw fail();
    for (const [name, maximum] of [
      ['request.json', 32768],
      ['authorization.json', 32768],
      ['source-authentication.json', 2 * 1024 * 1024],
      ['destination-authentication.json', 2 * 1024 * 1024],
    ] as const)
      pinned.push(await read(options.input, name, maximum));
    const [manifest, authorization, sourceFile, destinationFile] = pinned;
    if (!manifest || !authorization || !sourceFile || !destinationFile) throw fail();
    const request = requestFrom(manifest);
    const v2 = request.schema === 'orbis.core-clean-target-worker-input.v2';
    const requestSha256 = hash(manifest.bytes);
    requireAuthorization(authorization, request, requestSha256);
    const sourceAuth = authentication(sourceFile, request.source.authenticationSha256);
    const destinationAuth = authentication(destinationFile, request.destination.authenticationSha256);
    const expectedInput = pinned
      .map((file) => file.name)
      .sort()
      .join(',');
    const published = new Map<string, BigIntStats>();
    const unchanged = async () => {
      options.signal.throwIfAborted();
      if (
        !same(inputStat, await directory(options.input)) ||
        !sameDirectory(outputStat, await directory(options.output, true)) ||
        (await fs.readdir(options.input)).sort().join(',') !== expectedInput ||
        (await fs.readdir(options.output)).sort().join(',') !== [...published.keys()].sort().join(',')
      )
        throw fail();
      for (const file of pinned)
        if (
          !same(file.stat, await file.handle.stat({ bigint: true })) ||
          !same(file.stat, await fs.lstat(path.join(options.input, file.name), { bigint: true }))
        )
          throw fail();
      for (const [name, stat] of published) if (!same(stat, await fs.lstat(path.join(options.output, name), { bigint: true }))) throw fail();
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
      try {
        await handle.writeFile(body);
        await handle.chmod(0o400);
        await handle.sync();
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.uid !== BigInt(process.getuid?.() ?? -1) || stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o400n) throw fail();
        published.set(name, stat);
      } finally {
        await handle.close();
      }
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
      rootPreparationSha256: request.rootPreparationSha256,
      rootIntentSha256: request.rootIntentSha256,
      scope,
      activation: false as const,
      environmentProved: false as const,
      restoreAuthority: false as const,
      ...(v2 ? { sourceControllerImageId: request.sourceControllerImageId, sequencePolicy: request.sequencePolicy } : {}),
    };
    await unchanged();
    await write('worker-start.json', {
      schema: v2 ? 'orbis.core-clean-target-worker-start.v2' : 'orbis.core-clean-target-worker-start.v1',
      ...bound,
    });
    const connect = (host: string, endpoint: { role: string; database: string }, readOnly: boolean) => {
      const client = new Client({
        host,
        port: 5432,
        user: endpoint.role,
        database: endpoint.database,
        password: '',
        ssl: false,
        types,
        application_name: 'orbis-core-clean-target',
        connectionTimeoutMillis: coreCleanTargetWorkerCapability.connectionTimeoutMs,
        query_timeout: coreCleanTargetWorkerCapability.queryTimeoutMs,
        statement_timeout: coreCleanTargetWorkerCapability.statementTimeoutMs,
        options: `-c search_path=pg_catalog -c default_transaction_read_only=${readOnly ? 'on' : 'off'} -c session_preload_libraries= -c local_preload_libraries= -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000`,
      });
      client.on('error', () => undefined);
      clients.push(client);
      return client;
    };
    const source = connect(coreCleanTargetWorkerCapability.sourceSocket, request.source, true);
    const destination = connect(coreCleanTargetWorkerCapability.destinationSocket, request.destination, true);
    const target = connect(coreCleanTargetWorkerCapability.targetSocket, { role: request.targetRole, database: request.target.database }, false);
    phase = 'connect';
    for (const client of clients) {
      options.signal.throwIfAborted();
      await client.connect();
    }
    const sessions = async () => {
      await session(source, request.source.role, request.source.database, true);
      await session(destination, request.destination.role, request.destination.database, true);
      await session(target, request.targetRole, request.target.database, false);
    };
    await sessions();
    phase = 'inspect';
    const inspectedSource = await inspectCoreDatabase({ client: source, authentication: sourceAuth, signal: options.signal });
    const inspectedDestination = await inspectCoreDatabase({ client: destination, authentication: destinationAuth, signal: options.signal });
    if (
      inspectedSource.summary.sha256 !== request.source.snapshotSha256 ||
      inspectedDestination.summary.sha256 !== request.destination.snapshotSha256 ||
      inspectedSource.summary.catalogSha256 !== request.expected.catalogSha256 ||
      inspectedDestination.summary.catalogSha256 !== request.expected.catalogSha256
    )
      throw fail();
    await migrations(source, request.expected.migrationsSha256, options.signal);
    await migrations(target, request.expected.migrationsSha256, options.signal);
    let writeIntentSha256: string | undefined;
    let authorizedSha256: string | undefined;
    let completed = false;
    phase = 'prepare';
    const prepared = await prepareCoreCleanTarget({
      id: request.id,
      nonce: request.nonce,
      source: inspectedSource.token,
      destination: inspectedDestination.token,
      sourceOwnerId: request.sourceOwnerId,
      destinationOwnerId: request.destinationOwnerId,
      catalogOwnerIds: request.catalogOwnerIds,
      target,
      signal: options.signal,
      ...(v2 ? { sequencePolicy: request.sequencePolicy } : {}),
      authorize: async (value) => {
        phase = 'authorize';
        await unchanged();
        if (
          authorizedSha256 ||
          value.schema !== (v2 ? 'orbis.core-clean-target-reconciliation.v2' : 'orbis.core-clean-target-reconciliation.v1') ||
          (v2 &&
            (value.schema !== 'orbis.core-clean-target-reconciliation.v2' ||
              canonicalCoreJson(value.sequencePolicy) !== canonicalCoreJson(request.sequencePolicy))) ||
          value.id !== request.id ||
          value.nonce !== request.nonce ||
          value.sourceSha256 !== request.source.snapshotSha256 ||
          value.destinationSha256 !== request.destination.snapshotSha256 ||
          value.catalogSha256 !== request.expected.catalogSha256 ||
          value.catalogOwnershipSha256 !== request.expected.catalogOwnershipSha256 ||
          value.authenticationSha256 !== digest(sourceAuth) ||
          value.sourceIdentity.database !== request.source.database ||
          value.destinationIdentity.database !== request.destination.database ||
          canonicalCoreJson(value.targetIdentity) !== canonicalCoreJson(request.target) ||
          value.sourceOwnerId !== request.sourceOwnerId ||
          value.destinationOwnerId !== request.destinationOwnerId ||
          value.catalogContext !== 'pg_catalog' ||
          value.environmentProved !== false ||
          value.restoreAuthority !== false
        )
          throw fail();
        await sessions();
        await migrations(source, request.expected.migrationsSha256, options.signal);
        await migrations(target, request.expected.migrationsSha256, options.signal);
        writeIntentSha256 = await write('write-intent.json', {
          schema: v2 ? 'orbis.core-clean-target-write-intent.v2' : 'orbis.core-clean-target-write-intent.v1',
          ...bound,
          prepared: value,
        });
        authorizedSha256 = digest(value);
        phase = 'prepare';
      },
      committed: async (value) => {
        phase = 'commit';
        if (!authorizedSha256 || !writeIntentSha256 || digest(value) !== authorizedSha256 || completed) throw fail();
        await write('completion.json', {
          schema: v2 ? 'orbis.core-clean-target-completion.v2' : 'orbis.core-clean-target-completion.v1',
          ...bound,
          writeIntentSha256,
          preparedSha256: digest(value),
          databaseCommitAcknowledged: true,
          targetVerified: false,
        });
        completed = true;
      },
    });
    phase = 'verify';
    if (!authorizedSha256 || !completed || !writeIntentSha256 || digest(prepared) !== authorizedSha256) throw fail();
    await unchanged();
    await sessions();
    if ((await verifyCoreCleanTarget(target, prepared, options.signal)) !== true) throw fail();
    await unchanged();
    phase = 'output';
    const report = {
      schema: v2 ? 'orbis.core-clean-target-worker-result.v2' : 'orbis.core-clean-target-worker-result.v1',
      ...bound,
      writeIntentSha256,
      prepared,
      targetVerified: true,
      serverQuiescenceProved: false,
    };
    await write('result.json', report);
    return report;
  } catch (error) {
    throw failure(error, phase);
  } finally {
    options.signal.removeEventListener('abort', abort);
    await close();
    for (const file of pinned) {
      file.bytes.fill(0);
      await file.handle.close().catch(() => undefined);
    }
  }
}

/** Root supplies the original sealed write intent after independently settling its writer.
 * An absent marker or mismatched target stays unresolved; preparation is never retried here. */
export async function verifyCoreCleanTargetWorker(options: { input: string; output: string; signal: AbortSignal }) {
  const pinned: Pinned[] = [];
  let client: Client | undefined;
  let phase: Phase = 'input';
  let ending: Promise<void> | undefined;
  const close = () => {
    if (!ending)
      ending = Promise.resolve()
        .then(() => client?.end())
        .then(() => undefined)
        .catch(() => undefined);
    return ending;
  };
  const abort = () => {
    void close();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.signal.throwIfAborted();
    const inputStat = await directory(options.input);
    const outputStat = await directory(options.output, true);
    if (
      options.input === options.output ||
      options.input.startsWith(`${options.output}/`) ||
      options.output.startsWith(`${options.input}/`) ||
      (await fs.readdir(options.output)).length
    )
      throw fail();
    for (const [name, maximum] of [
      ['request.json', 32768],
      ['authorization.json', 32768],
      ['write-intent.json', 65536],
    ] as const)
      pinned.push(await read(options.input, name, maximum));
    const [requestFile, authorization, intentFile] = pinned;
    if (!requestFile || !authorization || !intentFile) throw fail();
    const request = requestFrom(requestFile);
    if (request.schema !== 'orbis.core-clean-target-worker-input.v2') throw fail();
    const bound = {
      id: request.id,
      nonce: request.nonce,
      requestSha256: hash(requestFile.bytes),
      authorizationSha256: hash(authorization.bytes),
      rootPreparationSha256: request.rootPreparationSha256,
      rootIntentSha256: request.rootIntentSha256,
      scope,
      activation: false as const,
      environmentProved: false as const,
      restoreAuthority: false as const,
      sourceControllerImageId: request.sourceControllerImageId,
      sequencePolicy: request.sequencePolicy,
    };
    requireAuthorization(authorization, request, bound.requestSha256);
    const intent = canonical(intentFile);
    if (
      !exact(intent, ['schema', ...Object.keys(bound), 'prepared']) ||
      intent.schema !== 'orbis.core-clean-target-write-intent.v2' ||
      Object.entries(bound).some(([key, value]) => canonicalCoreJson(intent[key]) !== canonicalCoreJson(value))
    )
      throw fail();
    const prepared = intent.prepared as CoreCleanTargetReconciliation;
    if (
      !prepared ||
      prepared.schema !== 'orbis.core-clean-target-reconciliation.v2' ||
      prepared.id !== request.id ||
      prepared.nonce !== request.nonce ||
      canonicalCoreJson(prepared.targetIdentity) !== canonicalCoreJson(request.target) ||
      prepared.sourceSha256 !== request.source.snapshotSha256 ||
      prepared.destinationSha256 !== request.destination.snapshotSha256 ||
      prepared.catalogSha256 !== request.expected.catalogSha256 ||
      prepared.catalogOwnershipSha256 !== request.expected.catalogOwnershipSha256 ||
      prepared.sourceOwnerId !== request.sourceOwnerId ||
      prepared.destinationOwnerId !== request.destinationOwnerId ||
      canonicalCoreJson(prepared.sequencePolicy) !== canonicalCoreJson(request.sequencePolicy)
    )
      throw fail();
    const unchanged = async () => {
      options.signal.throwIfAborted();
      if (
        !same(inputStat, await directory(options.input)) ||
        !sameDirectory(outputStat, await directory(options.output, true)) ||
        (await fs.readdir(options.input)).sort().join(',') !==
          pinned
            .map((file) => file.name)
            .sort()
            .join(',')
      )
        throw fail();
      for (const file of pinned)
        if (
          !same(file.stat, await file.handle.stat({ bigint: true })) ||
          !same(file.stat, await fs.lstat(path.join(options.input, file.name), { bigint: true }))
        )
          throw fail();
    };
    await unchanged();
    phase = 'connect';
    client = new Client({
      host: coreCleanTargetWorkerCapability.targetSocket,
      port: 5432,
      user: request.targetRole,
      database: request.target.database,
      password: '',
      ssl: false,
      types,
      application_name: 'orbis-core-clean-target-verify',
      connectionTimeoutMillis: 10000,
      query_timeout: 20000,
      statement_timeout: 15000,
      options:
        '-c search_path=pg_catalog -c default_transaction_read_only=on -c session_preload_libraries= -c local_preload_libraries= -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000',
    });
    client.on('error', () => undefined);
    await client.connect();
    await session(client, request.targetRole, request.target.database, true);
    phase = 'verify';
    await unchanged();
    if ((await verifyCoreCleanTarget(client, prepared, options.signal)) !== true) throw fail();
    await close();
    await unchanged();
    phase = 'output';
    if ((await fs.readdir(options.output)).length) throw fail();
    const report = {
      schema: 'orbis.core-clean-target-verification-result.v2',
      ...bound,
      writeIntentSha256: hash(intentFile.bytes),
      prepared,
      targetVerified: true,
      databaseCommitObserved: true,
      serverQuiescenceProved: false,
    };
    const body = canonicalCoreJson(report);
    if (Buffer.byteLength(body) > 65536) throw fail();
    const handle = await fs.open(
      path.join(options.output, 'result.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let resultStat: BigIntStats;
    try {
      await handle.writeFile(body);
      await handle.chmod(0o400);
      await handle.sync();
      resultStat = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    const parent = await fs.open(options.output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameDirectory(outputStat, await parent.stat({ bigint: true }))) throw fail();
      await parent.sync();
    } finally {
      await parent.close();
    }
    await unchanged();
    if ((await fs.readdir(options.output)).join(',') !== 'result.json') throw fail();
    const published = await read(options.output, 'result.json', 65536);
    try {
      if (!same(resultStat, published.stat) || !published.bytes.equals(Buffer.from(body))) throw fail();
    } finally {
      await published.handle.close();
    }
    return report;
  } catch (error) {
    throw failure(error, phase);
  } finally {
    options.signal.removeEventListener('abort', abort);
    await close();
    for (const file of pinned) {
      file.bytes.fill(0);
      await file.handle.close().catch(() => undefined);
    }
  }
}
