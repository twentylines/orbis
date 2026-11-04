import { stabilizeDarwinFixtureCreation } from './darwin-files.fixture';
import type { CapturedRuntimeInput } from './time-machine-runtime-payload';
import { decodeControllerCaptureAuthority } from '../host-updates/host-controller-capture-authority';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ControllerPublicationExpectation } from '../host-updates/host-controller-publication';
import { admitRuntimeFile } from './time-machine-runtime-reader';
import { createCaptureCoherenceReceipt } from './time-machine-capture-coherence';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
};
const roots: string[] = [];
let restoreDarwinCreation: () => void = () => undefined;
beforeEach(() => {
  restoreDarwinCreation = stabilizeDarwinFixtureCreation(() => roots);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  restoreDarwinCreation();
});
async function fixture(version: 3 | 4 | 6 = 3) {
  const { connectedCaptureFixture } = await import('./time-machine-capture.fixture');
  const { runtimePayload, canonicalRuntimeJson } = await import('./time-machine-runtime-payload');
  const { encryptBackupStream } = await import('./backup-crypto');
  const { Readable } = await import('node:stream');
  const { validateRetainedImageInventory } = await import('./backup-image-retention');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-v3-')));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const data = path.join(root, 'data');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, '.env'), 'DISPOSABLE_FIXTURE=true');
  const fixture = await connectedCaptureFixture(data, {});
  const pointId = '11111111-1111-4111-8111-111111111111';
  const configuration = await fixture.host.captureControllerConfiguration({ pointId, controllerId: fixture.ids.core, imageId: fixture.image.id });
  const publicationExpectation: ControllerPublicationExpectation = {
    configuration: configuration.metadata,
    publication: {
      ...fixture.image.publication,
      schema: 'orbis.release.v1',
      image: 'ghcr.io/twentylines/orbis',
      runtipiCompatibility: '4.10.1',
      installationProtocol: 'orbis.installation-state.v1',
    },
    platform: { os: 'linux', architecture: 'arm64' },
  };
  const publication = await fixture.host.prepareControllerPublication(publicationExpectation);
  const archive = fixture.image.archive;
  const inventory = validateRetainedImageInventory({
    version: 1,
    bindings: [
      { key: 'controller/runtipi/runtipi', imageId: fixture.image.id },
      { key: 'controller/runtipi/runtipi-db', imageId: fixture.image.id },
      ...(version !== 3 ? [{ key: 'controller/runtipi/runtipi-reverse-proxy', imageId: fixture.image.id }] : []),
      ...(version === 6 ? [1, 2].map((ordinal) => ({ key: `apps/fixture:store/web/${ordinal}`, imageId: fixture.image.id })) : []),
    ],
    images: [
      {
        imageId: fixture.image.id,
        repoDigests: [],
        archive: `image-${fixture.image.id.slice(7)}.tar`,
        bytes: archive.length,
        sha256: sha(archive),
        identity: {
          kind: 'docker',
          configId: fixture.image.id,
          archiveRootId: fixture.image.id,
          manifestId: null,
          platform: null,
          expandedBytes: 2048,
        },
      },
    ],
  });
  const legacy = { bytes: 52, cipherSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) };
  const capture = {
    schema: 'orbis.time-machine-image-capture.v1' as const,
    pointId,
    createdAt: 1793404800000,
    backupManifestSha256: legacy.manifestSha256,
    platform: publicationExpectation.platform,
    apps: [],
    containers: [
      { ...required(fixture.values.get(fixture.ids.core)), role: 'controller', appUrn: null, key: 'controller/runtipi/runtipi', wasRunning: true },
      {
        ...required(fixture.values.get(fixture.ids.database)),
        role: 'database',
        appUrn: null,
        key: 'controller/runtipi/runtipi-db',
        wasRunning: true,
      },
    ],
    inventory,
    inventorySha256: sha(Buffer.from(canonicalRuntimeJson(inventory))),
    coverage: {
      appData: 'legacy-quiesced-container-copy',
      database: 'legacy-logical-dump',
      controller: 'not-quiesced',
      controllerConfiguration: 'not-captured',
      encryptedEnvelope: 'not-integrated',
      restoreReady: false,
    } as const,
  };
  if (version !== 3)
    capture.containers.push({
      ...required(fixture.values.get(fixture.ids.core)),
      id: 'd'.repeat(64),
      service: 'runtipi-reverse-proxy',
      role: 'controller-service',
      appUrn: null,
      key: 'controller/runtipi/runtipi-reverse-proxy',
      wasRunning: true,
    });
  const runtimeCapture =
    version === 6
      ? {
          ...capture,
          schema: 'orbis.time-machine-image-capture.v2' as const,
          apps: [
            {
              urn: 'fixture:store',
              project: 'fixture_store',
              userConfigEnabled: false,
              sourceSha256: sha(
                `orbis.app-runtime-saved-source.v1\n${(await import('./time-machine-app-runtime-capture')).canonicalAppRuntimeJson([{ name: 'data/apps/store/fixture/config.json', bytes: 4, sha256: 'a'.repeat(64) }])}`,
              ),
              configurationSha256: 'a'.repeat(64),
              services: ['web'],
            },
          ],
          containers: [
            ...capture.containers.map((item) => ({ ...item, ordinal: null })),
            ...[1, 2].map((ordinal) => ({
              ...required(fixture.values.get(fixture.ids.app)),
              id: ordinal === 1 ? fixture.ids.app : 'e'.repeat(64),
              running: false,
              role: 'app',
              appUrn: 'fixture:store',
              key: `apps/fixture:store/web/${ordinal}`,
              wasRunning: ordinal === 1,
              ordinal,
            })),
          ],
        }
      : capture;
  const captureBytes = Buffer.from(canonicalRuntimeJson(runtimeCapture));
  const files = [
    { name: 'capture.json', bytes: captureBytes.length, sha256: sha(captureBytes), open: async () => Readable.from([captureBytes]) },
    {
      name: `images/${required(inventory.images[0]).archive}`,
      bytes: archive.length,
      sha256: sha(archive),
      open: async () => Readable.from([archive]),
    },
  ];
  const signal = new AbortController().signal;
  let authority = await fixture.fence.finalizeControllerArchive(
    publicationExpectation,
    publication,
    required(inventory.images[0]),
    async () => Readable.from([archive]),
    signal,
  );
  let appRuntime: ReturnType<typeof import('./time-machine-app-runtime-capture').decodeAppRuntimeCapture> | undefined;
  if (version !== 3) {
    const policyDescriptor = {
      schema: 'orbis.proxy-host-identity-policy.v1',
      policy: 'preserve-live-proxy-identity.v1',
      rootSha256: configuration.metadata.rootIdentity.pathSha256,
      dockerContextSha256: sha('fixture-context'),
      configuration: {
        destination: '/etc/traefik',
        readOnly: true,
        staticSha256: sha('fixture-static'),
        capture: 'encrypted-review-only',
        restore: 'preserve-live',
      },
      mutableIdentity: { destination: '/shared', capture: 'excluded', restore: 'preserve-live', ownershipSha256: sha('fixture-protected-ownership') },
      proxy: { containerId: 'd'.repeat(64), imageId: fixture.image.id },
    };
    const proxyHostIdentity = { ...policyDescriptor, sha256: sha(`orbis.proxy-host-identity-policy.v1\n${canonicalRuntimeJson(policyDescriptor)}`) };
    const { authoritySha256: _old, ...old } = authority.metadata;
    let appHashes = {};
    if (version === 6) {
      const { canonicalAppRuntimeJson, decodeAppRuntimeCapture } = await import('./time-machine-app-runtime-capture');
      const raw = {
        schema: 'orbis.app-runtime-capture.v1',
        version: 1,
        pointId,
        rootSha256: configuration.metadata.rootIdentity.pathSha256,
        dockerContextSha256: proxyHostIdentity.dockerContextSha256,
        daemonSha256: sha('daemon'),
        configurationSetSha256: configuration.metadata.configurationSetSha256,
        preparationSha256: publication.metadata.preparationSha256,
        capturedAt: Date.now(),
        apps: [
          {
            id: 1,
            urn: 'fixture:store',
            project: 'fixture_store',
            status: 'running',
            pendingRestart: true,
            userConfigEnabled: false,
            savedFiles: [{ name: 'data/apps/store/fixture/config.json', bytes: 4, sha256: 'a'.repeat(64) }],
            sourceSha256: runtimeCapture.apps[0]?.sourceSha256,
            configurationSha256: 'a'.repeat(64),
            services: [{ name: 'web', replicas: 2 }],
          },
        ],
        containers: [1, 2].map((ordinal) => ({
          appUrn: 'fixture:store',
          service: 'web',
          ordinal,
          wasRunning: ordinal === 1,
          inspect: {
            Id: ordinal === 1 ? fixture.ids.app : 'e'.repeat(64),
            Name: `/fixture-${ordinal}`,
            Image: fixture.image.id,
            Config: {
              Image: 'fixture:v1',
              Env: ['VERSION=old'],
              Labels: {
                'com.docker.compose.project': 'fixture_store',
                'com.docker.compose.service': 'web',
                'com.docker.compose.container-number': String(ordinal),
                'com.docker.compose.oneoff': 'False',
                'runtipi.appurn': 'fixture:store',
                'runtipi.managed': 'true',
              },
            },
            HostConfig: {},
            Mounts: [],
            NetworkSettings: {
              Networks: {},
              Ports:
                ordinal === 1
                  ? {
                      '80/tcp': [
                        { HostIp: '0.0.0.0', HostPort: '32000' },
                        { HostIp: '::', HostPort: '32000' },
                      ],
                    }
                  : null,
            },
          },
          image: {
            sourceImageId: fixture.image.id,
            creationReference: fixture.image.id,
            platform: { os: 'linux', architecture: 'arm64' },
            selection: 'docker-config.v1',
          },
          transformPolicy: 'orbis.app-runtime-transform.same-host.v1',
        })),
        networkDefinitions: [],
      };
      const blob = Buffer.from(canonicalAppRuntimeJson({ ...raw, sha256: sha(`${raw.schema}\n${canonicalAppRuntimeJson(raw)}`) }));
      appRuntime = decodeAppRuntimeCapture(blob, {
        pointId,
        rootSha256: raw.rootSha256,
        dockerContextSha256: raw.dockerContextSha256,
        daemonSha256: raw.daemonSha256,
        configurationSetSha256: raw.configurationSetSha256,
        preparationSha256: raw.preparationSha256,
        entrySha256: sha(blob),
      });
      appHashes = { appRuntimeSha256: sha(blob), appRuntimeDaemonSha256: raw.daemonSha256 };
    }
    const authoritySchema = version === 6 ? 'orbis.controller-capture-authority.v4' : 'orbis.controller-capture-authority.v2';
    const descriptor = { ...old, schema: authoritySchema, version: version === 6 ? 4 : 2, proxyHostIdentity, ...appHashes };
    authority = decodeControllerCaptureAuthority(
      { ...descriptor, authoritySha256: sha(`${authoritySchema}\n${canonicalRuntimeJson(descriptor)}`) },
      publicationExpectation,
      publication,
      required(inventory.images[0]),
    );
  }
  const now = Date.now();
  const queue = {
    pauseId: randomUUID(),
    generation: 1,
    checkedAt: now,
    queues: [
      { name: 'app-events-queue' as const, messages: 0 as const, consumers: 0 as const },
      { name: 'repo-queue' as const, messages: 0 as const, consumers: 0 as const },
      { name: 'system-events-queue' as const, messages: 0 as const, consumers: 0 as const },
    ],
  };
  const coherence = createCaptureCoherenceReceipt({
    schema: 'orbis.capture-coherence.v1',
    scope: 'orbis-managed-writers.v1',
    pointId,
    transactionId: randomUUID(),
    createdAt: now,
    sealedAt: now,
    managedWritesHeldAt: now,
    database: { containerId: fixture.ids.database, bytes: 5, sha256: sha('db123') },
    manifestSha256: legacy.manifestSha256,
    apps:
      version === 6
        ? [
            { id: fixture.ids.app, project: 'fixture_store', wasRunning: true, state: 'stopped' },
            { id: 'e'.repeat(64), project: 'fixture_store', wasRunning: false, state: 'stopped' },
          ]
        : [],
    queueStart: queue,
    queueEnd: queue,
    hostFence: {
      configurationSetSha256: configuration.metadata.configurationSetSha256,
      preparationSha256: publication.metadata.preparationSha256,
      verifiedAt: now,
    },
    publicationProofSha256: sha(publication.read()),
    imageCaptureSha256: sha(captureBytes),
    imageInventorySha256: capture.inventorySha256,
    controllerAuthoritySha256: sha(authority.read()),
  });
  const input = {
    images: { capture: runtimeCapture, files, sha256: sha(captureBytes), dispose: async () => undefined } as never,
    ...(appRuntime ? { appRuntime } : {}),
    configuration,
    publication,
    publicationExpectation,
    coherence,
    controllerAuthority: authority,
  };
  const payload = runtimePayload(input, legacy, signal);
  const source = path.join(root, 'runtime.orbis');
  await encryptBackupStream({
    source: payload.stream,
    plaintextBytes: payload.bytes,
    destination: source,
    passphrase: 'test-passphrase-long',
    signal,
  });
  const stagingParent = path.join(root, 'staging');
  await fs.mkdir(stagingParent, { mode: 0o700 });
  return {
    input,
    legacy,
    signal,
    options: {
      source,
      stagingParent,
      passphrase: 'test-passphrase-long',
      signal,
      maximumBytes: 1024 * 1024,
      expected: { manifest: payload.manifest, manifestSha256: payload.manifestSha256, publication: publicationExpectation },
    },
  };
}
it('admits a produced v3 payload only against its independent authenticated point descriptor', async () => {
  const test = await fixture();
  const result = await admitRuntimeFile(test.options);
  expect(result.manifest.schema).toBe('orbis.time-machine-runtime.v3');
  expect(result.coherence?.database.sha256).toBe(sha('db123'));
  expect(result.controllerAuthority?.metadata.pointId).toBe(test.input.configuration.metadata.pointId);
  expect(result.restoreReady).toBe(false);
  await result.dispose();
  const expected = structuredClone(test.options.expected);
  expected.manifestSha256 = 'f'.repeat(64);
  await expect(admitRuntimeFile({ ...test.options, expected })).rejects.toThrow();
  const wrongPublication = structuredClone(test.options.expected);
  wrongPublication.publication.platform.architecture = 'amd64';
  await expect(admitRuntimeFile({ ...test.options, expected: wrongPublication })).rejects.toThrow();
  const ciphertext = await fs.readFile(test.options.source);
  ciphertext[ciphertext.length - 1] = (ciphertext[ciphertext.length - 1] ?? 0) ^ 1;
  await fs.writeFile(test.options.source, ciphertext);
  await expect(admitRuntimeFile(test.options)).rejects.toThrow();
  expect(await fs.readdir(test.options.stagingParent)).toEqual([]);
});
it('rejects missing authority and changed coherence, queue generation or host configuration before sealing', async () => {
  const { runtimePayload } = await import('./time-machine-runtime-payload');
  const test = await fixture();
  expect(() => runtimePayload({ ...test.input, controllerAuthority: undefined }, test.legacy, test.signal)).toThrow();
  for (const kind of ['receipt', 'queue', 'config'] as const) {
    const coherence = structuredClone(test.input.coherence);
    if (kind === 'receipt') coherence.database.sha256 = 'f'.repeat(64);
    if (kind === 'queue') coherence.queueEnd = { ...coherence.queueEnd, generation: coherence.queueEnd.generation + 1 };
    if (kind === 'config') coherence.hostFence.configurationSetSha256 = 'f'.repeat(64);
    expect(() => runtimePayload({ ...test.input, coherence }, test.legacy, test.signal), kind).toThrow();
    const { sha256: _sha, ...descriptor } = coherence;
    if (kind === 'queue') expect(() => createCaptureCoherenceReceipt(descriptor)).toThrow();
    if (kind === 'config') {
      const resigned = createCaptureCoherenceReceipt(descriptor);
      expect(() => runtimePayload({ ...test.input, coherence: resigned }, test.legacy, test.signal)).toThrow();
    }
  }
});

it('admits v4 only with its protected proxy policy and retains v3 strictness', async () => {
  const { decodeRuntimePayloadManifest, runtimePayload } = await import('./time-machine-runtime-payload');
  const test = await fixture(4);
  const result = await admitRuntimeFile(test.options);
  expect(result.manifest.schema).toBe('orbis.time-machine-runtime.v4');
  expect(result.controllerAuthority?.metadata.version).toBe(2);
  expect(result.files.has('host-identity/proxy.json')).toBe(true);
  expect(result.restoreReady).toBe(false);
  const metadata = structuredClone(test.options.expected.manifest);
  expect(() => decodeRuntimePayloadManifest({ ...metadata, schema: 'orbis.time-machine-runtime.v3' })).toThrow();
  if (metadata.schema !== 'orbis.time-machine-runtime.v4') throw new Error('Expected v4 fixture');
  metadata.proxyHostIdentitySha256 = 'f'.repeat(64);
  expect(() => decodeRuntimePayloadManifest(metadata)).toThrow();
  const images = test.input.images as CapturedRuntimeInput['images'];
  if ('version' in images || images.capture.schema !== 'orbis.time-machine-image-capture.v1') throw new Error('Expected v1 image capture fixture');
  const capture = { ...images.capture, containers: images.capture.containers.filter((item) => item.service !== 'runtipi-reverse-proxy') };
  expect(() => runtimePayload({ ...test.input, images: { ...images, capture } }, test.legacy, test.signal)).toThrow();
  await result.dispose();
});

it('admits a v6 runtime with mixed replicas only against its independent protected descriptor', async () => {
  const test = await fixture(6);
  expect(test.options.expected.manifest.schema).toBe('orbis.time-machine-runtime.v6');
  if (test.options.expected.manifest.schema !== 'orbis.time-machine-runtime.v6' || !test.input.appRuntime) throw new Error('Missing v6 fixture');
  expect(test.options.expected.manifest.appRuntimeSha256).toBe(sha(test.input.appRuntime.read()));
  const admitted = await admitRuntimeFile(test.options);
  expect(admitted.appRuntime?.metadata.apps[0]).toMatchObject({ pendingRestart: true, userConfigEnabled: false });
  expect(admitted.appRuntime?.metadata.containers.map((entry) => entry.wasRunning)).toEqual([true, false]);
  expect(admitted.appRuntime?.metadata.containers[0]?.inspect.NetworkSettings.Ports).toEqual({
    '80/tcp': [
      { HostIp: '0.0.0.0', HostPort: '32000' },
      { HostIp: '::', HostPort: '32000' },
    ],
  });
  await admitted.dispose();
  const changedExpectation = structuredClone(test.options.expected);
  changedExpectation.manifestSha256 = 'f'.repeat(64);
  await expect(admitRuntimeFile({ ...test.options, expected: changedExpectation })).rejects.toThrow();
  const { runtimePayload } = await import('./time-machine-runtime-payload');
  expect(() => runtimePayload({ ...test.input, appRuntime: undefined }, test.legacy, test.signal)).toThrow();
  expect(() => runtimePayload({ ...test.input, controllerAuthority: undefined }, test.legacy, test.signal)).toThrow();
  const input = test.input as CapturedRuntimeInput;
  for (const change of ['ordinal', 'state', 'missing'] as const) {
    const capture = structuredClone(input.images.capture) as unknown as {
      schema: string;
      containers: { role: string; ordinal: number | null; wasRunning: boolean }[];
    };
    if (capture.schema !== 'orbis.time-machine-image-capture.v2') throw new Error('Expected v2 image capture');
    const app = capture.containers.find((item) => item.role === 'app');
    if (!app) throw new Error('Missing app replica');
    if (change === 'ordinal') app.ordinal = 9;
    if (change === 'state') app.wasRunning = !app.wasRunning;
    if (change === 'missing') capture.containers.splice(capture.containers.indexOf(app), 1);
    expect(() => runtimePayload({ ...input, images: { ...input.images, capture } as never }, test.legacy, test.signal)).toThrow();
  }
  const authority = input.controllerAuthority;
  if (!authority || authority.metadata.version !== 4) throw new Error('Missing protected v4 authority');
  const { authoritySha256: _old, ...descriptor } = authority.metadata;
  const changed = { ...descriptor, appRuntimeSha256: 'f'.repeat(64) };
  const { canonicalRuntimeJson } = await import('./time-machine-runtime-payload');
  const altered = decodeControllerCaptureAuthority(
    { ...changed, authoritySha256: sha(`${changed.schema}\n${canonicalRuntimeJson(changed)}`) },
    input.publicationExpectation,
    input.publication,
    required(input.images.capture.inventory.images[0]),
  );
  expect(() => runtimePayload({ ...input, controllerAuthority: altered }, test.legacy, test.signal)).toThrow();
});

it('rejects v6 point sealing before consuming the archive while the capture gate is closed', async () => {
  const test = await fixture(6);
  const { TimeMachineStore } = await import('./time-machine-store');
  const { Readable } = await import('node:stream');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'v6-seal-gate-')));
  roots.push(directory);
  await fs.chmod(directory, 0o700);
  const store = new TimeMachineStore(directory);
  const { point } = await store.create(1, 2);
  let consumed = false;
  const source = Readable.from(
    (async function* () {
      consumed = true;
      yield Buffer.alloc(52);
    })(),
  );
  await expect(
    store.seal(point, source, 52, { version: 2, manifestSha256: test.legacy.manifestSha256 } as never, test.signal, {
      input: test.input as CapturedRuntimeInput,
    }),
  ).rejects.toThrow();
  expect(consumed).toBe(false);
  expect((await store.load(point.id)).status).toBe('capturing');
  expect(await fs.readdir(path.join(directory, 'backups', 'time-machine', 'points', point.id))).toEqual(['point.json']);
});

it('rejects a runtime changed to v6 after planning and removes the partial archive', async () => {
  const earlier = await fixture(4);
  const later = await fixture(6);
  const { TimeMachineStore } = await import('./time-machine-store');
  const { Readable } = await import('node:stream');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'v6-seal-change-')));
  roots.push(directory);
  await fs.chmod(directory, 0o700);
  const store = new TimeMachineStore(directory);
  const { point } = await store.create(1, 2);
  const runtime = { input: earlier.input as CapturedRuntimeInput };
  let consumed = false;
  const source = Readable.from(
    (async function* () {
      consumed = true;
      runtime.input = later.input as CapturedRuntimeInput;
      yield Buffer.concat([Buffer.from('ORBISBK1'), Buffer.alloc(44)]);
    })(),
  );
  await expect(
    store.seal(
      point,
      source,
      52,
      { version: 2, manifestSha256: earlier.legacy.manifestSha256, preview: { available: false } } as never,
      earlier.signal,
      runtime,
    ),
  ).rejects.toThrow();
  expect(consumed).toBe(true);
  expect((await store.load(point.id)).status).toBe('capturing');
  expect(await fs.readdir(path.join(directory, 'backups', 'time-machine', 'points', point.id))).toEqual(['point.json']);
});

it('does not turn a decoded v6 receipt or caller-created object into protected capture authority', async () => {
  const test = await fixture(6);
  const { createV6SealAdmission } = await import('./time-machine-v6-seal-admission');
  const { BackupImportsService } = await import('./backup-imports.service');
  const input = test.input as CapturedRuntimeInput;
  const imports = Object.create(BackupImportsService.prototype) as InstanceType<typeof BackupImportsService>;
  expect(() =>
    createV6SealAdmission({
      input,
      pointId: input.configuration.metadata.pointId,
      ownerId: 1,
      bytes: 52,
      manifestSha256: test.legacy.manifestSha256,
      passphrase: 'private-fixture-passphrase',
      imports,
      signal: test.signal,
    }),
  ).toThrow();
});
