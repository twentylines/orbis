import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { Client, types } from 'pg';
import { type CoreCleanTargetReconciliation, type CoreImportedDatabaseBinding, verifyCoreImportedDatabase } from './time-machine-core-database';
import { canonicalCoreJson } from './time-machine-core-payload';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(canonicalCoreJson(value));
const hex = /^[a-f0-9]{64}$/;
const image = /^sha256:[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const name = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const fail = () => new Error('Core imported database verification failed.');
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const flags = {
  scope: 'core-derived-logical-stage-only',
  activation: false,
  restoreAuthority: false,
  environmentProved: false,
  sourceWrites: false,
  liveDestinationProved: false,
  destinationEvidence: 'saved-capture-only',
} as const;
export const coreRestorationWorkerCapability = Object.freeze({
  schema: 'orbis.core-restoration-worker-capability.v1',
  mode: 'verify-imported-only',
  requestSchema: 'orbis.core-imported-database-worker-input.v1',
  resultSchema: 'orbis.core-imported-database-verification.v1',
  operatingSystem: 'linux',
  uid: 0,
  input: '/core-restoration-input',
  output: '/core-restoration-output',
  port: 5432,
  deadlineMs: 150000,
  connectionTimeoutMs: 10000,
  queryTimeoutMs: 20000,
  statementTimeoutMs: 15000,
  ...flags,
});
const liveFlags = { ...flags, scope: 'core-live-derived-logical-stage-only', destinationEvidence: 'live-held-derived' } as const;
export const coreLiveRestorationWorkerCapability = Object.freeze({
  ...coreRestorationWorkerCapability,
  schema: 'orbis.core-live-restoration-worker-capability.v1',
  mode: 'verify-live-imported-only',
  requestSchema: 'orbis.core-live-imported-database-worker-input.v1',
  resultSchema: 'orbis.core-live-imported-database-verification.v1',
  ...liveFlags,
});
type Mode = 'saved' | 'live';
type LiveLineage = { liveJobId: string; liveAdmissionSha256: string; liveHeldStageSha256: string };
type WorkerOptions = { input: string; output: string; signal: AbortSignal };
type ImportedVerification = Awaited<ReturnType<typeof verifyCoreImportedDatabase>>;
type LiveImportedVerification = Omit<ImportedVerification, 'schema'> & LiveLineage & { schema: 'orbis.core-live-imported-database-verification.v1' };
const liveLineageFields = ['liveJobId', 'liveAdmissionSha256', 'liveHeldStageSha256'] as const;
type Phase = 'input' | 'connect' | 'verify' | 'output';
const failures = new WeakMap<object, { phase: Phase; code: string }>();
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
export function coreRestorationFailureDiagnostic(error: unknown) {
  const detail = error !== null && typeof error === 'object' ? failures.get(error) : undefined;
  return { event: 'core-restoration-verification-failed' as const, phase: detail?.phase ?? 'input', code: detail?.code ?? 'unknown' };
}
function failure(error: unknown, phase: Phase) {
  let code = 'unknown';
  try {
    const candidate = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (typeof candidate === 'string' && codes.has(candidate)) code = candidate;
  } catch {
    /* Diagnostics never inspect arbitrary error text. */
  }
  const result = fail();
  failures.set(result, { phase, code });
  return result;
}
const same = (a: BigIntStats, b: BigIntStats) =>
  ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const sameDirectory = (a: BigIntStats, b: BigIntStats) =>
  ['dev', 'ino', 'mode', 'uid', 'gid'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
type Pinned = { name: string; handle: FileHandle; stat: BigIntStats; bytes: Buffer };
async function directory(location: string, output: boolean) {
  if (!path.isAbsolute(location) || path.resolve(location) !== location || (await fs.realpath(location)) !== location) throw fail();
  const handle = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isDirectory() ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      !(output ? [0o700n] : [0o500n, 0o700n]).includes(stat.mode & 0o7777n) ||
      !same(stat, await fs.lstat(location, { bigint: true }))
    )
      throw fail();
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
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
      stat.size > BigInt(maximum)
    )
      throw fail();
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw fail();
      offset += bytesRead;
    }
    if (
      (await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead ||
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
function json(file: Pinned): unknown {
  const value: unknown = JSON.parse(file.bytes.toString('utf8'));
  if (canonicalCoreJson(value) !== file.bytes.toString('utf8')) throw fail();
  return value;
}
const validHash = (value: unknown): value is string => typeof value === 'string' && hex.test(value);
const validUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const validName = (value: unknown): value is string => typeof value === 'string' && name.test(value);
function profile(value: unknown) {
  const base = [
    'imageId',
    'os',
    'architecture',
    'major',
    'uid',
    'gid',
    'schema',
    'role',
    'database',
    'locale',
    'scope',
    'activation',
    'environmentProved',
    'restoreAuthority',
  ];
  if (
    !exact(value, [
      ...base,
      ...(value !== null && typeof value === 'object' && Reflect.get(value, 'schema') === 'orbis.core-clean-target-pg.v2' ? ['profileId'] : []),
    ]) ||
    !['orbis.core-clean-target-pg.v1', 'orbis.core-clean-target-pg.v2'].includes(String(value.schema)) ||
    value.os !== 'linux' ||
    !validName(value.role) ||
    !validName(value.database) ||
    value.scope !== 'prepare-clean-target-only' ||
    value.activation !== false ||
    value.environmentProved !== false ||
    value.restoreAuthority !== false ||
    !exact(value.locale, ['encoding', 'collate', 'ctype', 'provider']) ||
    value.locale.encoding !== 'UTF8' ||
    value.locale.provider !== 'c'
  )
    throw fail();
  const pg17 =
    value.imageId === 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24' &&
    value.architecture === 'arm64' &&
    value.major === 17 &&
    value.uid === 70 &&
    value.gid === 70 &&
    (value.schema === 'orbis.core-clean-target-pg.v1' || value.profileId === 'pg17-alpine-arm64.v1');
  const pg14 =
    value.schema === 'orbis.core-clean-target-pg.v2' &&
    value.profileId === 'pg14-debian-amd64.v1' &&
    value.imageId === 'sha256:d462928b1898dd74b749ef486797968828c1e7fc9befb5e5ca03a33bfbc32d64' &&
    value.architecture === 'amd64' &&
    value.major === 14 &&
    value.uid === 999 &&
    value.gid === 999;
  const locales = pg17 ? ['C', 'POSIX', 'C.UTF-8', 'C.utf8', 'en_US.utf8', 'en_US.UTF-8'] : ['C', 'POSIX', 'C.utf8', 'en_US.utf8'];
  if ((!pg17 && !pg14) || !locales.includes(String(value.locale.collate)) || !locales.includes(String(value.locale.ctype))) throw fail();
  return { major: value.major as number, locale: value.locale };
}
function inputs(files: Pinned[], mode: Mode) {
  const [requestFile, authenticationFile, connectionFile, descriptorFile] = files;
  if (!requestFile || !authenticationFile || !connectionFile || !descriptorFile) throw fail();
  const request = json(requestFile);
  const authentication = json(authenticationFile);
  const connection = json(connectionFile);
  const descriptor = json(descriptorFile);
  const live = mode === 'live';
  const selectedFlags = live ? liveFlags : flags;
  if (
    !exact(request, ['schema', 'binding', 'prepared', 'authenticationSha256']) ||
    request.schema !== (live ? coreLiveRestorationWorkerCapability.requestSchema : coreRestorationWorkerCapability.requestSchema) ||
    !validHash(request.authenticationSha256) ||
    request.authenticationSha256 !== sha(authenticationFile.bytes) ||
    !exact(authentication, ['jwtSecret', 'passkeys']) ||
    typeof authentication.jwtSecret !== 'string' ||
    !authentication.jwtSecret.length ||
    authentication.jwtSecret.length > 65536 ||
    !exact(connection, ['host', 'port', 'user', 'password', 'database']) ||
    typeof connection.host !== 'string' ||
    !isIPv4(connection.host) ||
    connection.port !== 5432 ||
    !validName(connection.user) ||
    !validName(connection.database) ||
    typeof connection.password !== 'string' ||
    connection.password.length < 1 ||
    connection.password.length > 4096 ||
    /[\r\n\0]/.test(connection.password) ||
    !exact(descriptor, [
      'schema',
      'id',
      'nonce',
      ...(live ? liveLineageFields : ['reviewId', 'reconciliationReceiptSha256']),
      'preparedSha256',
      'sourceControllerImageId',
      'installedRuntime',
      'migrationPolicySha256',
      'currentSnapshotSha256',
      'currentDatabase',
      'server',
      'dump',
      'targetProfile',
      'databaseName',
      'databaseRole',
      'network',
      ...Object.keys(selectedFlags),
    ]) ||
    descriptor.schema !== (live ? 'orbis.core-live-derived-logical-stage.v1' : 'orbis.core-derived-logical-stage.v1') ||
    Object.entries(selectedFlags).some(([key, value]) => descriptor[key] !== value) ||
    !validUuid(descriptor.id) ||
    !validUuid(descriptor.nonce) ||
    !validUuid(live ? descriptor.liveJobId : descriptor.reviewId) ||
    new Set([descriptor.id, descriptor.nonce, live ? descriptor.liveJobId : descriptor.reviewId]).size !== 3 ||
    [
      ...(live ? [descriptor.liveAdmissionSha256, descriptor.liveHeldStageSha256] : [descriptor.reconciliationReceiptSha256]),
      descriptor.preparedSha256,
      descriptor.migrationPolicySha256,
      descriptor.currentSnapshotSha256,
    ].some((value) => !validHash(value)) ||
    typeof descriptor.sourceControllerImageId !== 'string' ||
    !image.test(descriptor.sourceControllerImageId) ||
    !exact(descriptor.installedRuntime, ['id', 'installationSha256', 'sourceControllerImageId']) ||
    !validUuid(descriptor.installedRuntime.id) ||
    !validHash(descriptor.installedRuntime.installationSha256) ||
    descriptor.installedRuntime.sourceControllerImageId !== descriptor.sourceControllerImageId ||
    !exact(descriptor.currentDatabase, ['id', 'definition', 'startedAt']) ||
    !validHash(descriptor.currentDatabase.id) ||
    !validHash(descriptor.currentDatabase.definition) ||
    typeof descriptor.currentDatabase.startedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(descriptor.currentDatabase.startedAt) ||
    descriptor.currentDatabase.startedAt.startsWith('0001-') ||
    !exact(descriptor.network, ['name', 'id', 'address']) ||
    typeof descriptor.network.name !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(descriptor.network.name) ||
    !validHash(descriptor.network.id) ||
    descriptor.network.address !== connection.host ||
    !exact(descriptor.server, ['systemIdentifier', 'role', 'serverVersionNum', 'postmasterEpochUs']) ||
    typeof descriptor.server.systemIdentifier !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(descriptor.server.systemIdentifier) ||
    BigInt(descriptor.server.systemIdentifier) > 18446744073709551615n ||
    descriptor.server.role !== connection.user ||
    !Number.isSafeInteger(descriptor.server.serverVersionNum) ||
    !Number.isSafeInteger(descriptor.server.postmasterEpochUs) ||
    Number(descriptor.server.postmasterEpochUs) < 1 ||
    !exact(descriptor.dump, ['bytes', 'sha256']) ||
    !Number.isSafeInteger(descriptor.dump.bytes) ||
    Number(descriptor.dump.bytes) <= 5 ||
    Number(descriptor.dump.bytes) > 64 * 1024 ** 3 ||
    !validHash(descriptor.dump.sha256) ||
    descriptor.databaseName !== connection.database ||
    descriptor.databaseRole !== connection.user
  )
    throw fail();
  const binding = request.binding;
  const prepared = request.prepared;
  const normalizedAuthentication = {
    jwtSecret: authentication.jwtSecret,
    ...(authentication.passkeys !== null ? { passkeys: authentication.passkeys } : {}),
  };
  if (
    !exact(binding, ['schema', 'id', 'nonce', 'stageSha256', 'dumpSha256', 'preparedSha256', 'database']) ||
    binding.schema !== 'orbis.core-imported-database-binding.v1' ||
    binding.id !== descriptor.id ||
    binding.nonce !== descriptor.nonce ||
    binding.stageSha256 !== sha(descriptorFile.bytes) ||
    binding.dumpSha256 !== descriptor.dump.sha256 ||
    binding.preparedSha256 !== descriptor.preparedSha256 ||
    !exact(binding.database, ['systemIdentifier', 'databaseOid', 'database', 'owner', 'marker']) ||
    binding.database.systemIdentifier !== descriptor.server.systemIdentifier ||
    typeof binding.database.databaseOid !== 'string' ||
    !/^[1-9][0-9]{0,9}$/.test(binding.database.databaseOid) ||
    BigInt(binding.database.databaseOid) > 4294967295n ||
    binding.database.database !== connection.database ||
    binding.database.database !== `orbis_restore_${descriptor.id.replaceAll('-', '')}` ||
    binding.database.owner !== connection.user ||
    binding.database.marker !== `orbis.core-derived-logical.v1/${binding.id}/${binding.nonce}/${binding.stageSha256}` ||
    !exact(prepared, [
      'schema',
      'id',
      'nonce',
      'sourceIdentity',
      'destinationIdentity',
      'targetIdentity',
      'sourceSha256',
      'destinationSha256',
      'catalogSha256',
      'authenticationSha256',
      'sourceAccountsSha256',
      'destinationAppsSha256',
      'destinationRecoverySha256',
      'sourceOwnerId',
      'destinationOwnerId',
      'catalogOwnershipSha256',
      'catalogContext',
      'major',
      'environmentProved',
      'restoreAuthority',
      'marker',
      'sequencePolicy',
    ]) ||
    prepared.schema !== 'orbis.core-clean-target-reconciliation.v2' ||
    digest(prepared) !== binding.preparedSha256 ||
    prepared.authenticationSha256 !== digest(normalizedAuthentication) ||
    !exact(prepared.sequencePolicy, ['schema', 'sourceControllerImageId', 'catalogSha256']) ||
    prepared.sequencePolicy.sourceControllerImageId !== descriptor.sourceControllerImageId
  )
    throw fail();
  const target = profile(descriptor.targetProfile);
  if (prepared.major !== target.major || Math.floor(Number(descriptor.server.serverVersionNum) / 10000) !== target.major) throw fail();
  return {
    binding: binding as CoreImportedDatabaseBinding,
    prepared: prepared as CoreCleanTargetReconciliation,
    authentication: normalizedAuthentication,
    connection: connection as { host: string; port: number; user: string; password: string; database: string },
    descriptor,
    target,
    liveLineage: live
      ? ({
          liveJobId: descriptor.liveJobId,
          liveAdmissionSha256: descriptor.liveAdmissionSha256,
          liveHeldStageSha256: descriptor.liveHeldStageSha256,
        } as LiveLineage)
      : undefined,
  };
}

export async function verifyCoreRestorationWorker(options: WorkerOptions) {
  return verifyImportedWorker(options, 'saved');
}

export async function verifyCoreLiveRestorationWorker(options: WorkerOptions) {
  return verifyImportedWorker(options, 'live');
}

function verifyImportedWorker(options: WorkerOptions, mode: 'saved'): Promise<ImportedVerification>;
function verifyImportedWorker(options: WorkerOptions, mode: 'live'): Promise<LiveImportedVerification>;
async function verifyImportedWorker(options: WorkerOptions, mode: Mode) {
  const pinned: Pinned[] = [];
  let client: Client | undefined;
  let input: Awaited<ReturnType<typeof directory>> | undefined;
  let output: Awaited<ReturnType<typeof directory>> | undefined;
  let phase: Phase = 'input';
  let closing: Promise<void> | undefined;
  const close = () => {
    if (!closing)
      closing = Promise.resolve()
        .then(() => client?.end())
        .then(() => undefined)
        .catch(() => undefined);
    return closing;
  };
  const abort = () => {
    void close();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.signal.throwIfAborted();
    if (options.input === options.output || options.input.startsWith(`${options.output}/`) || options.output.startsWith(`${options.input}/`))
      throw fail();
    input = await directory(options.input, false);
    output = await directory(options.output, true);
    if ((input.stat.dev === output.stat.dev && input.stat.ino === output.stat.ino) || (await fs.readdir(options.output)).length) throw fail();
    for (const [name, maximum] of [
      ['request.json', 65536],
      ['authentication.json', 2 * 1024 ** 2],
      ['connection.json', 32768],
      ['descriptor.json', 65536],
    ] as const)
      pinned.push(await read(options.input, name, maximum));
    const value = inputs(pinned, mode);
    const unchanged = async () => {
      options.signal.throwIfAborted();
      if (
        !input ||
        !output ||
        !same(input.stat, await input.handle.stat({ bigint: true })) ||
        !same(input.stat, await fs.lstat(options.input, { bigint: true })) ||
        !sameDirectory(output.stat, await output.handle.stat({ bigint: true })) ||
        !sameDirectory(output.stat, await fs.lstat(options.output, { bigint: true })) ||
        (await fs.realpath(options.input)) !== options.input ||
        (await fs.realpath(options.output)) !== options.output ||
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
      ...value.connection,
      ssl: false,
      types,
      application_name: 'orbis-core-imported-verify',
      connectionTimeoutMillis: 10000,
      query_timeout: 20000,
      statement_timeout: 15000,
      options:
        '-c search_path=pg_catalog -c default_transaction_read_only=on -c session_preload_libraries= -c local_preload_libraries= -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000',
    });
    client.on('error', () => undefined);
    await client.connect();
    const session = async () => {
      if (!client) throw fail();
      const response = await client.query(`SELECT current_user::text AS role,session_user::text AS session_role,current_database() AS database,
        current_setting('search_path') AS search_path,current_setting('default_transaction_read_only') AS read_only,
        current_setting('transaction_read_only') AS transaction_read_only,current_setting('server_version_num')::int AS version,
        (extract(epoch from pg_postmaster_start_time())*1000000)::bigint::text AS epoch,
        pg_catalog.host(inet_server_addr()) AS address,inet_server_port() AS port,
        pg_encoding_to_char(d.encoding) AS encoding,d.datcollate AS collate,d.datctype AS ctype,
        ${value.target.major >= 15 ? 'd.datlocprovider' : "'c'::text"} AS provider
        FROM pg_catalog.pg_database d WHERE d.datname=current_database()`);
      const row = response.rows[0];
      const expected = {
        role: value.connection.user,
        session_role: value.connection.user,
        database: value.connection.database,
        search_path: 'pg_catalog',
        read_only: 'on',
        transaction_read_only: 'on',
        version: (value.descriptor.server as Record<string, unknown>).serverVersionNum,
        epoch: String((value.descriptor.server as Record<string, unknown>).postmasterEpochUs),
        address: value.connection.host,
        port: 5432,
        ...value.target.locale,
      };
      if (response.rows.length !== 1 || canonicalCoreJson(row) !== canonicalCoreJson(expected)) throw fail();
    };
    phase = 'verify';
    const verified = await verifyCoreImportedDatabase({
      client,
      prepared: value.prepared,
      binding: value.binding,
      authentication: value.authentication,
      signal: options.signal,
      verify: async (binding) => {
        await unchanged();
        if (canonicalCoreJson(binding) !== canonicalCoreJson(value.binding)) throw fail();
        await session();
        await unchanged();
      },
    });
    const report = value.liveLineage
      ? Object.freeze({ ...verified, schema: 'orbis.core-live-imported-database-verification.v1' as const, ...value.liveLineage })
      : verified;
    await close();
    await unchanged();
    phase = 'output';
    if ((await fs.readdir(options.output)).length) throw fail();
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
    await unchanged();
    if (
      !resultStat.isFile() ||
      resultStat.nlink !== 1n ||
      !same(resultStat, await fs.lstat(path.join(options.output, 'result.json'), { bigint: true })) ||
      (await fs.readdir(options.output)).join(',') !== 'result.json'
    )
      throw fail();
    await output.handle.sync();
    await unchanged();
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
    await input?.handle.close().catch(() => undefined);
    await output?.handle.close().catch(() => undefined);
  }
}
