import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { type } from 'arktype';
import { timeMachineHashSchema as hash, timeMachineIdSchema as uuid } from '@runtipi/common/schemas/time-machine';
import { backupMemberName } from './backup-import';

export const appRuntimeEntryName = 'app-runtime/create-intents.json';
export const appRuntimeEntryLimit = 16 * 1024 * 1024;
const failed = () => new Error('Protected historical app runtime could not be verified.');
const digest = type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value));
const name = type('string').narrow((value) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value));
const urn = type('string').narrow((value) => /^[a-z0-9][a-z0-9_-]{0,127}:(?:[a-z0-9][a-z0-9_-]{0,127}|_user)$/.test(value));
const variant = type('string').narrow((value) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,31}$/.test(value));
const platform = type({ os: "'linux'", architecture: "'amd64' | 'arm64'", 'variant?': variant }).onUndeclaredKey('reject');
const file = type({ name: 'string > 0 & string <= 4096', bytes: 'number.integer >= 0 & number <= 9007199254740991', sha256: hash }).onUndeclaredKey(
  'reject',
);
const service = type({ name, replicas: '0 <= number.integer <= 1024' }).onUndeclaredKey('reject');
const app = type({
  id: '1 <= number.integer <= 2147483647',
  urn,
  project: 'string > 0 & string <= 255',
  status: "'running' | 'stopped' | 'missing'",
  pendingRestart: 'boolean',
  userConfigEnabled: 'boolean',
  sourceSha256: hash,
  configurationSha256: hash,
  savedFiles: file.array().atMostLength(2048),
  services: service.array().atMostLength(256),
}).onUndeclaredKey('reject');
const inspection = type({
  Id: hash,
  Name: 'string > 1 & string <= 256',
  Image: digest,
  Config: 'unknown',
  HostConfig: 'unknown',
  Mounts: 'unknown',
  NetworkSettings: type({ Networks: 'unknown', Ports: 'unknown' }).onUndeclaredKey('reject'),
}).onUndeclaredKey('reject');
const container = type({
  appUrn: urn,
  service: name,
  ordinal: '1 <= number.integer <= 1024',
  wasRunning: 'boolean',
  inspect: inspection,
  image: type({
    sourceImageId: digest,
    creationReference: digest,
    platform,
    selection: "'docker29-platform-manifest.v1' | 'docker-config.v1'",
  }).onUndeclaredKey('reject'),
  transformPolicy: "'orbis.app-runtime-transform.same-host.v1'",
}).onUndeclaredKey('reject');
const network = type({ name: 'string > 0 & string <= 255', sourceNetworkId: hash, inspect: 'unknown' }).onUndeclaredKey('reject');
const schema = type({
  schema: "'orbis.app-runtime-capture.v1'",
  version: '1',
  pointId: uuid,
  rootSha256: hash,
  dockerContextSha256: hash,
  daemonSha256: hash,
  configurationSetSha256: hash,
  preparationSha256: hash,
  capturedAt: '0 <= number.integer <= 9007199254740991',
  apps: app.array().atMostLength(1024),
  containers: container.array().atMostLength(1024),
  networkDefinitions: network.array().atMostLength(1024),
  sha256: hash,
}).onUndeclaredKey('reject');
export type AppRuntimeCaptureMetadata = typeof schema.infer;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const scalar = (value: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) && Buffer.byteLength(value) <= 2 * 1024 * 1024;
function bounded(value: unknown) {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 262144 || depth > 32) throw failed();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (!scalar(item)) throw failed();
      return;
    }
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw failed();
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (!object(item)) throw failed();
    for (const [key, child] of Object.entries(item)) {
      if (!scalar(key)) throw failed();
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}
export function canonicalAppRuntimeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAppRuntimeJson).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalAppRuntimeJson(value[key])}`)
      .join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw failed();
  return result;
}
function ordered<T>(values: readonly T[], key: (value: T) => string) {
  for (let i = 1; i < values.length; i++) if (key(values[i - 1] as T) >= key(values[i] as T)) throw failed();
}
export type AppRuntimeExpectation = {
  pointId: string;
  rootSha256: string;
  dockerContextSha256: string;
  daemonSha256: string;
  configurationSetSha256: string;
  preparationSha256: string;
  entrySha256: string;
};
class AppRuntimeCapture {
  readonly #bytes: Buffer;
  constructor(
    readonly metadata: AppRuntimeCaptureMetadata,
    bytes: Uint8Array,
  ) {
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(metadata);
    this.#bytes = Buffer.from(bytes);
    Object.freeze(this);
  }
  read() {
    return Buffer.from(this.#bytes);
  }
  toJSON(): never {
    throw failed();
  }
}
export function decodeAppRuntimeCapture(bytes: Uint8Array, expected: AppRuntimeExpectation) {
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > appRuntimeEntryLimit ||
    !/^[a-f0-9]{64}$/.test(expected.entrySha256) ||
    sha(bytes) !== expected.entrySha256
  )
    throw failed();
  let text: string;
  let raw: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    raw = JSON.parse(text);
  } catch {
    throw failed();
  }
  bounded(raw);
  if (canonicalAppRuntimeJson(raw) !== text) throw failed();
  const value = schema(raw);
  if (value instanceof type.errors) throw failed();
  const { sha256, ...body } = value;
  if (
    sha(`${value.schema}\n${canonicalAppRuntimeJson(body)}`) !== sha256 ||
    value.pointId !== expected.pointId ||
    value.rootSha256 !== expected.rootSha256 ||
    value.dockerContextSha256 !== expected.dockerContextSha256 ||
    value.daemonSha256 !== expected.daemonSha256 ||
    value.configurationSetSha256 !== expected.configurationSetSha256 ||
    value.preparationSha256 !== expected.preparationSha256
  )
    throw failed();
  ordered(value.apps, (item) => item.urn);
  ordered(value.networkDefinitions, (item) => item.name);
  const representedApps = new Set(value.containers.map((item) => item.appUrn));
  const appIds = new Set<number>();
  const containerIds = new Set<string>();
  const containerNames = new Set<string>();
  const serviceCounts = new Map<string, number>();
  const networks = new Map(value.networkDefinitions.map((item) => [item.name, item.sourceNetworkId]));
  const usedNetworks = new Set<string>();
  for (const item of value.apps) {
    if (appIds.has(item.id) || item.project !== item.urn.replace(':', '_')) throw failed();
    appIds.add(item.id);
    ordered(item.savedFiles, (x) => x.name);
    ordered(item.services, (x) => x.name);
    const [appName, store] = item.urn.split(':');
    const savedRoot = `data/apps/${store}/${appName}`;
    const allowedFiles = new Set([
      `${savedRoot}/config.json`,
      `${savedRoot}/docker-compose.yml`,
      `${savedRoot}/docker-compose.json`,
      `${savedRoot}/docker-compose.generated.yml`,
      `app-data/${store}/${appName}/app.env`,
      `data/user-config/${store}/${appName}/docker-compose.yml`,
    ]);
    for (const saved of item.savedFiles) if (backupMemberName(saved.name) !== saved.name || !allowedFiles.has(saved.name)) throw failed();
    if (item.sourceSha256 !== sha(`orbis.app-runtime-saved-source.v1\n${canonicalAppRuntimeJson(item.savedFiles)}`)) throw failed();
    const config = item.savedFiles.find((saved) => saved.name === `data/apps/${store}/${appName}/config.json`);
    if (
      config
        ? config.sha256 !== item.configurationSha256
        : item.status !== 'missing' || representedApps.has(item.urn) || item.configurationSha256 !== sha('')
    )
      throw failed();
    for (const svc of item.services) serviceCounts.set(`${item.urn}\0${svc.name}`, svc.replicas);
  }
  for (let i = 0; i < value.containers.length; i++) {
    const item = value.containers[i] as typeof container.infer;
    const previous = value.containers[i - 1];
    if (
      previous &&
      (previous.appUrn > item.appUrn ||
        (previous.appUrn === item.appUrn &&
          (previous.service > item.service || (previous.service === item.service && previous.ordinal >= item.ordinal))))
    )
      throw failed();
    if (
      !object(item.inspect.Config) ||
      !object(item.inspect.HostConfig) ||
      !Array.isArray(item.inspect.Mounts) ||
      !object(item.inspect.NetworkSettings.Networks) ||
      !/^\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(item.inspect.Name) ||
      item.inspect.Image !== item.image.sourceImageId ||
      containerIds.has(item.inspect.Id) ||
      containerNames.has(item.inspect.Name)
    )
      throw failed();
    if (item.image.selection === 'docker-config.v1' && item.image.creationReference !== item.image.sourceImageId) throw failed();
    const ports = item.inspect.NetworkSettings.Ports;
    if (ports !== null) {
      if (!object(ports) || Object.keys(ports).length > 1024) throw failed();
      let count = 0;
      for (const [port, values] of Object.entries(ports)) {
        const match = /^([1-9][0-9]{0,4})\/(tcp|udp|sctp)$/.exec(port);
        if (!match || Number(match[1]) > 65535) throw failed();
        if (values === null) continue;
        if (!Array.isArray(values) || values.length > 64) throw failed();
        count += values.length;
        if (count > 4096) throw failed();
        const seen = new Set<string>();
        for (const binding of values) {
          if (
            !object(binding) ||
            Object.keys(binding).sort().join('\0') !== 'HostIp\0HostPort' ||
            typeof binding.HostIp !== 'string' ||
            !isIP(binding.HostIp) ||
            binding.HostIp.includes('%') ||
            typeof binding.HostPort !== 'string' ||
            !/^[1-9][0-9]{0,4}$/.test(binding.HostPort) ||
            Number(binding.HostPort) > 65535
          )
            throw failed();
          const identity = `${binding.HostIp}\0${binding.HostPort}`;
          if (seen.has(identity)) throw failed();
          seen.add(identity);
        }
      }
    }
    const labels = item.inspect.Config.Labels;
    if (
      !object(labels) ||
      labels['com.docker.compose.project'] !== item.appUrn.replace(':', '_') ||
      labels['com.docker.compose.service'] !== item.service ||
      labels['com.docker.compose.container-number'] !== String(item.ordinal) ||
      labels['runtipi.appurn'] !== item.appUrn ||
      String(labels['runtipi.managed']).toLowerCase() !== 'true' ||
      String(labels['com.docker.compose.oneoff']).toLowerCase() !== 'false'
    )
      throw failed();
    const destinations = new Set<string>();
    for (const mount of item.inspect.Mounts) {
      if (
        !object(mount) ||
        typeof mount.Destination !== 'string' ||
        !mount.Destination.startsWith('/') ||
        typeof mount.RW !== 'boolean' ||
        destinations.has(mount.Destination)
      )
        throw failed();
      destinations.add(mount.Destination);
    }
    for (const [networkName, endpoint] of Object.entries(item.inspect.NetworkSettings.Networks)) {
      const expectedId = networks.get(networkName);
      if (
        !expectedId ||
        !object(endpoint) ||
        (endpoint.NetworkID !== undefined &&
          (typeof endpoint.NetworkID !== 'string' || (endpoint.NetworkID !== '' && endpoint.NetworkID !== expectedId)))
      )
        throw failed();
      usedNetworks.add(networkName);
    }
    const key = `${item.appUrn}\0${item.service}`;
    const remaining = serviceCounts.get(key);
    if (remaining === undefined || remaining <= 0) throw failed();
    serviceCounts.set(key, remaining - 1);
    containerIds.add(item.inspect.Id);
    containerNames.add(item.inspect.Name);
  }
  for (const item of value.networkDefinitions)
    if (!object(item.inspect) || item.inspect.Id !== item.sourceNetworkId || item.inspect.Name !== item.name) throw failed();
  if (usedNetworks.size !== networks.size || [...serviceCounts.values()].some((remaining) => remaining !== 0)) throw failed();
  let lastKey = '';
  let lastOrdinal = 0;
  for (const item of value.containers) {
    const key = `${item.appUrn}\0${item.service}`;
    lastOrdinal = key === lastKey ? lastOrdinal + 1 : 1;
    if (item.ordinal !== lastOrdinal) throw failed();
    lastKey = key;
  }
  return new AppRuntimeCapture(value, bytes);
}

/** Projects only decoder-authenticated historical containers; saved Compose is never consulted. */
export function appRuntimeImageBindings(runtime: AppRuntimeCapture) {
  if (!(runtime instanceof AppRuntimeCapture)) throw failed();
  return Object.freeze(
    runtime.metadata.containers.map((item) =>
      Object.freeze({
        key: `apps/${item.appUrn}/${item.service}/${item.ordinal}`,
        imageId: item.image.sourceImageId,
        containerId: item.inspect.Id,
        project: item.appUrn.replace(':', '_'),
        service: item.service,
        ordinal: item.ordinal,
        wasRunning: item.wasRunning,
      }),
    ),
  );
}
