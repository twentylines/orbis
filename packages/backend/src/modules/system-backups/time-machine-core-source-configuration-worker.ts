import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { rebaseCoreTargetConfiguration } from './backup-restore-configuration';
import { canonicalCoreJson } from './time-machine-core-payload';
import {
  coreSourceConfigurationProfile,
  projectCoreSourceConfiguration,
  projectCoreLiveAuthentication,
} from './time-machine-core-source-configuration';

const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => new Error('Captured source configuration preparation failed.');
const same = (a: BigIntStats, b: BigIntStats) =>
  ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const identity = (a: BigIntStats, b: BigIntStats) => ['dev', 'ino', 'mode', 'uid', 'gid'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));

export const coreSourceConfigurationWorkerCapability = Object.freeze({
  schema: 'orbis.core-source-configuration-worker-capability.v1',
  parserProfile: coreSourceConfigurationProfile,
  input: '/source-configuration-input',
  output: '/source-configuration-output',
  inputAuthority: 'root-bound-source-required',
  environmentBasis: 'captured-complete-configuration',
  mutations: 'private-output-only',
  environmentProved: false,
  restoreAuthority: false,
});

type PinnedFile = { name: string; stat: BigIntStats; bytes: Buffer };
type Request = {
  schema: 'orbis.core-source-configuration-worker-input.v1';
  id: string;
  nonce: string;
  parserProfile: typeof coreSourceConfigurationProfile;
  sourceWitnessSha256: string;
  sourceManifestSha256: string;
  controllerImageId: string;
  configurationSha256: string;
  passkeysSha256: string | null;
};

async function privateDirectory(directory: string) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || (await fs.realpath(directory)) !== directory) throw fail();
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid?.() ?? -1) || stat.mode & 0o077n) throw fail();
  return stat;
}

async function read(directory: string, name: string, maximum: number, minimum = 1n): Promise<PinnedFile> {
  const file = path.join(directory, name);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      stat.mode & 0o077n ||
      stat.nlink !== 1n ||
      stat.size < minimum ||
      stat.size > maximum
    )
      throw fail();
    const bytes = await handle.readFile();
    if (BigInt(bytes.length) !== stat.size || !same(stat, await handle.stat({ bigint: true })) || !same(stat, await fs.lstat(file, { bigint: true })))
      throw fail();
    return { name, stat, bytes };
  } finally {
    await handle.close();
  }
}

function requestFrom(body: Buffer): Request {
  const value = JSON.parse(body.toString('utf8')) as unknown;
  const fields = [
    'schema',
    'id',
    'nonce',
    'parserProfile',
    'sourceWitnessSha256',
    'sourceManifestSha256',
    'controllerImageId',
    'configurationSha256',
    'passkeysSha256',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== fields.sort().join(',')) throw fail();
  const request = value as Request;
  if (
    canonicalCoreJson(request) !== body.toString('utf8') ||
    request.schema !== 'orbis.core-source-configuration-worker-input.v1' ||
    request.parserProfile !== coreSourceConfigurationProfile ||
    typeof request.id !== 'string' ||
    !uuid.test(request.id) ||
    typeof request.controllerImageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(request.controllerImageId) ||
    ![request.nonce, request.sourceWitnessSha256, request.sourceManifestSha256, request.configurationSha256].every(
      (item) => typeof item === 'string' && hex.test(item),
    ) ||
    !(request.passkeysSha256 === null || (typeof request.passkeysSha256 === 'string' && hex.test(request.passkeysSha256)))
  )
    throw fail();
  return request;
}

async function write(directory: string, name: string, body: Buffer) {
  if (!body.length) throw fail();
  const handle = await fs.open(path.join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let pin: Awaited<ReturnType<typeof fs.open>> | undefined;
  let closeAttempted = false;
  try {
    await handle.writeFile(body);
    await handle.chmod(0o400);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (
      !written.isFile() ||
      (written.mode & 0o7777n) !== 0o400n ||
      written.uid !== BigInt(process.getuid?.() ?? -1) ||
      written.nlink !== 1n ||
      written.size !== BigInt(body.length)
    )
      throw fail();
    // Keep the original inode alive while the creator closes, then seal verified, post-close bytes.
    pin = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const pinned = await pin.stat({ bigint: true });
    if (!identity(written, pinned) || pinned.nlink !== 1n || pinned.size !== written.size) throw fail();
    closeAttempted = true;
    await handle.close();
    const verified = await read(directory, name, body.length);
    if (
      !identity(written, verified.stat) ||
      verified.stat.nlink !== 1n ||
      verified.stat.size !== written.size ||
      !verified.bytes.equals(body) ||
      !same(verified.stat, await pin.stat({ bigint: true }))
    )
      throw fail();
    return verified.stat;
  } finally {
    try {
      if (!closeAttempted) await handle.close();
    } finally {
      await pin?.close();
    }
  }
}

/** Root must bind the source and trusted code, then verify positive worker termination before using either output. */
export async function prepareCoreSourceConfiguration(options: { input: string; output: string; signal: AbortSignal }) {
  try {
    options.signal.throwIfAborted();
    const inputStat = await privateDirectory(options.input);
    const outputStat = await privateDirectory(options.output);
    if (
      options.input === options.output ||
      options.input.startsWith(`${options.output}${path.sep}`) ||
      options.output.startsWith(`${options.input}${path.sep}`) ||
      (await fs.readdir(options.output)).length
    )
      throw fail();
    const manifest = await read(options.input, 'request.json', 16384);
    const request = requestFrom(manifest.bytes);
    const expected = ['configuration.env', 'request.json', ...(request.passkeysSha256 === null ? [] : ['passkeys.json'])].sort();
    if ((await fs.readdir(options.input)).sort().join(',') !== expected.join(',')) throw fail();
    const configuration = await read(options.input, 'configuration.env', 1024 * 1024);
    const passkeys = request.passkeysSha256 === null ? null : await read(options.input, 'passkeys.json', 2 * 1024 * 1024);
    const selected = projectCoreSourceConfiguration({
      parserProfile: request.parserProfile,
      sourceWitnessSha256: request.sourceWitnessSha256,
      sourceManifestSha256: request.sourceManifestSha256,
      controllerImageId: request.controllerImageId,
      controllerEnvironment: null,
      databaseEnvironment: null,
      configuration: { bytes: configuration.bytes, sha256: request.configurationSha256 },
      passkeys: passkeys ? { bytes: passkeys.bytes, sha256: request.passkeysSha256 as string } : null,
    });
    const unchanged = async () => {
      options.signal.throwIfAborted();
      if (!same(inputStat, await privateDirectory(options.input)) || !identity(outputStat, await privateDirectory(options.output))) throw fail();
      if ((await fs.readdir(options.input)).sort().join(',') !== expected.join(',')) throw fail();
      for (const file of [manifest, configuration, ...(passkeys ? [passkeys] : [])])
        if (!same(file.stat, await fs.lstat(path.join(options.input, file.name), { bigint: true }))) throw fail();
    };
    await unchanged();
    const report = {
      schema: 'orbis.core-source-configuration-worker-result.v1' as const,
      id: request.id,
      nonce: request.nonce,
      inputSha256: hash(manifest.bytes),
      projection: selected.projection,
      restoreAuthority: false as const,
    };
    const authentication = await write(options.output, 'source-authentication.json', selected.sourceAuthenticationBytes);
    options.signal.throwIfAborted();
    const result = await write(options.output, 'result.json', Buffer.from(canonicalCoreJson(report)));
    const directory = await fs.open(options.output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await unchanged();
    if (
      (await fs.readdir(options.output)).sort().join(',') !== 'result.json,source-authentication.json' ||
      !same(authentication, await fs.lstat(path.join(options.output, 'source-authentication.json'), { bigint: true })) ||
      !same(result, await fs.lstat(path.join(options.output, 'result.json'), { bigint: true }))
    )
      throw fail();
    return report;
  } catch {
    // Source bytes and parser errors must never become diagnostics or error causes.
    throw fail();
  }
}

export const coreLiveAuthenticationWorkerCapability = Object.freeze({
  schema: 'orbis.core-live-authentication-worker-capability.v1',
  parserProfile: coreSourceConfigurationProfile,
  input: '/source-configuration-input',
  output: '/source-configuration-output',
  inputAuthority: 'root-bound-current-controller-required',
  environmentBasis: 'current-controller-configuration-candidate',
  mutations: 'private-output-only',
  environmentProved: false,
  restoreAuthority: false,
  activation: false,
});

/** Uses current Root-witnessed creation environments and file override, not a historical capture declaration. */
export async function prepareCoreLiveAuthentication(options: { input: string; output: string; signal: AbortSignal }) {
  const pinned: PinnedFile[] = [];
  let projected: ReturnType<typeof projectCoreLiveAuthentication> | undefined;
  try {
    options.signal.throwIfAborted();
    const inputStat = await privateDirectory(options.input);
    const outputStat = await privateDirectory(options.output);
    if (
      options.input === options.output ||
      options.input.startsWith(`${options.output}${path.sep}`) ||
      options.output.startsWith(`${options.input}${path.sep}`) ||
      (await fs.readdir(options.output)).length
    )
      throw fail();
    const take = async (name: string, maximum: number, minimum = 1n) => {
      const value = await read(options.input, name, maximum, minimum);
      pinned.push(value);
      return value;
    };
    const manifest = await take('request.json', 16384);
    const request = JSON.parse(manifest.bytes.toString('utf8'));
    const keys = [
      'schema',
      'id',
      'nonce',
      'parserProfile',
      'liveSnapshotSha256',
      'publicationSha256',
      'controllerId',
      'controllerImageId',
      'controllerEnvironmentSha256',
      'databaseEnvironmentSha256',
      'configurationSha256',
      'passkeysSha256',
    ];
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      Object.keys(request).sort().join(',') !== keys.sort().join(',') ||
      canonicalCoreJson(request) !== manifest.bytes.toString('utf8') ||
      request.schema !== 'orbis.core-live-authentication-input.v1' ||
      request.parserProfile !== coreSourceConfigurationProfile ||
      typeof request.id !== 'string' ||
      !uuid.test(request.id) ||
      typeof request.controllerImageId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(request.controllerImageId) ||
      [
        request.nonce,
        request.liveSnapshotSha256,
        request.publicationSha256,
        request.controllerId,
        request.controllerEnvironmentSha256,
        request.databaseEnvironmentSha256,
        request.configurationSha256,
      ].some((value) => typeof value !== 'string' || !hex.test(value)) ||
      !(request.passkeysSha256 === null || (typeof request.passkeysSha256 === 'string' && hex.test(request.passkeysSha256)))
    )
      throw fail();
    const configuration = await take('configuration.env', 1024 * 1024, 0n);
    const controller = await take('controller-environment.json', 1024 * 1024);
    const database = await take('database-environment.json', 1024 * 1024);
    const passkeys = request.passkeysSha256 === null ? null : await take('passkeys.json', 2 * 1024 * 1024);
    for (const [file, digest] of [
      [configuration, request.configurationSha256],
      [controller, request.controllerEnvironmentSha256],
      [database, request.databaseEnvironmentSha256],
      ...(passkeys ? [[passkeys, request.passkeysSha256]] : []),
    ] as [PinnedFile, string][])
      if (hash(file.bytes) !== digest) throw fail();
    const environments = [controller, database].map((file) => {
      const value: unknown = JSON.parse(file.bytes.toString('utf8'));
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || canonicalCoreJson(value) !== file.bytes.toString('utf8'))
        throw fail();
      return value as string[];
    });
    const expected = pinned
      .map((file) => file.name)
      .sort()
      .join(',');
    const published = new Map<string, BigIntStats>();
    const unchanged = async () => {
      options.signal.throwIfAborted();
      if (
        !same(inputStat, await privateDirectory(options.input)) ||
        !identity(outputStat, await privateDirectory(options.output)) ||
        (await fs.readdir(options.input)).sort().join(',') !== expected ||
        (await fs.readdir(options.output)).sort().join(',') !== [...published.keys()].sort().join(',')
      )
        throw fail();
      for (const file of pinned) if (!same(file.stat, await fs.lstat(path.join(options.input, file.name), { bigint: true }))) throw fail();
      for (const [name, stat] of published) if (!same(stat, await fs.lstat(path.join(options.output, name), { bigint: true }))) throw fail();
    };
    await unchanged();
    projected = projectCoreLiveAuthentication({
      parserProfile: request.parserProfile,
      liveSnapshotSha256: request.liveSnapshotSha256,
      publicationSha256: request.publicationSha256,
      controllerId: request.controllerId,
      controllerImageId: request.controllerImageId,
      controllerEnvironment: environments[0] as string[],
      databaseEnvironment: environments[1] as string[],
      configuration: { bytes: configuration.bytes, sha256: request.configurationSha256 },
      passkeys: passkeys ? { bytes: passkeys.bytes, sha256: request.passkeysSha256 } : null,
    });
    const report = {
      schema: 'orbis.core-live-authentication-result.v1' as const,
      id: request.id,
      nonce: request.nonce,
      inputSha256: hash(manifest.bytes),
      projection: projected.projection,
      restoreAuthority: false as const,
    };
    for (const [name, body] of [
      ['authentication.json', projected.authenticationBytes],
      ['database.json', projected.databaseBytes],
      ['result.json', Buffer.from(canonicalCoreJson(report))],
    ] as const) {
      await unchanged();
      published.set(name, await write(options.output, name, body));
      await unchanged();
    }
    return report;
  } catch {
    throw fail();
  } finally {
    for (const file of pinned) file.bytes.fill(0);
    projected?.authenticationBytes.fill(0);
    projected?.databaseBytes.fill(0);
  }
}

export const coreTargetConfigurationWorkerCapability = Object.freeze({
  schema: 'orbis.core-target-configuration-worker-capability.v1',
  parserProfile: coreSourceConfigurationProfile,
  input: '/source-configuration-input',
  output: '/source-configuration-output',
  inputAuthority: 'root-bound-source-required',
  environmentBasis: 'captured-complete-configuration',
  mutations: 'private-output-only',
  environmentProved: false,
  restoreAuthority: false,
});

type TargetRequest = Omit<Request, 'schema'> & {
  schema: 'orbis.core-target-configuration-worker-input.v1';
  destinationWitnessSha256: string;
  destinationConfigurationSha256: string;
  targetDatabaseName: string;
};

function targetRequestFrom(body: Buffer): TargetRequest {
  const value = JSON.parse(body.toString('utf8')) as TargetRequest;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const { destinationWitnessSha256, destinationConfigurationSha256, targetDatabaseName, ...source } = value;
  if (
    canonicalCoreJson(value) !== body.toString('utf8') ||
    value.schema !== 'orbis.core-target-configuration-worker-input.v1' ||
    ![destinationWitnessSha256, destinationConfigurationSha256].every((item) => typeof item === 'string' && hex.test(item)) ||
    typeof targetDatabaseName !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(targetDatabaseName) ||
    ['postgres', 'template0', 'template1'].includes(targetDatabaseName.toLowerCase())
  )
    throw fail();
  requestFrom(Buffer.from(canonicalCoreJson({ ...source, schema: 'orbis.core-source-configuration-worker-input.v1' })));
  return value;
}

function portableSettings(configuration: Buffer) {
  const values = parse(configuration);
  const settings: Record<string, string | boolean | number> = {};
  const fields = {
    ADVANCED_SETTINGS: ['advancedSettings', 'boolean'],
    ALLOW_AUTO_THEMES: ['allowAutoThemes', 'boolean'],
    QUEUE_TIMEOUT_IN_MINUTES: ['eventsTimeout', 'integer'],
    LOG_LEVEL: ['logLevel', 'string'],
    MAX_BACKUPS: ['maxBackups', 'integer'],
    TZ: ['timeZone', 'string'],
    THEME_BASE: ['themeBase', 'string'],
    THEME_COLOR: ['themeColor', 'string'],
  } as const;
  for (const [key, [name, kind]] of Object.entries(fields)) {
    const value = values[key];
    if (value === undefined) continue;
    if (kind === 'boolean') {
      if (!['true', 'false'].includes(value.toLowerCase())) throw fail();
      settings[name] = value.toLowerCase() === 'true';
    } else if (kind === 'integer') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw fail();
      settings[name] = Number(value);
    } else settings[name] = value;
  }
  return settings;
}

/** Root verifies positive termination and binds both witnesses before using private outputs. */
export async function prepareCoreTargetConfiguration(options: { input: string; output: string; signal: AbortSignal }) {
  try {
    options.signal.throwIfAborted();
    const inputStat = await privateDirectory(options.input);
    const outputStat = await privateDirectory(options.output);
    if (
      options.input === options.output ||
      options.input.startsWith(`${options.output}${path.sep}`) ||
      options.output.startsWith(`${options.input}${path.sep}`) ||
      (await fs.readdir(options.output)).length
    )
      throw fail();
    const manifest = await read(options.input, 'request.json', 16384);
    const request = targetRequestFrom(manifest.bytes);
    const expected = ['configuration.env', 'destination.env', 'request.json', ...(request.passkeysSha256 === null ? [] : ['passkeys.json'])].sort();
    if ((await fs.readdir(options.input)).sort().join(',') !== expected.join(',')) throw fail();
    const configuration = await read(options.input, 'configuration.env', 1024 * 1024);
    const destination = await read(options.input, 'destination.env', 1024 * 1024);
    const passkeys = request.passkeysSha256 === null ? null : await read(options.input, 'passkeys.json', 2 * 1024 * 1024);
    const destinationText = destination.bytes.toString('utf8');
    if (
      hash(destination.bytes) !== request.destinationConfigurationSha256 ||
      destinationText.includes('\0') ||
      !Buffer.from(destinationText).equals(destination.bytes)
    )
      throw fail();
    const selected = projectCoreSourceConfiguration({
      parserProfile: request.parserProfile,
      sourceWitnessSha256: request.sourceWitnessSha256,
      sourceManifestSha256: request.sourceManifestSha256,
      controllerImageId: request.controllerImageId,
      controllerEnvironment: null,
      databaseEnvironment: null,
      configuration: { bytes: configuration.bytes, sha256: request.configurationSha256 },
      passkeys: passkeys ? { bytes: passkeys.bytes, sha256: request.passkeysSha256 as string } : null,
    });
    const authentication = JSON.parse(selected.sourceAuthenticationBytes.toString('utf8')) as { jwtSecret: string };
    const rebased = rebaseCoreTargetConfiguration({
      targetEnvironment: destinationText,
      databaseName: request.targetDatabaseName,
      recovery: { jwtSecret: authentication.jwtSecret, userSettings: portableSettings(configuration.bytes) },
    });
    const environmentBytes = Buffer.from(rebased.environment);
    const settingsBytes = Buffer.from(rebased.settings);
    const unchanged = async () => {
      options.signal.throwIfAborted();
      if (!same(inputStat, await privateDirectory(options.input)) || !identity(outputStat, await privateDirectory(options.output))) throw fail();
      if ((await fs.readdir(options.input)).sort().join(',') !== expected.join(',')) throw fail();
      for (const file of [manifest, configuration, destination, ...(passkeys ? [passkeys] : [])])
        if (!same(file.stat, await fs.lstat(path.join(options.input, file.name), { bigint: true }))) throw fail();
    };
    await unchanged();
    const target = {
      schema: 'orbis.core-target-configuration.v1' as const,
      destinationWitnessSha256: request.destinationWitnessSha256,
      destinationConfigurationSha256: request.destinationConfigurationSha256,
      databaseName: request.targetDatabaseName,
      configurationSha256: hash(environmentBytes),
      settingsSha256: hash(settingsBytes),
      sourceAuthenticationSha256: hash(selected.sourceAuthenticationBytes),
      sessionPolicy: 'new-empty-cache-required' as const,
      environmentProved: false as const,
      restoreAuthority: false as const,
      activation: false as const,
    };
    const report = {
      schema: 'orbis.core-target-configuration-worker-result.v1' as const,
      id: request.id,
      nonce: request.nonce,
      inputSha256: hash(manifest.bytes),
      projection: selected.projection,
      target,
      restoreAuthority: false as const,
    };
    const files: [string, Buffer][] = [
      ['source-authentication.json', selected.sourceAuthenticationBytes],
      ['target.env', environmentBytes],
      ['target-settings.json', settingsBytes],
      ['result.json', Buffer.from(canonicalCoreJson(report))],
    ];
    const written: { name: string; stat: BigIntStats }[] = [];
    for (const [name, bytes] of files) {
      options.signal.throwIfAborted();
      written.push({ name, stat: await write(options.output, name, bytes) });
    }
    const directory = await fs.open(options.output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await unchanged();
    if (
      (await fs.readdir(options.output)).sort().join(',') !==
      files
        .map(([name]) => name)
        .sort()
        .join(',')
    )
      throw fail();
    for (const file of written) if (!same(file.stat, await fs.lstat(path.join(options.output, file.name), { bigint: true }))) throw fail();
    return report;
  } catch {
    throw fail();
  }
}
