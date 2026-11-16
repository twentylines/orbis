import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import {
  coreSourceCatalogBootstrapEvidence,
  inspectCoreDatabase,
  inspectCoreDatabaseStructure,
  requireCoreSourceOwner,
} from './time-machine-core-database';
import { canonicalCoreJson } from './time-machine-core-payload';
import {
  corePgExecutionProfiles,
  corePgExecutionProfile,
  observeCorePgExecution,
  requireCorePgExecutionArchitecture,
} from './time-machine-core-pg-profile';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = () => new Error('Core source inspection failed.');
type InspectionPhase = 'input' | 'connect' | 'settings-before' | 'catalog' | 'source-auth' | 'settings-after' | 'output';
const failureCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOENT',
  'EACCES',
  'ENOTFOUND',
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
  'XX000',
]);
const failures = new WeakMap<object, { phase: InspectionPhase; code: string }>();
function inspectionFailure(error: unknown, phase: InspectionPhase) {
  let code = 'unknown';
  try {
    const candidate = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (typeof candidate === 'string' && failureCodes.has(candidate)) code = candidate;
  } catch {
    code = 'unknown';
  }
  const failure = fail();
  failures.set(failure, { phase, code });
  return failure;
}
export function coreInspectionFailureDiagnostic(error: unknown) {
  const failure = error !== null && typeof error === 'object' ? failures.get(error) : undefined;
  return { event: 'core-inspection-failed' as const, phase: failure?.phase ?? 'input', code: failure?.code ?? 'unknown' };
}
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const image = 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
export const coreInspectionSettings = Object.freeze({
  config_file: '/inspection-config/postgresql.conf',
  data_directory: '/var/lib/postgresql/data',
  hba_file: '/inspection-config/pg_hba.conf',
  ident_file: '/inspection-config/pg_ident.conf',
  listen_addresses: '',
  unix_socket_directories: '/var/run/postgresql',
  unix_socket_permissions: '0770',
  port: '5432',
  ssl: 'off',
  shared_preload_libraries: '',
  local_preload_libraries: '',
  session_preload_libraries: '',
  archive_mode: 'off',
  archive_command: '',
  archive_library: '',
  restore_command: '',
  archive_cleanup_command: '',
  recovery_end_command: '',
  ssl_passphrase_command: '',
  external_pid_file: '',
  autovacuum: 'off',
  default_transaction_read_only: 'on',
  max_connections: '4',
  max_worker_processes: '0',
  max_parallel_workers: '0',
  max_parallel_workers_per_gather: '0',
  max_logical_replication_workers: '0',
  max_sync_workers_per_subscription: '0',
  max_wal_senders: '0',
  max_replication_slots: '0',
  logging_collector: 'off',
  log_destination: 'stderr',
  log_statement: 'none',
  log_min_error_statement: 'panic',
  log_error_verbosity: 'terse',
});
export const coreInspectionWorkerCapability = Object.freeze({
  schema: 'orbis.core-inspection-worker-capability.v1',
  profile: 'orbis.core-source-pg-inspection.v1',
  sourceImage: image,
  platform: { os: 'linux', architecture: 'arm64' },
  postgresqlMajor: 17,
  scope: 'inspection-only',
  mutations: 'private-output-only',
  restoreAuthority: false,
  settingsSha256: hash(canonicalCoreJson(coreInspectionSettings)),
});
export const roleBoundCoreInspectionSettings = Object.freeze({ ...coreInspectionSettings, search_path: 'pg_catalog' });
export const roleBoundCoreInspectionWorkerCapability = Object.freeze({
  ...coreInspectionWorkerCapability,
  profile: 'orbis.core-source-pg-inspection.v2',
  settingsSha256: hash(canonicalCoreJson(roleBoundCoreInspectionSettings)),
});
export const bootstrapSourceCoreInspectionWorkerCapability = Object.freeze({
  ...roleBoundCoreInspectionWorkerCapability,
  protocol: 3,
  evidenceScope: 'authenticated-bootstrap-source',
});
export function coreVersionedInspectionSettings(profileId: unknown) {
  const profile = corePgExecutionProfile(profileId);
  if (profile.major === 17) return roleBoundCoreInspectionSettings;
  const { archive_library: _unsupported, ...settings } = roleBoundCoreInspectionSettings;
  return Object.freeze(settings);
}
export const versionedBootstrapSourceCoreInspectionWorkerCapability = Object.freeze({
  schema: 'orbis.core-inspection-worker-capability.v2',
  protocol: 4,
  profile: 'orbis.core-source-pg-inspection.v3',
  profiles: Object.freeze(
    Object.fromEntries(
      Object.entries(corePgExecutionProfiles).map(([id, profile]) => [
        id,
        Object.freeze({
          ...profile,
          settingsSha256: hash(canonicalCoreJson(coreVersionedInspectionSettings(id))),
        }),
      ]),
    ),
  ),
  scope: 'inspection-only',
  mutations: 'private-output-only',
  evidenceScope: 'authenticated-bootstrap-source',
  restoreAuthority: false,
});
const databaseIdentity = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
async function verifySettings(client: Pick<Client, 'query'>, settings: Readonly<Record<string, string>>) {
  for (const [name, expected] of Object.entries(settings)) {
    const result = await client.query(`SHOW ${name}`);
    // PostgreSQL's show hook reports this sentinel while archive_mode is off.
    // Keep the configuration and its receipt hash bound to the empty command.
    const displayed = name === 'archive_command' ? '(disabled)' : expected;
    if (result.rows.length !== 1 || Object.keys(result.rows[0]).join(',') !== name || result.rows[0][name] !== displayed) throw fail();
  }
  return hash(canonicalCoreJson(settings));
}
export function verifyCoreInspectionSettings(client: Pick<Client, 'query'>) {
  return verifySettings(client, coreInspectionSettings);
}
export async function verifyRoleBoundCoreInspectionSettings(client: Pick<Client, 'query'>, role: string) {
  return verifyRoleSettings(client, roleBoundCoreInspectionSettings, role);
}
async function verifyRoleSettings(client: Pick<Client, 'query'>, settings: Readonly<Record<string, string>>, role: string) {
  if (!databaseIdentity.test(role)) throw fail();
  const digest = await verifySettings(client, settings);
  const result = await client.query('SELECT CURRENT_USER AS current_user, SESSION_USER AS session_user');
  if (
    result.rows.length !== 1 ||
    !exact(result.rows[0], ['current_user', 'session_user']) ||
    result.rows[0].current_user !== role ||
    result.rows[0].session_user !== role
  )
    throw fail();
  return digest;
}
type Stat = Awaited<ReturnType<typeof fs.stat>>;
const same = (a: Stat, b: Stat) =>
  ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
async function input(directory: string, name: string, maximum: number) {
  const filename = path.join(directory, name);
  if ((await fs.realpath(directory)) !== directory) throw fail();
  const owner = await fs.lstat(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid?.() || owner.mode & 0o077) throw fail();
  const descriptor = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await descriptor.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      before.size < 1 ||
      before.size > maximum
    )
      throw fail();
    const body = await descriptor.readFile();
    if (!same(before, await descriptor.stat()) || !same(before, await fs.lstat(filename)) || body.length !== before.size) throw fail();
    return body;
  } finally {
    await descriptor.close();
  }
}
export async function inspectCoreSource(options: { input: string; output: string; signal: AbortSignal }) {
  const progress: { phase: InspectionPhase } = { phase: 'input' };
  try {
    return await inspectCoreSourceAtPhase(options, progress);
  } catch (error) {
    throw inspectionFailure(error, progress.phase);
  }
}
async function inspectCoreSourceAtPhase(options: { input: string; output: string; signal: AbortSignal }, progress: { phase: InspectionPhase }) {
  const body = await input(options.input, 'request.json', 16384);
  const request: unknown = JSON.parse(body.toString('utf8'));
  const schema = request !== null && typeof request === 'object' ? Reflect.get(request, 'schema') : undefined;
  const versioned = schema === 'orbis.core-inspection-worker-input.v4';
  const executionProfileId = versioned ? Reflect.get(request as object, 'executionProfile') : undefined;
  const execution = versioned ? requireCorePgExecutionArchitecture(executionProfileId, os.arch()) : undefined;
  const executionSettings = versioned ? coreVersionedInspectionSettings(executionProfileId) : undefined;
  const bootstrapSource = versioned || schema === 'orbis.core-inspection-worker-input.v3';
  const roleBound = bootstrapSource || schema === 'orbis.core-inspection-worker-input.v2';
  const capability = bootstrapSource
    ? bootstrapSourceCoreInspectionWorkerCapability
    : roleBound
      ? roleBoundCoreInspectionWorkerCapability
      : coreInspectionWorkerCapability;
  if (
    !exact(request, [
      'schema',
      'id',
      'nonce',
      'permitSha256',
      'resourcesSha256',
      'sourceManifestSha256',
      'database',
      'sourceOwnerId',
      'sourceImageId',
      'sourceAuthenticationSha256',
      'settingsSha256',
      ...(roleBound ? ['role', 'sourceProjectionSha256'] : []),
      ...(bootstrapSource ? ['evidenceScope'] : []),
      ...(versioned ? ['executionProfile'] : []),
    ]) ||
    request.schema !==
      (versioned
        ? 'orbis.core-inspection-worker-input.v4'
        : bootstrapSource
          ? 'orbis.core-inspection-worker-input.v3'
          : roleBound
            ? 'orbis.core-inspection-worker-input.v2'
            : 'orbis.core-inspection-worker-input.v1') ||
    (bootstrapSource && request.evidenceScope !== bootstrapSourceCoreInspectionWorkerCapability.evidenceScope) ||
    !uuid.test(request.id as string) ||
    !hex.test(request.nonce as string) ||
    !hex.test(request.permitSha256 as string) ||
    !hex.test(request.resourcesSha256 as string) ||
    !hex.test(request.sourceManifestSha256 as string) ||
    typeof request.database !== 'string' ||
    !databaseIdentity.test(request.database) ||
    (roleBound &&
      (typeof request.role !== 'string' ||
        !databaseIdentity.test(request.role) ||
        typeof request.sourceProjectionSha256 !== 'string' ||
        !hex.test(request.sourceProjectionSha256))) ||
    !Number.isSafeInteger(request.sourceOwnerId) ||
    (request.sourceOwnerId as number) < 1 ||
    (request.sourceOwnerId as number) > 2147483647 ||
    request.sourceImageId !== (execution?.imageId ?? image) ||
    request.settingsSha256 !== (executionSettings ? hash(canonicalCoreJson(executionSettings)) : capability.settingsSha256) ||
    !(
      (!roleBound && request.sourceAuthenticationSha256 === null) ||
      (typeof request.sourceAuthenticationSha256 === 'string' && hex.test(request.sourceAuthenticationSha256))
    )
  )
    throw fail();
  const role = roleBound ? (request.role as string) : 'postgres';
  let authentication: { jwtSecret: string; passkeys?: unknown } | undefined;
  if (request.sourceAuthenticationSha256 !== null) {
    const bytes = await input(options.input, 'source-authentication.json', 2 * 1024 * 1024);
    if (hash(bytes) !== request.sourceAuthenticationSha256) throw fail();
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !exact(value, ['jwtSecret', 'passkeys']) ||
      typeof value.jwtSecret !== 'string' ||
      value.jwtSecret.length < 32 ||
      value.jwtSecret.length > 4096
    )
      throw fail();
    authentication = { jwtSecret: value.jwtSecret, ...(value.passkeys !== null ? { passkeys: value.passkeys } : {}) };
  }
  const expectedNames = request.sourceAuthenticationSha256 === null ? ['request.json'] : ['request.json', 'source-authentication.json'];
  if ((await fs.readdir(options.input)).sort().join(',') !== expectedNames.sort().join(',')) throw fail();
  if ((await fs.realpath(options.output)) !== options.output) throw fail();
  const output = await fs.lstat(options.output);
  if (!output.isDirectory() || output.uid !== process.getuid?.() || output.mode & 0o077 || (await fs.readdir(options.output)).length) throw fail();
  progress.phase = 'connect';
  const client = new Client({
    host: '/var/run/postgresql',
    port: 5432,
    user: role,
    password: '',
    database: request.database,
    ssl: false,
    ...(roleBound
      ? { options: '-c search_path=pg_catalog -c default_transaction_read_only=on -c session_preload_libraries= -c local_preload_libraries=' }
      : {}),
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
    statement_timeout: 15000,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    options.signal.throwIfAborted();
    progress.phase = 'settings-before';
    const executionObservation = versioned ? await observeCorePgExecution(client, executionProfileId, request.database) : undefined;
    if (executionSettings) await verifyRoleSettings(client, executionSettings, role);
    else if (roleBound) await verifyRoleBoundCoreInspectionSettings(client, role);
    else await verifyCoreInspectionSettings(client);
    progress.phase = 'catalog';
    const structure = await inspectCoreDatabaseStructure(client, options.signal);
    if (structure.major !== (execution?.major ?? 17)) throw fail();
    let authenticated: Awaited<ReturnType<typeof requireCoreSourceOwner>> | undefined;
    let evidence: Awaited<ReturnType<typeof coreSourceCatalogBootstrapEvidence>> | undefined;
    if (authentication) {
      progress.phase = 'source-auth';
      const inspected = await inspectCoreDatabase({ client, authentication, signal: options.signal });
      if (inspected.summary.sha256 !== structure.sha256 || (versioned && inspected.summary.major !== execution?.major)) throw fail();
      authenticated = await requireCoreSourceOwner(inspected.token, request.sourceOwnerId as number);
      if (bootstrapSource) evidence = await coreSourceCatalogBootstrapEvidence(inspected.token, request.sourceOwnerId as number);
    }
    progress.phase = 'settings-after';
    if (executionSettings) {
      await verifyRoleSettings(client, executionSettings, role);
      if (canonicalCoreJson(await observeCorePgExecution(client, executionProfileId, request.database)) !== canonicalCoreJson(executionObservation))
        throw fail();
    } else if (roleBound) await verifyRoleBoundCoreInspectionSettings(client, role);
    else await verifyCoreInspectionSettings(client);
    progress.phase = 'output';
    const report = {
      schema: versioned
        ? 'orbis.core-inspection-worker-result.v4'
        : bootstrapSource
          ? 'orbis.core-inspection-worker-result.v3'
          : roleBound
            ? 'orbis.core-inspection-worker-result.v2'
            : 'orbis.core-inspection-worker-result.v1',
      id: request.id,
      nonce: request.nonce,
      inputSha256: hash(body),
      permitSha256: request.permitSha256,
      resourcesSha256: request.resourcesSha256,
      sourceManifestSha256: request.sourceManifestSha256,
      sourceImageId: request.sourceImageId,
      settingsSha256: request.settingsSha256,
      structure,
      sourceAuthenticationSha256: request.sourceAuthenticationSha256,
      sourceOwner: authenticated ?? null,
      compatibilityRefusal: roleBound ? 'source-effective-environment-unproved' : authenticated ? null : 'source-authentication-unavailable',
      ...(roleBound ? { role, sourceProjectionSha256: request.sourceProjectionSha256 } : {}),
      ...(bootstrapSource ? { evidenceScope: bootstrapSourceCoreInspectionWorkerCapability.evidenceScope, bootstrapSource: evidence } : {}),
      ...(versioned ? { executionProfile: executionProfileId, databaseExecution: executionObservation } : {}),
      restoreAuthority: false,
    };
    options.signal.throwIfAborted();
    const destination = await fs.open(
      path.join(options.output, 'result.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await destination.writeFile(canonicalCoreJson(report));
      await destination.sync();
    } finally {
      await destination.close();
    }
    const parent = await fs.open(options.output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return report;
  } finally {
    await client.end().catch(() => undefined);
    authentication = undefined;
  }
}
