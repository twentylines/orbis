import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appRuntimeImageBindings, canonicalAppRuntimeJson, decodeAppRuntimeCapture } from './time-machine-app-runtime-capture';

const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const h = 'a'.repeat(64);
const image = `sha256:${'b'.repeat(64)}`;
const pointId = 'a2e0a9a1-b78e-49a5-9342-560b420cfd76';
function fixture() {
  return {
    schema: 'orbis.app-runtime-capture.v1',
    version: 1,
    pointId,
    rootSha256: h,
    dockerContextSha256: h,
    daemonSha256: h,
    configurationSetSha256: h,
    preparationSha256: h,
    capturedAt: 42,
    apps: [
      {
        id: 1,
        urn: 'demo:store',
        project: 'demo_store',
        status: 'running',
        pendingRestart: true,
        userConfigEnabled: true,
        sourceSha256: hash(
          `orbis.app-runtime-saved-source.v1\n${canonicalAppRuntimeJson([{ name: 'data/apps/store/demo/config.json', bytes: 4, sha256: h }])}`,
        ),
        configurationSha256: h,
        savedFiles: [{ name: 'data/apps/store/demo/config.json', bytes: 4, sha256: h }],
        services: [{ name: 'web', replicas: 2 }],
      },
    ],
    containers: [1, 2].map((ordinal) => ({
      appUrn: 'demo:store',
      service: 'web',
      ordinal,
      wasRunning: ordinal === 1,
      inspect: {
        Id: `${ordinal}`.repeat(64),
        Name: `/demo-${ordinal}`,
        Image: image,
        Config: {
          Env: ['VERSION=old'],
          Labels: {
            'com.docker.compose.project': 'demo_store',
            'com.docker.compose.service': 'web',
            'com.docker.compose.container-number': String(ordinal),
            'com.docker.compose.oneoff': 'False',
            'runtipi.appurn': 'demo:store',
            'runtipi.managed': 'true',
          },
        },
        HostConfig: { Binds: ['/data:/data:rw'] },
        Mounts: [],
        NetworkSettings: { Networks: {}, Ports: null },
      },
      image: {
        sourceImageId: image,
        creationReference: image,
        platform: { os: 'linux', architecture: 'arm64', variant: 'v8' },
        selection: 'docker-config.v1',
      },
      transformPolicy: 'orbis.app-runtime-transform.same-host.v1',
    })),
    networkDefinitions: [],
  };
}
function encoded(value = fixture()) {
  const internal = hash(`${value.schema}\n${canonicalAppRuntimeJson(value)}`);
  const bytes = Buffer.from(canonicalAppRuntimeJson({ ...value, sha256: internal }));
  return {
    bytes,
    expected: {
      pointId,
      rootSha256: h,
      dockerContextSha256: h,
      daemonSha256: h,
      configurationSetSha256: h,
      preparationSha256: h,
      entrySha256: hash(bytes),
    },
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}

describe('protected historical app runtime', () => {
  it('preserves pending saved configuration and each captured replica state', () => {
    const { bytes, expected } = encoded();
    const result = decodeAppRuntimeCapture(bytes, expected);
    expect(result.metadata.apps[0]?.pendingRestart).toBe(true);
    expect(result.metadata.containers.map((x) => x.wasRunning)).toEqual([true, false]);
    expect(appRuntimeImageBindings(result).map(({ key, wasRunning }) => ({ key, wasRunning }))).toEqual([
      { key: 'apps/demo:store/web/1', wasRunning: true },
      { key: 'apps/demo:store/web/2', wasRunning: false },
    ]);
    expect(() => appRuntimeImageBindings({ metadata: result.metadata } as never)).toThrow();
    expect(result.metadata.containers[0]?.inspect.Config).toMatchObject({ Env: ['VERSION=old'] });
    expect(result.read()).toEqual(bytes);
    expect(() => JSON.stringify(result)).toThrow();
  });
  it('retains an inactive user override as saved data without enabling it', () => {
    const value = fixture();
    const app = required(value.apps[0]);
    app.userConfigEnabled = false;
    app.savedFiles.push({ name: 'data/user-config/store/demo/docker-compose.yml', bytes: 3, sha256: h });
    app.sourceSha256 = hash(`orbis.app-runtime-saved-source.v1\n${canonicalAppRuntimeJson(app.savedFiles)}`);
    const { bytes, expected } = encoded(value);
    const result = decodeAppRuntimeCapture(bytes, expected);
    expect(result.metadata.apps[0]?.userConfigEnabled).toBe(false);
    expect(result.metadata.apps[0]?.savedFiles).toHaveLength(2);
    expect(appRuntimeImageBindings(result).map((item) => item.wasRunning)).toEqual([true, false]);
  });
  it('accepts the built-in custom store and rejects other leading-underscore stores', () => {
    for (const store of ['_user', '_other']) {
      const value = fixture();
      const app = required(value.apps[0]);
      app.urn = `demo:${store}`;
      app.project = `demo_${store}`;
      app.savedFiles = [{ name: `data/apps/${store}/demo/config.json`, bytes: 4, sha256: h }];
      app.sourceSha256 = hash(`orbis.app-runtime-saved-source.v1\n${canonicalAppRuntimeJson(app.savedFiles)}`);
      for (const container of value.containers) {
        container.appUrn = app.urn;
        container.inspect.Config.Labels['com.docker.compose.project'] = app.project;
        container.inspect.Config.Labels['runtipi.appurn'] = app.urn;
      }
      const { bytes, expected } = encoded(value);
      if (store === '_user') expect(decodeAppRuntimeCapture(bytes, expected).metadata.apps[0]?.urn).toBe('demo:_user');
      else expect(() => decodeAppRuntimeCapture(bytes, expected)).toThrow();
    }
  });
  it('preserves exact observed IPv4 and IPv6 ports and rejects malformed bindings', () => {
    const valid = {
      '80/tcp': [
        { HostIp: '0.0.0.0', HostPort: '32123' },
        { HostIp: '::', HostPort: '32123' },
      ],
      '53/udp': null,
      '443/tcp': [],
    };
    const value = fixture();
    Object.assign(required(value.containers[0]).inspect.NetworkSettings, { Ports: valid });
    const good = encoded(value);
    expect(decodeAppRuntimeCapture(good.bytes, good.expected).metadata.containers[0]?.inspect.NetworkSettings.Ports).toEqual(valid);
    for (const ports of [
      { '080/tcp': null },
      { '65536/tcp': null },
      { '80/http': null },
      { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
      { '80/tcp': [{ HostIp: '[::1]', HostPort: '1234' }] },
      { '80/tcp': [{ HostIp: 'fe80::1%eth0', HostPort: '1234' }] },
      { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '01234' }] },
      {
        '80/tcp': [
          { HostIp: '127.0.0.1', HostPort: '1234' },
          { HostIp: '127.0.0.1', HostPort: '1234' },
        ],
      },
      { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '1234', extra: true }] },
      { '80/tcp': Array.from({ length: 65 }, (_, index) => ({ HostIp: '127.0.0.1', HostPort: String(index + 1) })) },
      Object.fromEntries(
        Array.from({ length: 65 }, (_, port) => [
          `${port + 1}/tcp`,
          Array.from({ length: 64 }, (_, index) => ({ HostIp: '127.0.0.1', HostPort: String(index + 1) })),
        ]),
      ),
      Object.fromEntries(Array.from({ length: 1025 }, (_, port) => [`${port + 1}/tcp`, null])),
    ]) {
      Object.assign(required(value.containers[0]).inspect.NetworkSettings, { Ports: ports });
      const bad = encoded(value);
      expect(() => decodeAppRuntimeCapture(bad.bytes, bad.expected)).toThrow();
    }
  });
  it('uses UTF-16 lexical ordering for numeric and prototype-like Docker label keys without mutating prototypes', () => {
    const value = fixture();
    const labels = required(value.containers[0]).inspect.Config.Labels;
    const extra = JSON.parse(
      '{"2":"two","10":"ten","01":"zero-one","__proto__":"safe","constructor":"safe","prototype":"safe","😀":"supplementary","":"bmp"}',
    ) as Record<string, string>;
    for (const [key, item] of Object.entries(extra)) Object.defineProperty(labels, key, { value: item, enumerable: true, configurable: true });
    expect(Object.getPrototypeOf(labels)).toBe(Object.prototype);
    const text = canonicalAppRuntimeJson(labels);
    const order = ['"01"', '"10"', '"2"', '"__proto__"', '"constructor"', '"prototype"', '"😀"', '""'].map((key) => text.indexOf(key));
    expect(order.every((position, index) => position >= 0 && (index === 0 || position > required(order[index - 1])))).toBe(true);
    const { bytes, expected } = encoded(value);
    const decoded = decodeAppRuntimeCapture(bytes, expected);
    const decodedLabels = (decoded.metadata.containers[0]?.inspect.Config as { Labels: Record<string, unknown> }).Labels;
    expect(Object.getPrototypeOf(decodedLabels)).toBe(Object.prototype);
    expect(Object.hasOwn(decodedLabels, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(decodedLabels, '__proto__')?.value).toBe('safe');
  });
  it('requires the independently protected entry and root bindings', () => {
    const { bytes, expected } = encoded();
    for (const key of ['entrySha256', 'rootSha256', 'preparationSha256', 'pointId'] as const) {
      expect(() =>
        decodeAppRuntimeCapture(bytes, { ...expected, [key]: key === 'pointId' ? 'c67a9ce3-44bf-4ce4-a78a-749fd12872ac' : 'c'.repeat(64) }),
      ).toThrow();
    }
    expect(() => decodeAppRuntimeCapture(Buffer.concat([bytes, Buffer.from(' ')]), expected)).toThrow();
  });
  it('rejects invalid replica counts, order, image identity, variants and paths', () => {
    const mutations: ((value: ReturnType<typeof fixture>) => void)[] = [
      (v) => {
        required(v.containers[1]).ordinal = 3;
      },
      (v) => {
        v.containers.reverse();
      },
      (v) => {
        required(v.containers[0]).image.sourceImageId = `sha256:${'c'.repeat(64)}`;
      },
      (v) => {
        required(v.containers[0]).image.platform.variant = 'x'.repeat(33);
      },
      (v) => {
        required(required(v.apps[0]).savedFiles[0]).name = '../secrets';
      },
      (v) => {
        required(required(v.apps[0]).services[0]).replicas = 1;
      },
      (v) => {
        required(v.containers[0]).image.creationReference = `sha256:${'c'.repeat(64)}`;
      },
      (v) => {
        Reflect.set(required(v.containers[0]).inspect.Config.Labels, 'com.docker.compose.service', 'wrong');
      },
      (v) => {
        Reflect.set(required(v.containers[0]).inspect, 'Mounts', [
          { Destination: '/data', RW: true },
          { Destination: '/data', RW: true },
        ]);
      },
      (v) => {
        required(v.apps[0]).sourceSha256 = 'b'.repeat(64);
      },
      (v) => {
        required(v.apps[0]).configurationSha256 = 'b'.repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const value = fixture();
      mutate(value);
      const { bytes, expected } = encoded(value);
      expect(() => decodeAppRuntimeCapture(bytes, expected)).toThrow();
    }
  });
  it('requires the exact protected network definitions and network IDs', () => {
    const value = fixture();
    value.networkDefinitions = [{ name: 'internal', sourceNetworkId: h, inspect: { Id: h, Name: 'internal' } }] as never[];
    required(value.containers[0]).inspect.NetworkSettings.Networks = { internal: { NetworkID: h } };
    required(value.containers[1]).inspect.NetworkSettings.Networks = { internal: { NetworkID: '' } };
    const valid = encoded(value);
    expect(() => decodeAppRuntimeCapture(valid.bytes, valid.expected)).not.toThrow();
    required(value.containers[0]).inspect.NetworkSettings.Networks = { internal: { NetworkID: 'f'.repeat(64) } };
    const invalid = encoded(value);
    expect(() => decodeAppRuntimeCapture(invalid.bytes, invalid.expected)).toThrow();
  });
  it('rejects duplicate JSON keys and unpaired Unicode even with a matching outer hash', () => {
    const { bytes, expected } = encoded();
    const duplicate = Buffer.from(bytes.toString().replace('{', '{"version":1,'));
    expect(() => decodeAppRuntimeCapture(duplicate, { ...expected, entrySha256: hash(duplicate) })).toThrow();
    const value = fixture();
    (required(value.containers[0]).inspect.Config as Record<string, unknown>).bad = '\ud800';
    const invalid = encoded(value);
    expect(() => decodeAppRuntimeCapture(invalid.bytes, invalid.expected)).toThrow();
  });
  it('accepts a missing app with no services and rejects unsafe raw Docker data', () => {
    const value = fixture();
    required(value.apps[0]).status = 'missing';
    required(value.apps[0]).services = [];
    value.containers = [];
    const empty = encoded(value);
    expect(decodeAppRuntimeCapture(empty.bytes, empty.expected).metadata.containers).toEqual([]);
    required(value.apps[0]).savedFiles = [];
    required(value.apps[0]).configurationSha256 = hash('');
    required(value.apps[0]).sourceSha256 = hash(`orbis.app-runtime-saved-source.v1\n${canonicalAppRuntimeJson([])}`);
    const absent = encoded(value);
    expect(decodeAppRuntimeCapture(absent.bytes, absent.expected).metadata.apps[0]?.status).toBe('missing');
    const invalid = fixture();
    (required(invalid.containers[0]).inspect.Config as Record<string, unknown>).bad = 1.5;
    const encodedInvalid = encoded(invalid);
    expect(() => decodeAppRuntimeCapture(encodedInvalid.bytes, encodedInvalid.expected)).toThrow();
  });
});
