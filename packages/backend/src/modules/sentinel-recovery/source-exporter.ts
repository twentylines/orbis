/** Published, database-aware source reader. Host custody and enrollment remain Root's responsibility. */
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { parse } from 'dotenv';
import * as schema from '@/core/database/drizzle/schema';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { PasskeyStore } from '../auth/passkey.store';
import { projectCoreLiveAuthentication, coreSourceConfigurationProfile } from '../system-backups/time-machine-core-source-configuration';
import { exactRecoveryObject, readProtectedRecoveryJson, recoveryBase64 } from './identity';
import { withRecoveryIdentitySource } from './source';

const hash = (body: Uint8Array | string) => createHash('sha256').update(body).digest('hex');
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const image = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const owner = () => process.getuid?.() ?? -1;
const fail = () => new Error('The stopped credential source could not be verified.');
const same = (a: BigIntStats, b: BigIntStats) =>
  ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));

export const recoverySourceCapability = Object.freeze({
  schema: 'orbis.sentinel-source-exporter.v1',
  version: 1,
  databaseRequired: true,
  methods: ['capture'],
  parserProfile: coreSourceConfigurationProfile,
  sourceProtocol: 'orbis.stopped-main-source.v1',
  maxIdentityBytes: 65536,
  maxFrameBytes: 131072,
  deadlineMs: 120000,
  sqlMutations: 'none',
  sourceWrites: 'none',
  grantsAuthority: false,
});
export type SourceChannel = { send(value: unknown): Promise<void>; receive(signal: AbortSignal): Promise<unknown> };
type Request = {
  schema: 'orbis.sentinel-source-request.v1';
  operationId: string;
  planSha256: string;
  collectionNonce: string;
  phase: 'proposal' | 'activation';
  origin: string;
  installationId: string;
  sourceBindingSha256: string;
  publicationSha256: string;
  controllerId: string;
  controllerImageId: string;
  configurationSha256: string;
  controllerEnvironmentSha256: string;
  databaseEnvironmentSha256: string;
  passkeysSha256: string | null;
  database: { containerId: string; imageId: string; networkId: string; allowedHosts: string[]; major: 14 | 17; dataDirectory: string };
};

function request(body: Buffer): Request {
  const value = readProtectedRecoveryJson(body);
  if (
    !exactRecoveryObject(value, [
      'schema',
      'operationId',
      'planSha256',
      'collectionNonce',
      'phase',
      'origin',
      'installationId',
      'sourceBindingSha256',
      'publicationSha256',
      'controllerId',
      'controllerImageId',
      'configurationSha256',
      'controllerEnvironmentSha256',
      'databaseEnvironmentSha256',
      'passkeysSha256',
      'database',
    ]) ||
    value.schema !== 'orbis.sentinel-source-request.v1' ||
    ![
      value.operationId,
      value.planSha256,
      value.installationId,
      value.sourceBindingSha256,
      value.publicationSha256,
      value.controllerId,
      value.configurationSha256,
      value.controllerEnvironmentSha256,
      value.databaseEnvironmentSha256,
    ].every(hex) ||
    !recoveryBase64(value.collectionNonce, 43) ||
    value.collectionNonce.length !== 43 ||
    !['proposal', 'activation'].includes(String(value.phase)) ||
    !image(value.controllerImageId) ||
    !(value.passkeysSha256 === null || hex(value.passkeysSha256)) ||
    !exactRecoveryObject(value.database, ['containerId', 'imageId', 'networkId', 'allowedHosts', 'major', 'dataDirectory']) ||
    typeof value.database.dataDirectory !== 'string' ||
    !value.database.dataDirectory.startsWith('/') ||
    path.posix.normalize(value.database.dataDirectory) !== value.database.dataDirectory ||
    value.database.dataDirectory.includes('\0') ||
    !hex(value.database.containerId) ||
    !image(value.database.imageId) ||
    !hex(value.database.networkId) ||
    ![14, 17].includes(Number(value.database.major)) ||
    typeof value.database.major !== 'number' ||
    !Array.isArray(value.database.allowedHosts) ||
    !value.database.allowedHosts.length ||
    value.database.allowedHosts.length > 32 ||
    value.database.allowedHosts.some((host) => typeof host !== 'string' || !/^[A-Za-z0-9_.:-]{1,253}$/.test(host)) ||
    new Set(value.database.allowedHosts).size !== value.database.allowedHosts.length ||
    typeof value.origin !== 'string'
  )
    throw fail();
  const realm = new URL(value.origin);
  if (realm.protocol !== 'https:' || realm.origin !== value.origin || realm.username || realm.password || realm.port === '0') throw fail();
  return value as Request;
}

async function pinned(file: string, maximum: number) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || (await fs.realpath(file)) !== file) throw fail();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.uid !== BigInt(owner()) || stat.nlink !== 1n || stat.mode & 0o077n || !stat.size || stat.size > BigInt(maximum))
      throw fail();
    const bytes = await handle.readFile();
    const check = async () => {
      if (
        !same(stat, await handle.stat({ bigint: true })) ||
        !same(stat, await fs.lstat(file, { bigint: true })) ||
        (await fs.realpath(file)) !== file
      )
        throw fail();
    };
    if (BigInt(bytes.length) !== stat.size) throw fail();
    await check();
    return { bytes, check, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function environment(body: Buffer) {
  const entries = readProtectedRecoveryJson(body);
  if (!Array.isArray(entries) || entries.length > 1024) throw fail();
  const result: Record<string, string> = Object.create(null);
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.includes('\0')) throw fail();
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(result, key)) throw fail();
    result[key] = entry.slice(separator + 1);
  }
  return { entries: entries as string[], map: result };
}

/** Fixed primary/source facts. The selected server must expose the same ordinary authority table as Main. */
export async function recoverySourceDatabaseFacts(client: Pick<Client, 'query'>) {
  const result = await client.query(`SELECT pg_catalog.json_build_object(
    'systemIdentifier',(pg_catalog.pg_control_system()).system_identifier::text,
    'database',pg_catalog.current_database(),'databaseOid',d.oid::text,'role',CURRENT_USER,'roleOid',r.oid::text,
    'postmasterEpochUs',(extract(epoch FROM pg_catalog.pg_postmaster_start_time())*1000000)::bigint::text,
    'serverVersionNum',pg_catalog.current_setting('server_version_num')::int,
    'relationOid',c.oid::text,'relationOwnerOid',c.relowner::text,'relationKind',c.relkind,
    'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity,
    'resolvedRelation',pg_catalog.to_regclass('"user"')::oid::text,
    'dataDirectory',pg_catalog.current_setting('data_directory'),'serverAddress',pg_catalog.host(pg_catalog.inet_server_addr()),'serverPort',pg_catalog.inet_server_port()) AS facts
    FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE d.datname=pg_catalog.current_database() AND r.rolname=CURRENT_USER AND n.nspname='public' AND c.relname='user'`);
  if (result.rows.length !== 1) throw fail();
  const facts: unknown = result.rows[0]?.facts;
  const fields = [
    'systemIdentifier',
    'database',
    'databaseOid',
    'role',
    'roleOid',
    'postmasterEpochUs',
    'serverVersionNum',
    'relationOid',
    'relationOwnerOid',
    'relationKind',
    'rowSecurity',
    'forceRowSecurity',
    'resolvedRelation',
    'dataDirectory',
    'serverAddress',
    'serverPort',
  ];
  if (
    !exactRecoveryObject(facts, fields) ||
    facts.relationKind !== 'r' ||
    facts.rowSecurity !== false ||
    facts.forceRowSecurity !== false ||
    typeof facts.dataDirectory !== 'string' ||
    !facts.dataDirectory.startsWith('/') ||
    path.posix.normalize(facts.dataDirectory) !== facts.dataDirectory ||
    facts.resolvedRelation !== facts.relationOid ||
    facts.serverAddress !== '127.0.0.1' ||
    facts.serverPort !== 5432 ||
    typeof facts.serverVersionNum !== 'number' ||
    !Number.isSafeInteger(facts.serverVersionNum) ||
    !['database', 'role'].every((key) => typeof facts[key] === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(String(facts[key]))) ||
    !['systemIdentifier', 'databaseOid', 'roleOid', 'postmasterEpochUs', 'relationOid', 'relationOwnerOid'].every(
      (key) => typeof facts[key] === 'string' && /^[1-9][0-9]{0,19}$/.test(String(facts[key])),
    )
  )
    throw fail();
  const columns = await client.query(`SELECT a.attname AS name,t.typname AS type,a.attnotnull AS required
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
    WHERE a.attrelid='public."user"'::pg_catalog.regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`);
  const expected: Record<string, string> = {
    id: 'int4',
    username: 'varchar',
    password: 'varchar',
    created_at: 'int4',
    updated_at: 'int4',
    operator: 'bool',
    totp_secret: 'text',
    totp_enabled: 'bool',
    salt: 'text',
    locale: 'varchar',
    has_seen_welcome: 'bool',
  };
  if (
    columns.rows.length !== Object.keys(expected).length ||
    columns.rows.some(
      (row) =>
        !exactRecoveryObject(row, ['name', 'type', 'required']) ||
        typeof row.name !== 'string' ||
        expected[row.name] !== row.type ||
        typeof row.required !== 'boolean' ||
        (!['salt', 'totp_secret'].includes(row.name) && row.required !== true),
    ) ||
    new Set(columns.rows.map((row) => row.name)).size !== columns.rows.length
  )
    throw fail();
  return {
    ...facts,
    dataDirectory: String(facts.dataDirectory),
    serverVersionNum: Number(facts.serverVersionNum),
    database: String(facts.database),
    role: String(facts.role),
    columns: columns.rows,
  };
}

/** Actual pg implementation; seams below are code-owned test dependencies, never serialized request fields. */
export async function captureRecoverySource(options: {
  input: string;
  channel: SourceChannel;
  signal: AbortSignal;
  openDatabase?: (connection: { host: string; port: number; user: string; password: string; database: string }) => Promise<{
    database: Parameters<typeof withRecoveryIdentitySource>[0]['database'];
    client: Pick<Client, 'query'>;
    close(): Promise<void>;
  }>;
}) {
  const resources: Array<{ bytes: Buffer; check(): Promise<void>; close(): Promise<void> }> = [];
  let connection: Awaited<ReturnType<NonNullable<typeof options.openDatabase>>> | undefined;
  try {
    options.signal.throwIfAborted();
    const root = await fs.lstat(options.input, { bigint: true });
    if (!root.isDirectory() || root.uid !== BigInt(owner()) || root.mode & 0o077n || (await fs.realpath(options.input)) !== options.input)
      throw fail();
    const read = async (name: string, maximum: number) => {
      const value = await pinned(path.join(options.input, name), maximum);
      resources.push(value);
      return value.bytes;
    };
    const rawRequest = await read('request.json', 16384);
    const selected = request(rawRequest);
    const configuration = await read('data/.env', 1024 * 1024);
    const controllerRaw = await read('controller-environment.json', 1024 * 1024);
    const databaseRaw = await read('database-environment.json', 1024 * 1024);
    const controller = environment(controllerRaw);
    const database = environment(databaseRaw);
    if (
      hash(configuration) !== selected.configurationSha256 ||
      hash(controllerRaw) !== selected.controllerEnvironmentSha256 ||
      hash(databaseRaw) !== selected.databaseEnvironmentSha256
    )
      throw fail();
    const parsed = parse(configuration);
    const effective = { ...controller.map, ...parsed };
    // Main's pg client inherits these outside ConfigurationService's named DB
    // fields. An unsupported startup/search-path/encoding override cannot be
    // silently discarded by the isolated source connection.
    if (
      effective.PGOPTIONS ||
      controller.map.NODE_OPTIONS ||
      controller.map.NODE_PATH ||
      (effective.PGSSLMODE && effective.PGSSLMODE !== 'disable') ||
      (effective.PGCLIENTENCODING && !['UTF8', 'UTF-8'].includes(effective.PGCLIENTENCODING.toUpperCase()))
    )
      throw fail();
    const origin = parsed.ORBIS_SENTINEL_RECOVERY_ORIGIN ?? controller.map.ORBIS_SENTINEL_RECOVERY_ORIGIN;
    if (origin !== selected.origin) throw fail();
    const passkeys = selected.passkeysSha256 === null ? null : await read('data/state/auth/passkeys.json', 512 * 1024);
    if (passkeys && hash(passkeys) !== selected.passkeysSha256) throw fail();
    if (!passkeys) {
      try {
        await fs.lstat(path.join(options.input, 'data/state/auth/passkeys.json'));
        throw fail();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const projected = projectCoreLiveAuthentication({
      parserProfile: coreSourceConfigurationProfile,
      liveSnapshotSha256: selected.sourceBindingSha256,
      publicationSha256: selected.publicationSha256,
      controllerId: selected.controllerId,
      controllerImageId: selected.controllerImageId,
      controllerEnvironment: controller.entries,
      databaseEnvironment: database.entries,
      configuration: { bytes: configuration, sha256: selected.configurationSha256 },
      passkeys: passkeys ? { bytes: passkeys, sha256: selected.passkeysSha256 as string } : null,
    });
    const credentials = JSON.parse(projected.databaseBytes.toString()) as {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
    };
    const authentication = JSON.parse(projected.authenticationBytes.toString()) as { jwtSecret: string };
    if (!selected.database.allowedHosts.includes(credentials.host) || credentials.port !== 5432) throw fail();
    const open =
      options.openDatabase ??
      (async (value) => {
        const client = new Client({
          ...value,
          host: '127.0.0.1',
          port: 5432,
          ssl: false,
          connectionTimeoutMillis: 10000,
          statement_timeout: 15000,
          query_timeout: 15000,
          application_name: 'orbis-recovery-source',
        });
        client.on('error', () => undefined);
        try {
          await client.connect();
          return { database: drizzle({ client, schema }), client, close: () => client.end() };
        } catch {
          await client.end().catch(() => undefined);
          throw fail();
        }
      });
    const activeConnection = await open({ ...credentials, host: '127.0.0.1' });
    connection = activeConnection;
    class SourceConfiguration {
      get(key: 'directories'): { dataDir: string };
      get(key: 'jwtSecret'): string;
      get(key: 'directories' | 'jwtSecret') {
        return key === 'directories' ? { dataDir: path.join(options.input, 'data') } : authentication.jwtSecret;
      }
    }
    const config = new SourceConfiguration();
    const check = async () => {
      options.signal.throwIfAborted();
      for (const resource of resources) await resource.check();
      if (!same(root, await fs.lstat(options.input, { bigint: true }))) throw fail();
    };
    await withRecoveryIdentitySource(
      {
        database: connection.database,
        passkeys: new PasskeyStore(config),
        encryption: new EncryptionService(config),
        config,
        origin: selected.origin,
        signal: options.signal,
      },
      async (source) => {
        await check();
        const facts = await recoverySourceDatabaseFacts(activeConnection.client);
        if (
          facts.dataDirectory !== selected.database.dataDirectory ||
          Math.floor(facts.serverVersionNum / 10000) !== selected.database.major ||
          facts.database !== credentials.database ||
          facts.role !== credentials.user
        )
          throw fail();
        const descriptor = {
          schema: 'orbis.sentinel-source-observation.v1',
          requestSha256: hash(rawRequest),
          sourceBindingSha256: selected.sourceBindingSha256,
          configurationSha256: hash(configuration),
          passkeysSha256: selected.passkeysSha256,
          effectiveConfigurationSha256: hash(projected.databaseBytes),
          authenticationSha256: hash(projected.authenticationBytes),
          database: facts,
        };
        const descriptorSha256 = hash(JSON.stringify(descriptor));
        await options.channel.send({
          schema: 'orbis.sentinel-source-frame.v1',
          phase: 'source',
          collectionNonce: selected.collectionNonce,
          sourceSha256: source.sha256,
          identityBase64: source.bytes.toString('base64'),
          descriptor,
          descriptorSha256,
        });
        for (let count = 0; count < 8; count++) {
          const command = await options.channel.receive(options.signal);
          if (
            !exactRecoveryObject(command, ['schema', 'operation', 'collectionNonce', 'challenge']) ||
            command.schema !== 'orbis.sentinel-source-command.v1' ||
            command.collectionNonce !== selected.collectionNonce ||
            !['check', 'release'].includes(String(command.operation)) ||
            !recoveryBase64(command.challenge, 43) ||
            command.challenge.length !== 43
          )
            throw fail();
          await check();
          if (JSON.stringify(await recoverySourceDatabaseFacts(activeConnection.client)) !== JSON.stringify(facts)) throw fail();
          await options.channel.send({
            schema: 'orbis.sentinel-source-frame.v1',
            phase: command.operation === 'release' ? 'released' : 'checked',
            collectionNonce: selected.collectionNonce,
            challenge: command.challenge,
            sourceSha256: source.sha256,
            descriptorSha256,
          });
          if (command.operation === 'release') return;
        }
        throw fail();
      },
    );
  } catch {
    throw fail();
  } finally {
    try {
      await connection?.close();
    } finally {
      for (const item of resources.reverse()) {
        item.bytes.fill(0);
        await item.close();
      }
    }
  }
}
