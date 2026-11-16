import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import { type } from 'arktype';
import { canonicalCoreJson } from './time-machine-core-payload';

export const coreSourceConfigurationProfile = 'orbis.source-configuration.dotenv-17.2.3.v1' as const;
const maximumEnvironmentBytes = 1024 * 1024;
const maximumAuthenticationBytes = 2 * 1024 * 1024;
const identifier = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const hex = /^[a-f0-9]{64}$/;
const image = /^sha256:[a-f0-9]{64}$/;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const postgresPort = type('number | string.numeric.parse');

export class CoreSourceConfigurationError extends Error {
  constructor() {
    super('Captured source configuration could not be inspected.');
    this.name = 'CoreSourceConfigurationError';
  }
}

type BoundBytes = { bytes: Buffer; sha256: string };
export type CoreSourceConfigurationInput = {
  parserProfile: typeof coreSourceConfigurationProfile;
  sourceWitnessSha256: string;
  sourceManifestSha256: string;
  controllerImageId: string;
  controllerEnvironment: readonly string[] | null;
  databaseEnvironment: readonly string[] | null;
  configuration: BoundBytes;
  passkeys: BoundBytes | null;
};

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor) &&
    Object.keys(value).sort().join(',') === [...fields].sort().join(',')
  );
}

function bound(value: unknown, maximum: number) {
  if (
    !exact(value, ['bytes', 'sha256']) ||
    !Buffer.isBuffer(value.bytes) ||
    value.bytes.length > maximum ||
    typeof value.sha256 !== 'string' ||
    !hex.test(value.sha256)
  )
    throw new CoreSourceConfigurationError();
  const bytes = Buffer.from(value.bytes);
  if (hash(bytes) !== value.sha256) throw new CoreSourceConfigurationError();
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0')) throw new CoreSourceConfigurationError();
  return text;
}

function environment(value: unknown) {
  if (!Array.isArray(value) || value.length > 1024) throw new CoreSourceConfigurationError();
  const result = Object.create(null) as Record<string, string>;
  let bytes = 0;
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.includes('\0')) throw new CoreSourceConfigurationError();
    bytes += Buffer.byteLength(entry);
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator);
    if (bytes > maximumEnvironmentBytes || separator < 1 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || Object.hasOwn(result, key))
      throw new CoreSourceConfigurationError();
    result[key] = entry.slice(separator + 1);
    values.push(entry);
  }
  return { values, map: result };
}

function configurationCandidate(text: string, controller?: Record<string, string>) {
  const parsed = parse(text);
  if (controller?.DOTENV_KEY || parsed.DOTENV_KEY) throw new CoreSourceConfigurationError();
  // EnvUtils supplies a raw map; dotenv overrides the inherited process environment at startup.
  const raw = Object.create(null) as Record<string, string>;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const [key, ...parts] = line.split('=');
    if (key && parts.length) raw[key] = parts.join('=');
  }
  return { parsed, candidate: { ...raw, ...controller, ...parsed } };
}

/** Select private inspection candidates. Root must authenticate all inputs and select the supported parser profile. */
export function projectCoreSourceConfiguration(input: CoreSourceConfigurationInput) {
  try {
    if (
      !exact(input, [
        'parserProfile',
        'sourceWitnessSha256',
        'sourceManifestSha256',
        'controllerImageId',
        'controllerEnvironment',
        'databaseEnvironment',
        'configuration',
        'passkeys',
      ]) ||
      input.parserProfile !== coreSourceConfigurationProfile ||
      typeof input.sourceWitnessSha256 !== 'string' ||
      !hex.test(input.sourceWitnessSha256) ||
      typeof input.sourceManifestSha256 !== 'string' ||
      !hex.test(input.sourceManifestSha256) ||
      typeof input.controllerImageId !== 'string' ||
      !image.test(input.controllerImageId)
    )
      throw new CoreSourceConfigurationError();
    const text = bound(input.configuration, maximumEnvironmentBytes);
    const capturedOnly = input.controllerEnvironment === null && input.databaseEnvironment === null;
    if (!capturedOnly && (input.controllerEnvironment === null || input.databaseEnvironment === null)) throw new CoreSourceConfigurationError();
    const controller = capturedOnly ? null : environment(input.controllerEnvironment);
    const databaseEnvironment = capturedOnly ? null : environment(input.databaseEnvironment);
    const { parsed, candidate } = configurationCandidate(text, controller?.map);
    if (capturedOnly && !['JWT_SECRET', 'POSTGRES_USERNAME', 'POSTGRES_DBNAME'].every((name) => Object.hasOwn(parsed, name)))
      throw new CoreSourceConfigurationError();

    const role = capturedOnly ? parsed.POSTGRES_USERNAME : databaseEnvironment?.map.POSTGRES_USER;
    const database = capturedOnly ? parsed.POSTGRES_DBNAME : databaseEnvironment?.map.POSTGRES_DB;
    if (
      typeof role !== 'string' ||
      !identifier.test(role) ||
      typeof database !== 'string' ||
      !identifier.test(database) ||
      candidate.POSTGRES_USERNAME !== role ||
      candidate.POSTGRES_DBNAME !== database ||
      typeof candidate.JWT_SECRET !== 'string' ||
      candidate.JWT_SECRET.length < 32 ||
      candidate.JWT_SECRET.length > 4096
    )
      throw new CoreSourceConfigurationError();
    const passkeys: unknown = input.passkeys === null ? null : JSON.parse(bound(input.passkeys, maximumAuthenticationBytes));
    if (input.passkeys !== null && (passkeys === null || typeof passkeys !== 'object' || Array.isArray(passkeys)))
      throw new CoreSourceConfigurationError();
    const sourceAuthenticationBytes = Buffer.from(canonicalCoreJson({ jwtSecret: candidate.JWT_SECRET, passkeys }));
    if (sourceAuthenticationBytes.length > maximumAuthenticationBytes) throw new CoreSourceConfigurationError();
    return {
      sourceAuthenticationBytes,
      projection: {
        schema: 'orbis.core-source-environment.v2' as const,
        parserProfile: coreSourceConfigurationProfile,
        sourceWitnessSha256: input.sourceWitnessSha256,
        sourceManifestSha256: input.sourceManifestSha256,
        controllerImageId: input.controllerImageId,
        configurationSha256: input.configuration.sha256,
        controllerEnvironmentSha256: controller ? hash(canonicalCoreJson(controller.values)) : null,
        databaseEnvironmentSha256: databaseEnvironment ? hash(canonicalCoreJson(databaseEnvironment.values)) : null,
        passkeysSha256: input.passkeys?.sha256 ?? null,
        role,
        database,
        sourceAuthenticationSha256: hash(sourceAuthenticationBytes),
        basis: 'captured-configuration-candidate' as const,
        environmentBasis: capturedOnly ? ('captured-complete-configuration' as const) : ('supplied-creation-environments' as const),
        environmentProved: false as const,
        restoreAuthority: false as const,
      },
    };
  } catch {
    // Parser exceptions can contain source text; keep them out of diagnostics and error causes.
    throw new CoreSourceConfigurationError();
  }
}

export type CoreLiveAuthenticationInput = {
  parserProfile: typeof coreSourceConfigurationProfile;
  liveSnapshotSha256: string;
  publicationSha256: string;
  controllerId: string;
  controllerImageId: string;
  controllerEnvironment: readonly string[];
  databaseEnvironment: readonly string[];
  configuration: BoundBytes;
  passkeys: BoundBytes | null;
};

/** Root independently pins the current controller, database and live files before using this candidate. */
export function projectCoreLiveAuthentication(input: CoreLiveAuthenticationInput) {
  try {
    if (
      !exact(input, [
        'parserProfile',
        'liveSnapshotSha256',
        'publicationSha256',
        'controllerId',
        'controllerImageId',
        'controllerEnvironment',
        'databaseEnvironment',
        'configuration',
        'passkeys',
      ]) ||
      input.parserProfile !== coreSourceConfigurationProfile ||
      !image.test(input.controllerImageId) ||
      [input.liveSnapshotSha256, input.publicationSha256, input.controllerId].some((value) => typeof value !== 'string' || !hex.test(value))
    )
      throw new CoreSourceConfigurationError();
    const text = bound(input.configuration, maximumEnvironmentBytes);
    const controller = environment(input.controllerEnvironment);
    const database = environment(input.databaseEnvironment);
    const { candidate } = configurationCandidate(text, controller.map);
    const role = candidate.POSTGRES_USERNAME;
    const name = candidate.POSTGRES_DBNAME;
    const password = candidate.POSTGRES_PASSWORD;
    const host = candidate.POSTGRES_HOST;
    const port = candidate.POSTGRES_PORT === undefined ? 5432 : postgresPort(candidate.POSTGRES_PORT);
    if (
      typeof role !== 'string' ||
      !identifier.test(role) ||
      role !== database.map.POSTGRES_USER ||
      typeof name !== 'string' ||
      !identifier.test(name) ||
      name !== database.map.POSTGRES_DB ||
      typeof password !== 'string' ||
      password.length < 1 ||
      password.length > 4096 ||
      /[\r\n\0]/.test(password) ||
      password !== database.map.POSTGRES_PASSWORD ||
      typeof host !== 'string' ||
      !host.length ||
      host.length > 253 ||
      /[\s\0]/.test(host) ||
      port !== 5432 ||
      typeof candidate.JWT_SECRET !== 'string' ||
      candidate.JWT_SECRET.length < 32 ||
      candidate.JWT_SECRET.length > 4096
    )
      throw new CoreSourceConfigurationError();
    const passkeys: unknown = input.passkeys === null ? null : JSON.parse(bound(input.passkeys, maximumAuthenticationBytes));
    if (input.passkeys !== null && (passkeys === null || typeof passkeys !== 'object' || Array.isArray(passkeys)))
      throw new CoreSourceConfigurationError();
    const authenticationBytes = Buffer.from(canonicalCoreJson({ jwtSecret: candidate.JWT_SECRET, passkeys }));
    const databaseBytes = Buffer.from(canonicalCoreJson({ host, port: 5432, user: role, password, database: name }));
    if (authenticationBytes.length > maximumAuthenticationBytes) throw new CoreSourceConfigurationError();
    return {
      authenticationBytes,
      databaseBytes,
      projection: {
        schema: 'orbis.core-live-authentication-projection.v1' as const,
        parserProfile: coreSourceConfigurationProfile,
        liveSnapshotSha256: input.liveSnapshotSha256,
        publicationSha256: input.publicationSha256,
        controllerId: input.controllerId,
        controllerImageId: input.controllerImageId,
        configurationSha256: input.configuration.sha256,
        controllerEnvironmentSha256: hash(canonicalCoreJson(controller.values)),
        databaseEnvironmentSha256: hash(canonicalCoreJson(database.values)),
        passkeysSha256: input.passkeys?.sha256 ?? null,
        authenticationSha256: hash(authenticationBytes),
        databaseSha256: hash(databaseBytes),
        basis: 'current-controller-configuration-candidate' as const,
        environmentProved: false as const,
        restoreAuthority: false as const,
        activation: false as const,
      },
    };
  } catch {
    throw new CoreSourceConfigurationError();
  }
}
