import { decodeControllerCaptureAuthority } from './host-controller-capture-authority';
import { Readable } from 'node:stream';
import type { RetainedImage } from '../system-backups/backup-image-retention';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { HostUpdatesService } from './host-updates.service';
import { controllerPublicationSource } from '../system-backups/time-machine-capture-runtime';
import { controllerConfigPaths, decodeControllerConfigurationCapture } from './host-controller-config';
import {
  canonicalPublicationJson as canonical,
  controllerPublicationLimits,
  decodeControllerPublicationReceipt,
  parseControllerPublicationResponse,
} from './host-controller-publication';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: Buffer) => `sha256:${sha(value)}`;
const encode = (value: unknown) => Buffer.from(canonical(value));
const platform = { os: 'linux' as const, architecture: 'arm64' as const };
const tag = 'v0.5.0-beta.3';
const commit = 'a'.repeat(40);
const imageType = 'application/vnd.oci.image.manifest.v1+json';
function fixture(options: { config?: (value: Record<string, unknown>) => void; index?: (value: Record<string, unknown>) => void } = {}) {
  const config: Record<string, unknown> = {
    os: 'linux',
    architecture: 'arm64',
    config: {
      Labels: {
        'org.opencontainers.image.source': 'https://github.com/twentylines/orbis',
        'org.opencontainers.image.version': tag,
        'org.opencontainers.image.revision': commit,
        'io.orbis.installation-protocol': 'orbis.installation-state.v1',
      },
    },
    rootfs: { type: 'layers', diff_ids: [`sha256:${'1'.repeat(64)}`] },
  };
  options.config?.(config);
  const configBytes = encode(config);
  const manifest = encode({
    schemaVersion: 2,
    mediaType: imageType,
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digest(configBytes), size: configBytes.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${'2'.repeat(64)}`, size: 128 }],
  });
  const indexValue: Record<string, unknown> = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{ mediaType: imageType, digest: digest(manifest), size: manifest.length, platform }],
  };
  options.index?.(indexValue);
  const index = encode(indexValue);
  const publication = {
    schema: 'orbis.release.v1' as const,
    image: 'ghcr.io/twentylines/orbis' as const,
    tag,
    commit,
    digest: digest(index),
    runtipiCompatibility: '4.10.1' as const,
    installationProtocol: 'orbis.installation-state.v1' as const,
  };
  const identity = { pointId: '11111111-1111-4111-8111-111111111111', controllerId: 'b'.repeat(64), imageId: digest(configBytes) };
  const bytes = Buffer.from('local capture fixture');
  const files = controllerConfigPaths.map((name) =>
    name === 'orbis-host-compose.yml' || name === 'user-config/tipi-compose.yml'
      ? { path: name, present: false as const }
      : {
          path: name,
          present: true as const,
          bytes: bytes.length,
          mode: 0o600,
          uid: 0,
          gid: 0,
          device: '1',
          inode: '2',
          mtimeNs: '1',
          ctimeNs: '1',
          sha256: sha(bytes),
          data: bytes.toString('base64'),
        },
  );
  const descriptor = {
    version: 1,
    pointId: identity.pointId,
    controller: {
      id: identity.controllerId,
      imageId: identity.imageId,
      imageReference: `${publication.image}@${publication.digest}`,
      project: 'runtipi',
      service: 'runtipi',
      startedAt: '2026-10-31T00:00:00Z',
      releaseTag: tag,
      releaseDigest: publication.digest,
    },
    rootIdentity: { device: '1', inode: '1', uid: 0, gid: 0, mode: 0o700, pathSha256: sha('expected-owned-root') },
    files: files.map(({ data: _data, ...file }) => file),
  };
  const configuration = decodeControllerConfigurationCapture(
    { ...descriptor, files, configurationSetSha256: sha(`orbis.controller-config.v1\n${canonical(descriptor)}`) },
    identity,
  ).metadata;
  const proof = {
    schema: 'orbis.controller-publication-proof.v1',
    publication: { ...publication },
    platform: { ...platform },
    index: index.toString('base64'),
    manifest: manifest.toString('base64'),
    config: configBytes.toString('base64'),
  };
  const response = {
    version: 1,
    pointId: identity.pointId,
    controller: structuredClone(configuration.controller),
    rootIdentity: structuredClone(configuration.rootIdentity),
    configurationSetSha256: configuration.configurationSetSha256,
    proof,
  };
  return {
    expected: { configuration, publication, platform: { ...platform } },
    packet: seal(response),
    configurationPacket: { ...descriptor, files, configurationSetSha256: configuration.configurationSetSha256 },
  };
}
function seal<T extends object>(value: T) {
  const { preparationSha256: _old, ...body } = value as T & { preparationSha256?: string };
  return { ...body, preparationSha256: sha(`orbis.controller-publication-capture.v1\n${canonical(body)}`) };
}
it('accepts the protected retained v2 identity and rejects graph or authority drift', () => {
  const original = fixture();
  const proof = original.packet.proof;
  const index = JSON.parse(Buffer.from(proof.index, 'base64').toString());
  const platformManifestDigest = index.manifests[0].digest as string;
  const manifest = JSON.parse(Buffer.from(proof.manifest, 'base64').toString());
  const configDigest = manifest.config.digest as string;
  const retainedIdentity = {
    publishedReference: `${original.expected.publication.image}@${original.expected.publication.digest}`,
    platform,
    platformManifestDigest,
    configDigest,
    sourceImageId: original.expected.configuration.controller.imageId,
    creationReference: platformManifestDigest,
    pointId: `sha256:${'3'.repeat(64)}`,
    configurationDigest: `sha256:${'4'.repeat(64)}`,
    archiveRootId: original.expected.publication.digest,
    descriptorDigest: `sha256:${'5'.repeat(64)}`,
    archiveKind: 'oci' as const,
    proofDigest: `sha256:${sha(canonical(proof))}`,
  };
  const controller = { ...original.configurationPacket.controller, imageId: platformManifestDigest, imageReference: platformManifestDigest };
  const files = original.configurationPacket.files;
  const descriptor = {
    version: 2,
    pointId: original.configurationPacket.pointId,
    controller,
    rootIdentity: original.configurationPacket.rootIdentity,
    files: files.map(({ data: _data, ...file }) => file),
    retainedIdentity,
  };
  const configurationSetSha256 = sha(`orbis.controller-config.v2\n${canonical(descriptor)}`);
  const capture = decodeControllerConfigurationCapture(
    { ...descriptor, files, configurationSetSha256 },
    { pointId: descriptor.pointId, controllerId: controller.id, imageId: controller.imageId },
  );
  if (capture.metadata.version !== 2) throw new Error('Missing retained configuration');
  const expected = { configuration: capture.metadata, publication: original.expected.publication, platform };
  const inspected = {
    Id: controller.imageId,
    RepoDigests: null,
    Os: 'linux',
    Architecture: 'arm64',
    Labels: {
      'org.opencontainers.image.source': 'https://github.com/twentylines/orbis',
      'org.opencontainers.image.version': tag,
      'org.opencontainers.image.revision': commit,
      'io.orbis.installation-protocol': 'orbis.installation-state.v1',
    },
  };
  expect(controllerPublicationSource(capture, controller.imageId, inspected, 'arm64')).toEqual(expected);
  const v1 = decodeControllerConfigurationCapture(original.configurationPacket, {
    pointId: descriptor.pointId,
    controllerId: controller.id,
    imageId: original.configurationPacket.controller.imageId,
  });
  expect(() =>
    controllerPublicationSource(v1, v1.metadata.controller.imageId, { ...inspected, Id: v1.metadata.controller.imageId }, 'arm64'),
  ).toThrow();
  const body = {
    version: 2,
    pointId: descriptor.pointId,
    controller,
    rootIdentity: descriptor.rootIdentity,
    configurationSetSha256,
    retainedIdentity,
    proof,
  };
  const packet = { ...body, preparationSha256: sha(`orbis.controller-publication-capture.v2\n${canonical(body)}`) };
  expect(decodeControllerPublicationReceipt(packet, expected).metadata.version).toBe(2);
  for (const field of ['proofDigest', 'platformManifestDigest', 'configDigest', 'creationReference'] as const) {
    const changed = { ...retainedIdentity, [field]: `sha256:${'f'.repeat(64)}` };
    const mutated = { ...body, retainedIdentity: changed };
    const signed = { ...mutated, preparationSha256: sha(`orbis.controller-publication-capture.v2\n${canonical(mutated)}`) };
    expect(() => decodeControllerPublicationReceipt(signed, expected)).toThrow();
    const matching = { ...expected, configuration: { ...capture.metadata, retainedIdentity: changed } };
    expect(() => decodeControllerPublicationReceipt(signed, matching)).toThrow();
  }
  expect(() =>
    decodeControllerConfigurationCapture(
      { ...descriptor, version: 1, files, configurationSetSha256 },
      { pointId: descriptor.pointId, controllerId: controller.id, imageId: controller.imageId },
    ),
  ).toThrow();
});

let directory: string;
let socket: string;
let server: http.Server;
let service: HostUpdatesService;
let current: ReturnType<typeof fixture>;
let payload: unknown;
let status: number;
let capability: unknown;
let archiveCapability: unknown;
let archiveStatus: number;
let afterRead: (() => void | Promise<void>) | undefined;
let rawBody: Buffer | undefined;
let dropResponse = false;
const requests: { path: string; body: unknown }[] = [];
const requestHeaders: http.IncomingHttpHeaders[] = [];
const originalSocket = process.env.ORBIS_HOST_SOCKET;
function client(endpoint: string) {
  process.env.ORBIS_HOST_SOCKET = endpoint;
  const result = new HostUpdatesService({} as never, {} as never);
  process.env.ORBIS_HOST_SOCKET = originalSocket;
  return result;
}
beforeAll(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-publication-client-')));
  socket = path.join(directory, 'host.sock');
  server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? '',
      body:
        request.headers['content-type'] === 'application/x-tar'
          ? Buffer.concat(chunks)
          : chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString())
            : null,
    });
    requestHeaders.push(request.headers);
    if (afterRead) await afterRead();
    if (dropResponse) {
      dropResponse = false;
      response.destroy();
      return;
    }
    response.statusCode = request.url === '/v1/backup-archive/capability' ? archiveStatus : status;
    if (request.url?.endsWith('/app-runtime')) {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
    }
    response.end(
      rawBody ??
        JSON.stringify(
          request.url === '/v1/backup-archive/capability' ? archiveCapability : request.url?.endsWith('/capability') ? capability : payload,
        ),
    );
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await fs.chmod(socket, 0o600);
  service = client(socket);
});
beforeEach(() => {
  current = fixture();
  payload = current.packet;
  status = 200;
  afterRead = undefined;
  rawBody = undefined;
  dropResponse = false;
  capability = { version: 1, capability: 'controller-publication.v1' };
  archiveStatus = 200;
  archiveCapability = archiveContract();
  requests.length = 0;
  requestHeaders.length = 0;
});

function archiveContract(sourceSha256 = 'a'.repeat(64)) {
  const unsigned = {
    version: 1,
    format: 'orbis-full-backup',
    manifestVersion: 2,
    mediaPolicy: 'explicit-inclusion.v1',
    appDataLinks: 'confined-relative.v1',
    sourceSha256,
  };
  return { ...unsigned, contractSha256: sha(`orbis.backup-archive-capability.v1\n${canonical(unsigned)}`) };
}

it('requires explicit archive support from the same protected helper before capture admission', async () => {
  const unsigned = {
    version: 3,
    runtimeSchema: 'orbis.time-machine-runtime.v6',
    imageCaptureSchema: 'orbis.time-machine-image-capture.v2',
    controllerAuthoritySchema: 'orbis.controller-capture-authority.v4',
    appRuntimeSchema: 'orbis.app-runtime-capture.v1',
    proxyHostIdentitySchema: 'orbis.proxy-host-identity-policy.v1',
    coherenceSchema: 'orbis.capture-coherence.v1',
    sourceSha256: 'a'.repeat(64),
  };
  capability = { ...unsigned, contractSha256: sha(`orbis.controller-capture-capability.v3\n${canonical(unsigned)}`) };
  archiveStatus = 404;
  await expect(service.requireV6CaptureCapability()).rejects.toMatchObject({ status: 503 });
  archiveStatus = 200;
  archiveCapability = archiveContract('b'.repeat(64));
  await expect(service.requireV6CaptureCapability()).rejects.toMatchObject({ status: 503 });
  archiveCapability = { ...archiveContract(), manifestVersion: 1 };
  await expect(service.requireV6CaptureCapability()).rejects.toMatchObject({ status: 503 });
  archiveCapability = archiveContract();
  expect((await service.requireV6CaptureCapability()).sourceSha256).toBe('a'.repeat(64));
  expect(requests.every((request) => !request.path.endsWith('/acquire'))).toBe(true);
});

it('gates retained restore on explicit archive support without changing the old v6 reply shape', async () => {
  const unsigned = {
    version: 2,
    runtimeSchema: 'orbis.time-machine-runtime.v6',
    controllerAuthoritySchema: 'orbis.controller-capture-authority.v4',
    coordinatorProtocol: 'orbis.retained-worker-phase.v1',
    candidateAppResultProtocol: 'root-candidate-app-result.v1',
    targetAppCapability: 'orbis.retained-app-engine.v1',
    normalBootstrapProtocol: 'root-normal-bootstrap.v1',
    portsProtocol: 'inet-diag-self-proof.v1',
    sourceSha256: 'a'.repeat(64),
  };
  capability = { ...unsigned, contractSha256: sha(`orbis.retained-restore-capability.v2\n${canonical(unsigned)}`) };
  archiveStatus = 404;
  await expect(service.requireV6RestoreCapability()).rejects.toMatchObject({ status: 503 });
  archiveStatus = 200;
  expect(await service.requireV6RestoreCapability()).toEqual(capability);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (await fs.lstat(`${socket}.old`).catch(() => null)) {
    await fs.rm(socket, { force: true });
    await fs.rename(`${socket}.old`, socket);
  }
  await fs.chmod(directory, 0o700);
  await fs.chmod(socket, 0o600);
});
afterAll(async () => {
  process.env.ORBIS_HOST_SOCKET = originalSocket;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await fs.rm(directory, { recursive: true, force: true });
});

it('uses only fixed capability/prepare routes and returns private immutable exact canonical receipt bytes', async () => {
  await service.requireControllerPublicationSupport();
  const result = await service.prepareControllerPublication(current.expected);
  expect(requests).toEqual([
    { path: '/v1/controller-publication/capability', body: null },
    {
      path: '/v1/controller-publication/prepare',
      body: {
        pointId: current.expected.configuration.pointId,
        controllerId: current.expected.configuration.controller.id,
        imageId: current.expected.configuration.controller.imageId,
        configurationSetSha256: current.expected.configuration.configurationSetSha256,
      },
    },
  ]);
  expect(result.read()).toEqual(encode(current.packet));
  result.read().fill(0);
  expect(result.read()).toEqual(encode(current.packet));
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.metadata.rootfsDiffIds)).toBe(true);
  expect(result.metadata.configDigest).toBe(current.expected.configuration.controller.imageId);
  expect(() => JSON.stringify(result)).toThrow('private');
  expect(JSON.stringify(result.metadata)).not.toContain(current.packet.proof.config);
});
it('copies independently expected publication/platform before asynchronous socket work', async () => {
  const caller = { ...current.expected, publication: { ...current.expected.publication }, platform: { ...current.expected.platform } };
  const pending = service.prepareControllerPublication(caller);
  caller.publication.commit = '0'.repeat(40);
  expect((await pending).metadata.controller.id).toBe(current.expected.configuration.controller.id);
});
it.each(['point', 'controller', 'source', 'root', 'set', 'release', 'platform', 'hash', 'field', 'proof-field'])(
  'rejects forged %s even when attacker recomputes the preparation hash',
  async (change) => {
    const value = structuredClone(current.packet);
    if (change === 'point') value.pointId = '22222222-2222-4222-8222-222222222222';
    if (change === 'controller') value.controller.id = '0'.repeat(64);
    if (change === 'source') value.controller.imageId = `sha256:${'0'.repeat(64)}`;
    if (change === 'root') value.rootIdentity.pathSha256 = '0'.repeat(64);
    if (change === 'set') value.configurationSetSha256 = '0'.repeat(64);
    if (change === 'release') value.proof.publication.commit = '0'.repeat(40);
    if (change === 'platform') Reflect.set(value.proof.platform, 'architecture', 'amd64');
    if (change === 'field') Reflect.set(value, 'debug', 'untrusted diagnostic');
    if (change === 'proof-field') Reflect.set(value.proof, 'verified', true);
    payload = change === 'hash' ? { ...value, preparationSha256: '0'.repeat(64) } : seal(value);
    await expect(service.prepareControllerPublication(current.expected)).rejects.toThrow('Controller publication preparation requires');
  },
);
it.each(['index', 'manifest', 'config'] as const)('checks exact %s bytes against independent expected graph digests', async (name) => {
  const value = structuredClone(current.packet);
  value.proof[name] = Buffer.concat([Buffer.from(value.proof[name], 'base64'), Buffer.from(' ')]).toString('base64');
  payload = seal(value);
  await expect(service.prepareControllerPublication(current.expected)).rejects.toThrow();
});
it('does not accept a self-consistent alternate graph as its own authority', async () => {
  const alternate = fixture({
    config: (value) => {
      value.config = { Labels: { 'org.opencontainers.image.source': 'other' } };
    },
  });
  payload = alternate.packet;
  await expect(service.prepareControllerPublication(current.expected)).rejects.toThrow();
  expect(() => decodeControllerPublicationReceipt(alternate.packet, alternate.expected)).toThrow();
});
it.each(['ambiguous', 'size', 'external', 'nested'] as const)(
  'rejects unsupported %s graph structure under an independently supplied fixture digest',
  (kind) => {
    const value = fixture({
      index: (index) => {
        const items = index.manifests as Record<string, unknown>[];
        if (kind === 'ambiguous') items.push({ ...items[0] });
        if (kind === 'size' && items[0]) items[0].size = 1;
        if (kind === 'external' && items[0]) items[0].urls = ['https://example.test/not-allowed'];
        if (kind === 'nested' && items[0]) items[0].mediaType = 'application/vnd.oci.image.index.v1+json';
      },
    });
    expect(() => decodeControllerPublicationReceipt(value.packet, value.expected)).toThrow();
  },
);
it('bounds the whole receipt/HTTP body, rejects invalid base64 and keeps helper errors private', async () => {
  const value = structuredClone(current.packet);
  for (const key of ['index', 'manifest', 'config'] as const) value.proof[key] = 'AAAA'.repeat(349526);
  payload = seal(value);
  expect(encode(payload).length).toBeGreaterThan(controllerPublicationLimits.receiptBytes);
  expect(() => decodeControllerPublicationReceipt(payload, current.expected)).toThrow();
  await expect(service.prepareControllerPublication(current.expected)).rejects.toThrow();
  value.proof.config = '!';
  payload = seal(value);
  await expect(service.prepareControllerPublication(current.expected)).rejects.toThrow();
  status = 409;
  payload = { error: `untrusted diagnostic ${directory}` };
  const error = await service.prepareControllerPublication(current.expected).catch((reason) => reason);
  expect(String(error)).not.toContain('untrusted diagnostic');
  expect(String(error)).not.toContain(directory);
});
it('rejects malformed capability keys and missing support without status/PLAN requests', async () => {
  for (const value of [
    { version: 1, capability: 'controller-publication.v1', extra: true },
    { version: 2, capability: 'controller-publication.v1' },
  ]) {
    capability = value;
    await expect(service.requireControllerPublicationSupport()).rejects.toThrow('controller-publication.v1');
  }
  status = 404;
  await expect(service.requireControllerPublicationSupport()).rejects.toThrow('controller-publication.v1');
  expect(requests.every((request) => request.path === '/v1/controller-publication/capability')).toBe(true);
});
it('refuses permissive/aliased sockets and a socket replaced during preparation', async () => {
  await fs.chmod(socket, 0o666);
  await expect(service.prepareControllerPublication(current.expected)).rejects.toThrow();
  expect(requests).toEqual([]);
  await fs.chmod(socket, 0o600);
  const alias = path.join(directory, 'alias');
  await fs.symlink(directory, alias);
  await expect(client(path.join(alias, 'host.sock')).prepareControllerPublication(current.expected)).rejects.toThrow();
  expect(requests).toEqual([]);
  afterRead = async () => {
    await fs.rename(socket, `${socket}.old`);
    await fs.writeFile(socket, 'replacement');
  };
  await expect(service.prepareControllerPublication(current.expected)).rejects.toThrow();
});
it('enforces the 165 second absolute deadline without waiting for a real timeout', async () => {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const deadlines: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    deadlines.push(milliseconds);
    return original(10);
  });
  afterRead = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
  await expect(service.prepareControllerPublication(current.expected)).rejects.toThrow();
  expect(deadlines).toEqual([165_000]);
});
it('honors external cancellation and already aborted signals', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(service.prepareControllerPublication(current.expected, cancelled.signal)).rejects.toThrow();
  expect(requests).toEqual([]);
  const controller = new AbortController();
  afterRead = () => controller.abort();
  await expect(service.prepareControllerPublication(current.expected, controller.signal)).rejects.toThrow();
});
it('rejects duplicate JSON keys, invalid UTF8, non-integer metadata and excessive nesting', () => {
  for (const bytes of [
    Buffer.from('{"version":1,"version":1}'),
    Buffer.from([0xff]),
    Buffer.from('{"n":1.5}'),
    Buffer.from(`{"n":${'['.repeat(34)}0${']'.repeat(34)}}`),
  ])
    expect(() => parseControllerPublicationResponse(bytes)).toThrow();
});

it('uses a protected publication-bound capture fence and keeps its token inside private host calls', async () => {
  const receipt = decodeControllerPublicationReceipt(current.packet, current.expected);
  afterRead = async () => {
    if (requests.at(-1)?.path === '/v1/controller-capture-fence/acquire') {
      payload = { version: 1, token: (requests.at(-1)?.body as { clientKey: string }).clientKey, expiresAt: Date.now() / 1000 + 120 };
    }
  };
  const fence = await service.acquireControllerCaptureFence(current.expected, receipt);
  const token = (requests[0]?.body as { clientKey: string }).clientKey;
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(requests[0]).toEqual({
    path: '/v1/controller-capture-fence/acquire',
    body: {
      pointId: current.expected.configuration.pointId,
      controllerId: current.expected.configuration.controller.id,
      imageId: current.expected.configuration.controller.imageId,
      configurationSetSha256: current.expected.configuration.configurationSetSha256,
      preparationSha256: receipt.metadata.preparationSha256,
      clientKey: token,
    },
  });
  expect(JSON.stringify(fence)).not.toContain(token);
  payload = current.configurationPacket;
  expect((await fence.capture()).metadata).toEqual(current.expected.configuration);
  expect(requests.at(-1)?.body).toEqual({
    pointId: current.expected.configuration.pointId,
    controllerId: current.expected.configuration.controller.id,
    imageId: current.expected.configuration.controller.imageId,
    fenceToken: token,
  });
  payload = { version: 1, expiresAt: Date.now() / 1000 + 120 };
  await fence.renew();
  payload = { version: 1, released: true };
  await fence.release();
  await expect(fence.renew()).rejects.toThrow('no longer held');
  await expect(fence.capture()).rejects.toThrow('no longer held');
});
it.each([
  { version: 1, token: 'bad', expiresAt: 9999999999 },
  { version: 1, token: '8'.repeat(64), expiresAt: 0 },
  { version: 1, token: '8'.repeat(64), expiresAt: 9999999999, extra: true },
])('rejects malformed or expired fence responses (%j)', async (response) => {
  payload = response;
  afterRead = async () => {
    if (!requests.at(-1)?.path.endsWith('/acquire')) payload = { version: 1, released: true };
  };
  const receipt = decodeControllerPublicationReceipt(current.packet, current.expected);
  await expect(service.acquireControllerCaptureFence(current.expected, receipt)).rejects.toThrow('could not be verified');
});
it('requires exact capture fence capability before requesting a point', async () => {
  capability = { version: 1, capability: 'controller-capture-fence.v1' };
  await service.requireControllerCaptureFenceSupport();
  capability = { version: 1, capability: 'controller-capture-fence.v1', extra: true };
  await expect(service.requireControllerCaptureFenceSupport()).rejects.toThrow('controller-capture-fence.v1');
});

it('retries a lost acquire response with exactly the same retained private key', async () => {
  const receipt = decodeControllerPublicationReceipt(current.packet, current.expected);
  let acquisitions = 0;
  afterRead = async () => {
    const last = requests.at(-1);
    if (last?.path.endsWith('/acquire')) {
      acquisitions++;
      payload = { version: 1, token: (last.body as { clientKey: string }).clientKey, expiresAt: Date.now() / 1000 + 120 };
      if (acquisitions === 1) dropResponse = true;
    } else payload = { version: 1, released: true };
  };
  const fence = await service.acquireControllerCaptureFence(current.expected, receipt);
  expect(acquisitions).toBe(2);
  expect(requests[0]?.body).toEqual(requests[1]?.body);
  await fence.release();
});
it('releases its own ambiguous acquisition using the retained key after cancellation', async () => {
  const receipt = decodeControllerPublicationReceipt(current.packet, current.expected);
  const cancelled = new AbortController();
  afterRead = async () => {
    const last = requests.at(-1);
    if (last?.path.endsWith('/acquire')) {
      payload = { version: 1, token: (last.body as { clientKey: string }).clientKey, expiresAt: Date.now() / 1000 + 120 };
      cancelled.abort();
    } else payload = { version: 1, released: true };
  };
  await expect(service.acquireControllerCaptureFence(current.expected, receipt, cancelled.signal)).rejects.toThrow();
  expect(requests.filter((request) => request.path.endsWith('/acquire'))).toHaveLength(1);
  const key = (requests[0]?.body as { clientKey: string }).clientKey;
  expect(requests.at(-1)).toMatchObject({
    path: '/v1/controller-capture-fence/release',
    body: { token: key, pointId: current.expected.configuration.pointId, preparationSha256: receipt.metadata.preparationSha256 },
  });
});

it('reconciles a durable interrupted capture only with its full verified point and publication binding', async () => {
  const receipt = decodeControllerPublicationReceipt(current.packet, current.expected);
  const key = '7'.repeat(64);
  payload = { version: 1, released: true };
  await service.reconcileControllerCaptureFence(current.expected, receipt, key);
  expect(requests.at(-1)).toEqual({
    path: '/v1/controller-capture-fence/release',
    body: {
      token: key,
      pointId: current.expected.configuration.pointId,
      controllerId: current.expected.configuration.controller.id,
      imageId: current.expected.configuration.controller.imageId,
      configurationSetSha256: current.expected.configuration.configurationSetSha256,
      preparationSha256: receipt.metadata.preparationSha256,
    },
  });
});

function authorityFixture() {
  const receipt = decodeControllerPublicationReceipt(current.packet, current.expected);
  const bytes = Buffer.from('explicit archive transport fixture');
  const image: RetainedImage = {
    imageId: current.expected.configuration.controller.imageId,
    repoDigests: [],
    archive: `image-${'7'.repeat(64)}.tar`,
    bytes: bytes.length,
    sha256: sha(bytes),
    identity: {
      kind: 'oci',
      configId: receipt.metadata.configDigest,
      manifestId: receipt.metadata.platformManifestDigest,
      archiveRootId: `sha256:${'6'.repeat(64)}`,
      platform: current.expected.platform,
      expandedBytes: 0,
    },
  };
  const descriptor = {
    schema: 'orbis.controller-capture-authority.v1',
    version: 1,
    pointId: current.expected.configuration.pointId,
    configurationSetSha256: current.expected.configuration.configurationSetSha256,
    preparationSha256: receipt.metadata.preparationSha256,
    publicationProofSha256: sha(receipt.read()),
    rootIdentitySha256: sha(canonical(current.expected.configuration.rootIdentity)),
    publication: current.expected.publication,
    platform: current.expected.platform,
    archive: {
      kind: image.identity.kind,
      sha256: image.sha256,
      bytes: image.bytes,
      archiveRootId: image.identity.archiveRootId,
      configDigest: receipt.metadata.configDigest,
      platformManifestDigest: receipt.metadata.platformManifestDigest,
      sourceImageId: image.imageId,
      creationReference: image.identity.manifestId,
    },
    finalizedAt: Date.now(),
  };
  const authority = { ...descriptor, authoritySha256: sha(`orbis.controller-capture-authority.v1\n${canonical(descriptor)}`) };
  return { receipt, bytes, image, authority };
}
it.each([false, true])('streams a bounded controller archive and recovers only a finalized root commit after lost reply (%s)', async (drop) => {
  const fixture = authorityFixture();
  afterRead = async () => {
    const last = requests.at(-1);
    if (last?.path.endsWith('/acquire'))
      payload = { version: 1, token: (last.body as { clientKey: string }).clientKey, expiresAt: Date.now() / 1000 + 120 };
    else if (last?.path.endsWith('/finalize')) {
      payload = fixture.authority;
      dropResponse = drop;
    } else if (last?.path.endsWith('/recover')) payload = { version: 1, state: 'finalized', authority: fixture.authority };
    else payload = { version: 1, released: true };
  };
  const fence = await service.acquireControllerCaptureFence(current.expected, fixture.receipt);
  const authority = await fence.finalizeControllerArchive(fixture.image, async () => Readable.from([fixture.bytes]));
  expect(authority.metadata.authoritySha256).toBe(fixture.authority.authoritySha256);
  const index = requests.findIndex((request) => request.path.endsWith('/finalize'));
  expect(requests[index]?.body).toEqual(fixture.bytes);
  expect(requestHeaders[index]?.['content-length']).toBe(String(fixture.bytes.length));
  expect(requestHeaders[index]?.['x-orbis-capture-token']).toBe((requests[0]?.body as { clientKey: string }).clientKey);
  expect(requests.filter((request) => request.path.endsWith('/recover'))).toHaveLength(drop ? 1 : 0);
  await fence.release();
});
it('rejects extra stream bytes instead of accepting a valid authority for only a prefix', async () => {
  const fixture = authorityFixture();
  afterRead = async () => {
    const last = requests.at(-1);
    if (last?.path.endsWith('/acquire'))
      payload = { version: 1, token: (last.body as { clientKey: string }).clientKey, expiresAt: Date.now() / 1000 + 120 };
    else payload = fixture.authority;
  };
  const fence = await service.acquireControllerCaptureFence(current.expected, fixture.receipt);
  await expect(fence.finalizeControllerArchive(fixture.image, async () => Readable.from([fixture.bytes, Buffer.from('extra')]))).rejects.toThrow();
  expect(requests.filter((request) => request.path.endsWith('/recover'))).toHaveLength(0);
});

it.each(['point', 'configuration', 'proof', 'archive', 'platform', 'source', 'creation', 'root', 'hash', 'field'] as const)(
  'rejects substituted root authority even with a recomputed hash: %s',
  (kind) => {
    const fixture = authorityFixture();
    const value = structuredClone(fixture.authority);
    if (kind === 'point') value.pointId = '22222222-2222-4222-8222-222222222222';
    if (kind === 'configuration') value.configurationSetSha256 = '9'.repeat(64);
    if (kind === 'proof') value.publicationProofSha256 = '9'.repeat(64);
    if (kind === 'archive') value.archive.sha256 = '9'.repeat(64);
    if (kind === 'platform') Reflect.set(value.platform, 'architecture', 'amd64');
    if (kind === 'source') value.archive.sourceImageId = `sha256:${'9'.repeat(64)}`;
    if (kind === 'creation') value.archive.creationReference = value.archive.configDigest;
    if (kind === 'root') value.rootIdentitySha256 = '9'.repeat(64);
    const { authoritySha256: _old, ...descriptor } = value;
    value.authoritySha256 = sha(`orbis.controller-capture-authority.v1\n${canonical(descriptor)}`);
    if (kind === 'hash') value.authoritySha256 = '9'.repeat(64);
    expect(() =>
      decodeControllerCaptureAuthority(
        kind === 'field' ? { ...value, callerApproved: true } : value,
        current.expected,
        fixture.receipt,
        fixture.image,
      ),
    ).toThrow();
  },
);

it.each([false, true])('pins protected proxy policy before v2 archive finalize and handles lost reply (%s)', async (drop) => {
  const fixture = authorityFixture();
  const policyDescriptor = {
    schema: 'orbis.proxy-host-identity-policy.v1',
    policy: 'preserve-live-proxy-identity.v1',
    rootSha256: current.expected.configuration.rootIdentity.pathSha256,
    dockerContextSha256: sha('fixture-context'),
    configuration: {
      destination: '/etc/traefik',
      readOnly: true,
      staticSha256: sha('fixture-static'),
      capture: 'encrypted-review-only',
      restore: 'preserve-live',
    },
    mutableIdentity: { destination: '/shared', capture: 'excluded', restore: 'preserve-live', ownershipSha256: sha('fixture-protected-store') },
    proxy: { containerId: '8'.repeat(64), imageId: `sha256:${'9'.repeat(64)}` },
  };
  const policy = { ...policyDescriptor, sha256: sha(`orbis.proxy-host-identity-policy.v1\n${canonical(policyDescriptor)}`) };
  const { authoritySha256: _old, ...old } = fixture.authority;
  const descriptor = { ...old, schema: 'orbis.controller-capture-authority.v2', version: 2, proxyHostIdentity: policy };
  const authority = { ...descriptor, authoritySha256: sha(`orbis.controller-capture-authority.v2\n${canonical(descriptor)}`) };
  afterRead = async () => {
    const last = requests.at(-1);
    if (last?.path.endsWith('/acquire'))
      payload = { version: 1, token: (last.body as { clientKey: string }).clientKey, expiresAt: Date.now() / 1000 + 120 };
    else if (last?.path.endsWith('/prepare'))
      payload = { version: 2, pointId: current.expected.configuration.pointId, proxyHostIdentity: policy, proxyPreparationSha256: 'a'.repeat(64) };
    else if (last?.path.endsWith('/finalize')) {
      payload = authority;
      dropResponse = drop;
    } else if (last?.path.endsWith('/recover')) payload = { version: 2, state: 'finalized', authority };
    else payload = { version: 1, released: true };
  };
  const fence = await service.acquireControllerCaptureFence(current.expected, fixture.receipt, undefined, undefined, true);
  await expect(fence.finalizeControllerArchive(fixture.image, async () => Readable.from([fixture.bytes]))).rejects.toThrow('preparation is missing');
  expect(await fence.prepareProxyHostIdentity()).toEqual(policy);
  const result = await fence.finalizeControllerArchive(fixture.image, async () => Readable.from([fixture.bytes]));
  expect(result.metadata.version).toBe(2);
  expect(requests.find((request) => request.path.endsWith('/finalize'))?.path).toMatch(/^\/v2\//);
  await fence.release();
});

it('decodes v4 authority only with both root-bound app capture hashes and proxy policy', () => {
  const fixture = authorityFixture();
  const policyDescriptor = {
    schema: 'orbis.proxy-host-identity-policy.v1',
    policy: 'preserve-live-proxy-identity.v1',
    rootSha256: current.expected.configuration.rootIdentity.pathSha256,
    dockerContextSha256: sha('fixture-context'),
    configuration: {
      destination: '/etc/traefik',
      readOnly: true,
      staticSha256: sha('fixture-static'),
      capture: 'encrypted-review-only',
      restore: 'preserve-live',
    },
    mutableIdentity: { destination: '/shared', capture: 'excluded', restore: 'preserve-live', ownershipSha256: sha('fixture-protected-store') },
    proxy: { containerId: '8'.repeat(64), imageId: `sha256:${'9'.repeat(64)}` },
  };
  const policy = { ...policyDescriptor, sha256: sha(`orbis.proxy-host-identity-policy.v1\n${canonical(policyDescriptor)}`) };
  const { authoritySha256: _old, ...old } = fixture.authority;
  const descriptor = {
    ...old,
    schema: 'orbis.controller-capture-authority.v4',
    version: 4,
    proxyHostIdentity: policy,
    appRuntimeSha256: sha('runtime'),
    appRuntimeDaemonSha256: sha('daemon'),
  };
  const authority = { ...descriptor, authoritySha256: sha(`orbis.controller-capture-authority.v4\n${canonical(descriptor)}`) };
  expect(decodeControllerCaptureAuthority(authority, current.expected, fixture.receipt, fixture.image).metadata.version).toBe(4);
  const { appRuntimeDaemonSha256: _daemon, ...missing } = authority;
  expect(() => decodeControllerCaptureAuthority(missing, current.expected, fixture.receipt, fixture.image)).toThrow();
  expect(() =>
    decodeControllerCaptureAuthority({ ...authority, appRuntimeSha256: sha('substituted') }, current.expected, fixture.receipt, fixture.image),
  ).toThrow();
});

it.each([
  'valid',
  'substituted-blob',
  'truncated-blob',
  'oversized-blob',
  'bad-summary',
  'final-authority-drift',
  'daemon-drift',
  'lost-finalize-reply',
  'concurrent',
] as const)('binds protected app preparation and final receipt: %s', async (change) => {
  const fixture = authorityFixture();
  const policyDescriptor = {
    schema: 'orbis.proxy-host-identity-policy.v1',
    policy: 'preserve-live-proxy-identity.v1',
    rootSha256: current.expected.configuration.rootIdentity.pathSha256,
    dockerContextSha256: sha('fixture-context'),
    configuration: {
      destination: '/etc/traefik',
      readOnly: true,
      staticSha256: sha('fixture-static'),
      capture: 'encrypted-review-only',
      restore: 'preserve-live',
    },
    mutableIdentity: { destination: '/shared', capture: 'excluded', restore: 'preserve-live', ownershipSha256: sha('fixture-protected-store') },
    proxy: { containerId: '8'.repeat(64), imageId: `sha256:${'9'.repeat(64)}` },
  };
  const policy = { ...policyDescriptor, sha256: sha(`orbis.proxy-host-identity-policy.v1\n${canonical(policyDescriptor)}`) };
  const appDescriptor = {
    schema: 'orbis.app-runtime-capture.v1',
    version: 1,
    pointId: current.expected.configuration.pointId,
    rootSha256: policy.rootSha256,
    dockerContextSha256: policy.dockerContextSha256,
    daemonSha256: sha('daemon'),
    configurationSetSha256: current.expected.configuration.configurationSetSha256,
    preparationSha256: fixture.receipt.metadata.preparationSha256,
    capturedAt: Date.now(),
    apps: [],
    containers: [],
    networkDefinitions: [],
  };
  const blob = encode({ ...appDescriptor, sha256: sha(`orbis.app-runtime-capture.v1\n${canonical(appDescriptor)}`) });
  const { authoritySha256: _old, ...old } = fixture.authority;
  const descriptor = {
    ...old,
    schema: 'orbis.controller-capture-authority.v4',
    version: 4,
    proxyHostIdentity: policy,
    appRuntimeSha256: change === 'final-authority-drift' ? sha('wrong') : sha(blob),
    appRuntimeDaemonSha256: change === 'daemon-drift' ? sha('other-daemon') : appDescriptor.daemonSha256,
  };
  const authority = { ...descriptor, authoritySha256: sha(`orbis.controller-capture-authority.v4\n${canonical(descriptor)}`) };
  let entered = () => {};
  let resume = () => {};
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumePromise = new Promise<void>((resolve) => {
    resume = resolve;
  });
  afterRead = async () => {
    const last = requests.at(-1);
    rawBody = undefined;
    if (last?.path.endsWith('/acquire'))
      payload = { version: 1, token: (last.body as { clientKey: string }).clientKey, expiresAt: Date.now() / 1000 + 120 };
    else if (last?.path.endsWith('/prepare')) {
      payload = {
        version: 3,
        pointId: current.expected.configuration.pointId,
        proxyHostIdentity: policy,
        proxyPreparationSha256: sha('proxy-preparation'),
        appRuntimeSha256: sha(blob),
        appRuntimeDaemonSha256: appDescriptor.daemonSha256,
        appRuntimeBytes: change === 'bad-summary' ? 0 : blob.length,
      };
      if (change === 'concurrent') {
        entered();
        await resumePromise;
      }
    } else if (last?.path.endsWith('/app-runtime'))
      rawBody =
        change === 'substituted-blob'
          ? Buffer.alloc(blob.length, 0x20)
          : change === 'truncated-blob'
            ? blob.subarray(0, blob.length - 1)
            : change === 'oversized-blob'
              ? Buffer.concat([blob, Buffer.from('x')])
              : blob;
    else if (last?.path.endsWith('/finalize')) {
      payload = authority;
      if (change === 'lost-finalize-reply') dropResponse = true;
    } else if (last?.path.endsWith('/recover')) payload = { version: 3, state: 'finalized', authority };
    else payload = { version: 1, released: true };
  };
  const fence = await service.acquireControllerCaptureFence(current.expected, fixture.receipt, undefined, undefined, true, true);
  if (change === 'substituted-blob' || change === 'truncated-blob' || change === 'oversized-blob' || change === 'bad-summary') {
    await expect(fence.prepareAppRuntime()).rejects.toThrow();
    await expect(fence.finalizeControllerArchive(fixture.image, async () => Readable.from([fixture.bytes]))).rejects.toThrow();
  } else {
    const pending = fence.prepareAppRuntime();
    if (change === 'concurrent') {
      await enteredPromise;
      await expect(fence.prepareAppRuntime()).rejects.toThrow();
      resume();
    }
    const prepared = await pending;
    expect(prepared.appRuntime.read()).toEqual(blob);
    const result = fence.finalizeControllerArchive(fixture.image, async () => Readable.from([fixture.bytes]));
    if (change === 'final-authority-drift' || change === 'daemon-drift') await expect(result).rejects.toThrow();
    else expect((await result).metadata.version).toBe(4);
  }
  if (change === 'lost-finalize-reply')
    expect(requests.filter((request) => request.path.startsWith('/v3/') && request.path.endsWith('/recover'))).toHaveLength(1);
  await fence.release();
});

it('binds a socket-issued v6 contract once to fence2 and rejects forged or changed contracts before acquire', async () => {
  const receipt = decodeControllerPublicationReceipt(current.packet, current.expected);
  const unsigned = {
    version: 3,
    runtimeSchema: 'orbis.time-machine-runtime.v6',
    imageCaptureSchema: 'orbis.time-machine-image-capture.v2',
    controllerAuthoritySchema: 'orbis.controller-capture-authority.v4',
    appRuntimeSchema: 'orbis.app-runtime-capture.v1',
    proxyHostIdentitySchema: 'orbis.proxy-host-identity-policy.v1',
    coherenceSchema: 'orbis.capture-coherence.v1',
    sourceSha256: 'a'.repeat(64),
  };
  const signed = { ...unsigned, contractSha256: sha(`orbis.controller-capture-capability.v3\n${canonical(unsigned)}`) };
  capability = signed;
  const selection = await service.requireV6CaptureCapability();
  await expect(
    service.acquireControllerCaptureFence(current.expected, receipt, undefined, undefined, true, true, { ...selection }),
  ).rejects.toThrow();
  afterRead = async () => {
    if (requests.at(-1)?.path.endsWith('/acquire')) {
      const body = requests.at(-1)?.body as { clientKey: string; captureContractSha256: string };
      payload = { version: 2, token: body.clientKey, expiresAt: Date.now() / 1000 + 120, captureContractSha256: body.captureContractSha256 };
    } else payload = { version: 1, released: true };
  };
  const fence = await service.acquireControllerCaptureFence(current.expected, receipt, undefined, undefined, true, true, selection);
  expect(requests.find((request) => request.path.endsWith('/acquire'))?.body).toMatchObject({ captureContractSha256: signed.contractSha256 });
  await expect(service.acquireControllerCaptureFence(current.expected, receipt, undefined, undefined, true, true, selection)).rejects.toThrow();
  await fence.release();
  const second = await service.requireV6CaptureCapability();
  const changed = { ...unsigned, sourceSha256: 'b'.repeat(64) };
  capability = { ...changed, contractSha256: sha(`orbis.controller-capture-capability.v3\n${canonical(changed)}`) };
  const before = requests.filter((request) => request.path.endsWith('/acquire')).length;
  await expect(service.acquireControllerCaptureFence(current.expected, receipt, undefined, undefined, true, true, second)).rejects.toThrow();
  expect(requests.filter((request) => request.path.endsWith('/acquire'))).toHaveLength(before);
});

it('rejects unavailable or malformed protected v6 capability replies', async () => {
  status = 404;
  await expect(service.requireV6CaptureCapability()).rejects.toMatchObject({ status: 404 });
  await expect(service.requireV6RestoreCapability()).rejects.toMatchObject({ status: 404 });
  status = 200;
  capability = { version: 3, contractSha256: 'a'.repeat(64) };
  await expect(service.requireV6CaptureCapability()).rejects.toThrow();
  capability = { version: 2, contractSha256: 'a'.repeat(64) };
  await expect(service.requireV6RestoreCapability()).rejects.toThrow();
});
