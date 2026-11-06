import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { afterEach, expect, it, vi } from 'vitest';
import { convertLegacyToYaml, dynamicComposeSchemaYaml } from '@runtipi/common/schemas';
import { appImagePinSourceSha256 } from '../docker/app-image-pins';
import {
  captureTimeMachineImages,
  verifyCaptureAgainstBackup,
  prepareTimeMachineImages,
  imageCaptureDocker,
  type ImageCaptureOptions,
  type ImageCaptureContainer,
} from './backup-image-capture';
import { retainedImageLimits, type RetainedImagePlatform } from './backup-image-retention';
import { finalizeProtectedImageCaptureV2, prepareProtectedImageCaptureV2 } from './backup-image-capture-v2';
import { canonicalAppRuntimeJson, decodeAppRuntimeCapture } from './time-machine-app-runtime-capture';
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
function tar(entries: { name: string; bytes: Buffer }[]) {
  const pieces: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name);
    header.write('0000600\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${entry.bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
    );
    pieces.push(header, entry.bytes, Buffer.alloc((512 - (entry.bytes.length % 512)) % 512));
  }
  return Buffer.concat([...pieces, Buffer.alloc(1024)]);
}
function imageFixture(suffix = '') {
  const layer = tar([{ name: 'app-data', bytes: Buffer.from(`image layer bytes${suffix}`) }]);
  const config = Buffer.from(
    JSON.stringify({ architecture: 'arm64', os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [`sha256:${sha(layer)}`] } }),
  );
  const id = `sha256:${sha(config)}`;
  const configName = `${id.slice(7)}.json`;
  const layerName = `${'b'.repeat(64)}/layer.tar`;
  return {
    id,
    archive: tar([
      { name: configName, bytes: config },
      { name: layerName, bytes: layer },
      { name: 'manifest.json', bytes: Buffer.from(JSON.stringify([{ Config: configName, Layers: [layerName], RepoTags: null }])) },
    ]),
  };
}
function ociImageFixture(corrupt?: 'config' | 'layer' | 'diff') {
  const layer = tar([{ name: 'app-data', bytes: Buffer.from('retained OCI layer') }]);
  const layerId = `sha256:${sha(layer)}`;
  const config = Buffer.from(
    JSON.stringify({
      architecture: 'arm64',
      os: 'linux',
      config: {},
      rootfs: { type: 'layers', diff_ids: [corrupt === 'diff' ? `sha256:${'0'.repeat(64)}` : layerId] },
    }),
  );
  const configId = `sha256:${sha(config)}`;
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configId, size: config.length },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: layerId, size: layer.length }],
    }),
  );
  const manifestId = `sha256:${sha(manifest)}`;
  const platform = { os: 'linux', architecture: 'arm64' };
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: manifestId, size: manifest.length, platform }],
    }),
  );
  const sourceId = `sha256:${sha(Buffer.from(JSON.stringify({ ...JSON.parse(index.toString()), annotations: { source: 'fixture' } })))}`;
  const blob = (id: string) => `blobs/sha256/${id.slice(7)}`;
  return {
    sourceId,
    manifestId,
    configId,
    platform,
    archive: tar([
      { name: blob(layerId), bytes: corrupt === 'layer' ? Buffer.alloc(layer.length, 1) : layer },
      { name: blob(configId), bytes: corrupt === 'config' ? Buffer.alloc(config.length, 1) : config },
      { name: blob(manifestId), bytes: manifest },
      { name: 'index.json', bytes: index },
      { name: 'oci-layout', bytes: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
      { name: 'manifest.json', bytes: Buffer.from(JSON.stringify([{ Config: blob(configId), Layers: [blob(layerId)], RepoTags: null }])) },
    ]),
  };
}
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-image-capture-')));
  roots.push(root);
  const content = path.join(root, 'content');
  const staging = path.join(root, 'staging');
  await fs.mkdir(content, { mode: 0o700 });
  await fs.mkdir(staging, { mode: 0o700 });
  await fs.writeFile(path.join(staging, 'unrelated'), 'preserve');
  const source = convertLegacyToYaml({ schemaVersion: 2, services: [{ name: 'web', image: 'nginx:v1', isMain: true, internalPort: 80 }] });
  const files = [
    { name: 'data/apps/store/demo/docker-compose.yml', bytes: JSON.stringify(source) },
    { name: 'data/apps/store/demo/docker-compose.generated.yml', bytes: 'services:\n  web:\n    image: nginx:v1\n' },
    { name: 'data/apps/store/demo/config.json', bytes: JSON.stringify({ name: 'demo', tipi_version: 1 }) },
  ];
  for (const file of files) {
    const target = path.join(content, file.name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, file.bytes, { mode: 0o600 });
  }
  const live = path.join(root, 'live-source.json');
  await fs.writeFile(live, JSON.stringify(source), { mode: 0o600 });
  const image = imageFixture();
  const ids = { app: 'a'.repeat(64), core: 'c'.repeat(64), database: 'd'.repeat(64), queue: 'e'.repeat(64), unrelated: 'f'.repeat(64) };
  const container = (id: string, project: string, service: string, reference: string, running: boolean): ImageCaptureContainer => ({
    id,
    project,
    service,
    imageId: image.id,
    reference,
    running,
    paused: false,
    restarting: false,
    oneOff: false,
  });
  const values = new Map([
    [ids.app, container(ids.app, 'demo_store', 'web', 'nginx:v1', false)],
    [ids.core, container(ids.core, 'runtipi', 'runtipi', 'ghcr.io/example/core:v1', true)],
    [ids.database, container(ids.database, 'runtipi', 'runtipi-db', 'postgres:16', true)],
    [ids.queue, container(ids.queue, 'runtipi', 'runtipi-queue', 'rabbitmq:3', true)],
    [ids.unrelated, container(ids.unrelated, 'unrelated', 'do-not-touch', 'unrelated:v1', true)],
  ]);
  const planned = [{ id: ids.app, project: 'demo_store', running: true }];
  const manifest = Buffer.from(
    JSON.stringify({
      format: 'orbis-full-backup',
      version: 1,
      createdAt: 123456,
      orbisVersion: '0.5.0-beta.1',
      runtipiVersion: '4.10.1',
      architecture: 'arm64',
      files: files.map((file) => ({
        name: file.name,
        bytes: Buffer.byteLength(file.bytes),
        sha256: sha(file.bytes),
        mode: 0o600,
        uid: 0,
        gid: 0,
        mtime: 0,
      })),
      directories: [],
      containers: planned,
      images: [{ project: 'demo_store', image: 'nginx:v1' }],
      exclusions: ['container-images', 'logs', 'cache', 'previous-backups'],
    }),
  );
  await fs.writeFile(path.join(content, 'manifest.json'), manifest, { mode: 0o600 });
  const preflight = vi.fn(async () => {
    try {
      await fs.stat(path.join(root, 'pending-recovery'));
      throw new Error('Pending app recovery');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
  const readAppSource = vi.fn(async () => ({
    sourceSha256: appImagePinSourceSha256(dynamicComposeSchemaYaml(JSON.parse(await fs.readFile(live, 'utf8'))), null),
    pinSourceSha256: null as string | null,
  }));
  const engine = {
    containers: vi.fn(async (project: string) => [...values.values()].filter((value) => value.project === project).map((value) => value.id)),
    container: vi.fn(async (id: string) => {
      const found = values.get(id);
      if (!found) throw new Error('Container missing');
      return structuredClone(found);
    }),
    inspectImage: vi.fn(async (id: string, _signal?: AbortSignal, _platform?: RetainedImagePlatform) => ({
      Id: id,
      Os: 'linux',
      Architecture: 'arm64',
      RepoDigests: [],
    })),
    saveImage: vi.fn(async (_id: string) =>
      Readable.from(Array.from({ length: Math.ceil(image.archive.length / 31) }, (_, index) => image.archive.subarray(index * 31, (index + 1) * 31))),
    ),
  };
  const options: ImageCaptureOptions = {
    snapshotContent: content,
    stagingDirectory: staging,
    manifestSha256: sha(manifest),
    pointId: '12345678-1234-4123-8123-123456789abc',
    platform: { os: 'linux', architecture: 'arm64' },
    controller: { containerId: ids.core, project: 'runtipi', service: 'runtipi' },
    databaseId: ids.database,
    apps: [
      {
        urn: 'demo:store',
        userConfigEnabled: true,
        sourceSha256: appImagePinSourceSha256(dynamicComposeSchemaYaml(source), null),
        services: ['web'],
      },
    ],
    plannedContainers: planned,
    docker: engine,
    signal: new AbortController().signal,
    preflight,
    readAppSource,
    limits: { ...retainedImageLimits, imageBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, reserveBytes: 1 },
  };
  return { root, content, staging, manifest, image, ids, values, engine, options, preflight, readAppSource, live };
}
async function capture(test: Awaited<ReturnType<typeof fixture>>) {
  const preparation = await prepareTimeMachineImages(test.options);
  const app = test.values.get(test.ids.app);
  if (app) app.running = false;
  try {
    return { ...(await captureTimeMachineImages({ ...test.options, preparation })), preparation };
  } catch (error) {
    await preparation.dispose();
    throw error;
  }
}
async function collect(reader: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of reader) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function clean(test: Awaited<ReturnType<typeof fixture>>) {
  expect(await fs.readdir(test.staging)).toEqual(['unrelated']);
  expect(await fs.readFile(path.join(test.staging, 'unrelated'), 'utf8')).toBe('preserve');
}

it('compares captured app sources, services, containers and image references against the extracted backup', async () => {
  const test = await fixture();
  const result = await capture(test);
  const check = (capture: Record<string, unknown>) =>
    verifyCaptureAgainstBackup({ capture, content: test.content, manifestSha256: sha(test.manifest), signal: test.options.signal });
  const original = structuredClone(result.capture) as unknown as Record<string, unknown>;
  await expect(check(original)).resolves.toBeUndefined();
  await expect(
    verifyCaptureAgainstBackup({
      capture: original,
      content: test.content,
      manifestSha256: sha(test.manifest),
      excludedApps: ['demo:store'],
      signal: test.options.signal,
    }),
  ).rejects.toThrow();
  for (const mutation of ['source', 'config', 'service', 'container', 'running', 'image', 'extra-app'] as const) {
    const changed = structuredClone(result.capture);
    const app = changed.apps[0];
    const container = changed.containers.find((value) => value.role === 'app');
    if (!app || !container) throw new Error('Fixture missing app');
    if (mutation === 'source') app.sourceSha256 = '1'.repeat(64);
    if (mutation === 'config') app.configurationSha256 = '1'.repeat(64);
    if (mutation === 'service') app.services = ['other'];
    if (mutation === 'container') container.id = '1'.repeat(64);
    if (mutation === 'running') container.wasRunning = !container.wasRunning;
    if (mutation === 'image') container.reference = 'other:v1';
    if (mutation === 'extra-app') changed.apps.push({ ...app, urn: 'extra:store', project: 'extra_store' });
    await expect(check(changed as unknown as Record<string, unknown>), mutation).rejects.toThrow();
  }
  await result.dispose();
  await result.preparation.dispose();
});

it('checks backed-up image pins and the container-image exclusion against captured state', async () => {
  const test = await fixture();
  const result = await capture(test);
  const app = result.capture.apps[0];
  const container = result.capture.containers.find((value) => value.role === 'app');
  if (!app || !container) throw new Error('Fixture missing app');
  const name = `data/state/time-machine/image-pins/${sha(app.urn)}.json`;
  const file = path.join(test.content, name);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const pin = {
    'x-orbis-image-pin': { version: 1, pointId: test.options.pointId, appUrn: app.urn, project: app.project, sourceSha256: app.sourceSha256 },
    services: { [container.service]: { image: container.imageId, pull_policy: 'never' } },
  };
  const base = JSON.parse(test.manifest.toString());
  const check = async (pinValue: unknown, removeExclusion = false) => {
    const data = Buffer.from(JSON.stringify(pinValue));
    await fs.writeFile(file, data, { mode: 0o600 });
    const manifest = {
      ...base,
      files: [...base.files, { name, bytes: data.length, sha256: sha(data), mode: 0o600, uid: 0, gid: 0, mtime: 0 }],
      exclusions: removeExclusion ? ['logs'] : base.exclusions,
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    await fs.writeFile(path.join(test.content, 'manifest.json'), bytes);
    const captured = { ...result.capture, backupManifestSha256: sha(bytes) };
    return verifyCaptureAgainstBackup({
      capture: captured as unknown as Record<string, unknown>,
      content: test.content,
      manifestSha256: sha(bytes),
      signal: test.options.signal,
    });
  };
  await expect(check(pin)).resolves.toBeUndefined();
  const changed = structuredClone(pin);
  changed.services[container.service] = { image: `sha256:${'1'.repeat(64)}`, pull_policy: 'never' };
  await expect(check(changed)).rejects.toThrow();
  await expect(check(pin, true)).rejects.toThrow();
  await result.dispose();
  await result.preparation.dispose();
});

it.each(['capture', 'verify'] as const)('does not interpret a v3 backup using the old image %s contract', async (operation) => {
  const test = await fixture();
  const result = operation === 'verify' ? await capture(test) : undefined;
  const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(test.manifest.toString()), version: 3, mediaPolicy: 'included', volumes: [] }));
  await fs.writeFile(path.join(test.content, 'manifest.json'), bytes);
  test.options.manifestSha256 = sha(bytes);
  if (result) {
    await expect(
      verifyCaptureAgainstBackup({
        capture: { ...result.capture, backupManifestSha256: sha(bytes) } as unknown as Record<string, unknown>,
        content: test.content,
        manifestSha256: sha(bytes),
        signal: test.options.signal,
      }),
    ).rejects.toThrow();
    await result.dispose();
    await result.preparation.dispose();
  } else await expect(capture(test)).rejects.toThrow();
  await clean(test);
});

it('binds private deduplicated app/controller/service image evidence to unchanged legacy bytes without claiming restore readiness', async () => {
  const test = await fixture();
  const captured = await capture(test);
  expect(captured.capture.backupManifestSha256).toBe(sha(test.manifest));
  expect(captured.capture.inventory.images).toHaveLength(1);
  expect(test.engine.saveImage).toHaveBeenCalledTimes(1);
  expect(captured.capture.containers.map((item) => item.role).sort()).toEqual(['app', 'controller', 'controller-service', 'database']);
  expect(captured.capture.containers.find((item) => item.appUrn)?.wasRunning).toBe(true);
  expect(captured.capture.coverage).toMatchObject({
    controller: 'not-quiesced',
    controllerConfiguration: 'not-captured',
    encryptedEnvelope: 'not-integrated',
    restoreReady: false,
  });
  const record = await fs.readFile(path.join(captured.directory, 'capture.json'));
  expect(sha(record)).toBe(captured.sha256);
  expect(await fs.readFile(path.join(test.content, 'manifest.json'))).toEqual(test.manifest);
  expect((await fs.readdir(test.content)).sort()).toEqual(['data', 'manifest.json']);
  expect(test.engine.container.mock.calls.some(([id]) => id === test.ids.unrelated)).toBe(false);
  expect((await fs.stat(captured.directory)).mode & 0o777).toBe(0o700);
  for (const file of captured.files) expect(sha(await collect(await file.open(new AbortController().signal)))).toBe(file.sha256);
});
it('fails before image export if the controller or configured database is missing', async () => {
  for (const kind of ['core', 'database'] as const) {
    const test = await fixture();
    test.values.delete(test.ids[kind]);
    await expect(capture(test)).rejects.toThrow();
    expect(test.engine.saveImage).not.toHaveBeenCalled();
    await clean(test);
  }
});
it('cleans only its private output after a real partial streamed save fails', async () => {
  const test = await fixture();
  test.engine.saveImage.mockImplementation(async () =>
    Readable.from(
      (async function* () {
        yield test.image.archive.subarray(0, 512);
        throw new Error('Save failed');
      })(),
    ),
  );
  await expect(capture(test)).rejects.toThrow('Save failed');
  await clean(test);
  expect(await fs.readFile(path.join(test.content, 'manifest.json'))).toEqual(test.manifest);
});
it('cancels an in-progress save after bytes reach real private staging and removes partial archives', async () => {
  const test = await fixture();
  const abort = new AbortController();
  test.options.signal = abort.signal;
  test.engine.saveImage.mockImplementation(async () =>
    Readable.from(
      (async function* () {
        yield test.image.archive.subarray(0, 512);
        await new Promise<void>((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      })(),
    ),
  );
  const operation = capture(test);
  void operation.catch(() => undefined);
  let observed = false;
  for (let count = 0; count < 500 && !observed; count++) {
    for (const entry of await fs.readdir(test.staging)) {
      if (entry === 'unrelated') continue;
      for (const child of await fs.readdir(path.join(test.staging, entry))) {
        if (!child.startsWith('retained-images-')) continue;
        for (const name of await fs.readdir(path.join(test.staging, entry, child)))
          if ((await fs.stat(path.join(test.staging, entry, child, name))).size > 0) observed = true;
      }
    }
    if (!observed) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(observed).toBe(true);
  abort.abort();
  await expect(operation).rejects.toThrow();
  await clean(test);
});
it.each(['container', 'copied-source', 'live-source', 'manifest', 'archive'])(
  'rejects real %s drift after image bytes were retained',
  async (kind) => {
    const test = await fixture();
    test.preflight
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        if (kind === 'container') {
          const app = test.values.get(test.ids.app);
          if (!app) throw new Error('Missing fixture');
          app.imageId = `sha256:${'0'.repeat(64)}`;
        }
        if (kind === 'copied-source') await fs.writeFile(path.join(test.content, 'data/apps/store/demo/config.json'), '{"tipi_version":2}');
        if (kind === 'live-source') {
          const source = JSON.parse(await fs.readFile(test.live, 'utf8'));
          source.services.web.image = 'nginx:v2';
          await fs.writeFile(test.live, JSON.stringify(source));
        }
        if (kind === 'manifest') await fs.writeFile(path.join(test.content, 'manifest.json'), Buffer.concat([test.manifest, Buffer.from(' ')]));
        if (kind === 'archive') {
          const owned = (await fs.readdir(test.staging)).find((name) => name.startsWith('time-machine-images-'));
          if (!owned) throw new Error('Missing staged fixture');
          const file = path.join(test.staging, owned, 'images', `image-${test.image.id.slice(7)}.tar`);
          await fs.appendFile(file, Buffer.from('changed'));
        }
      });
    await expect(capture(test)).rejects.toThrow();
    expect(test.engine.saveImage).toHaveBeenCalledOnce();
    await clean(test);
  },
);
it('rejects pending app-image recovery and stale pin fingerprints before saving layers', async () => {
  const test = await fixture();
  await fs.writeFile(path.join(test.root, 'pending-recovery'), 'blocked');
  await expect(capture(test)).rejects.toThrow('Pending app recovery');
  expect(test.engine.saveImage).not.toHaveBeenCalled();
  await fs.unlink(path.join(test.root, 'pending-recovery'));
  test.readAppSource.mockImplementation(async () => ({
    sourceSha256: appImagePinSourceSha256(dynamicComposeSchemaYaml(JSON.parse(await fs.readFile(test.live, 'utf8'))), null),
    pinSourceSha256: '0'.repeat(64),
  }));
  await expect(capture(test)).rejects.toThrow();
  expect(test.engine.saveImage).not.toHaveBeenCalled();
  await clean(test);
});
it('fails closed for a managed service without its stopped container and for symlinked copied metadata', async () => {
  const test = await fixture();
  test.values.delete(test.ids.app);
  await expect(capture(test)).rejects.toThrow();
  const other = await fixture();
  const file = path.join(other.content, 'data/apps/store/demo/config.json');
  await fs.unlink(file);
  await fs.symlink(other.live, file);
  await expect(capture(other)).rejects.toThrow();
  expect(other.engine.saveImage).toHaveBeenCalledOnce();
  await clean(other);
});
it('the Docker adapter permits only bounded GET streams and forwards exact platform JSON and cancellation', async () => {
  const image = imageFixture();
  const calls: Record<string, unknown>[] = [];
  const modem = {
    dial: vi.fn((request, callback) => {
      calls.push(request);
      callback(
        null,
        Readable.from([
          Buffer.from(
            request.path.includes('/get?')
              ? image.archive
              : JSON.stringify({ Id: image.id, Os: 'linux', Architecture: 'arm64', Config: { Env: ['do-not-project-fixture'] } }),
          ),
        ]),
      );
    }),
  };
  const adapter = imageCaptureDocker({ modem } as unknown as Dockerode);
  const signal = new AbortController().signal;
  const inspected = await adapter.inspectImage(image.id, signal, { os: 'linux', architecture: 'arm64' });
  expect(inspected).not.toHaveProperty('Config');
  const saved = await adapter.saveImage(image.id, signal, { os: 'linux', architecture: 'arm64' });
  expect(sha(await collect(saved))).toBe(sha(image.archive));
  expect(calls.every((call) => call.method === 'GET' && call.abortSignal === signal)).toBe(true);
  expect(calls.map((call) => call.options)).toEqual([
    { platform: '{"os":"linux","architecture":"arm64"}' },
    { platform: '{"os":"linux","architecture":"arm64"}' },
  ]);
  await expect(adapter.saveImage('mutable:tag', signal)).rejects.toThrow();
  expect(calls).toHaveLength(2);
  let respond: ((error: null, value: Readable) => void) | undefined;
  const delayed = imageCaptureDocker({
    modem: {
      dial: (_request: unknown, callback: typeof respond) => {
        respond = callback;
      },
    },
  } as unknown as Dockerode);
  const abort = new AbortController();
  const pending = delayed.saveImage(image.id, abort.signal);
  void pending.catch(() => undefined);
  abort.abort();
  await expect(pending).rejects.toThrow();
  const late = Readable.from([image.archive]);
  respond?.(null, late);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(late.destroyed).toBe(true);
});

it('separately inspects controller publication labels without projecting private config or unrelated labels', async () => {
  const image = imageFixture();
  const modem = {
    dial: vi.fn((_request, callback) =>
      callback(
        null,
        Readable.from([
          Buffer.from(
            JSON.stringify({
              Id: image.id,
              Os: 'linux',
              Architecture: 'arm64',
              RepoDigests: [],
              Config: {
                Env: ['do-not-project-fixture'],
                Labels: {
                  'org.opencontainers.image.source': 'https://github.com/twentylines/orbis',
                  'org.opencontainers.image.revision': 'a'.repeat(40),
                  unrelated: 'do-not-project-label',
                },
              },
            }),
          ),
        ]),
      ),
    ),
  };
  const adapter = imageCaptureDocker({ modem } as unknown as Dockerode);
  if (!adapter.inspectControllerSource) throw new Error('Missing publication inspection');
  const signal = new AbortController().signal;
  const source = await adapter.inspectControllerSource(image.id, signal);
  expect(source).toMatchObject({
    Id: image.id,
    Labels: { 'org.opencontainers.image.source': 'https://github.com/twentylines/orbis', 'org.opencontainers.image.revision': 'a'.repeat(40) },
  });
  expect(JSON.stringify(source)).not.toContain('do-not-project');
  expect(source).not.toHaveProperty('Config');
  expect(modem.dial.mock.calls[0]?.[0]).toMatchObject({ method: 'GET', abortSignal: signal, options: { manifests: true } });
});

it('prepares before quiescing without a manifest and reuses immutable exports in cheap manifest finalization', async () => {
  const test = await fixture();
  const app = test.values.get(test.ids.app);
  if (!app) throw new Error('Missing app fixture');
  app.running = true;
  await fs.unlink(path.join(test.content, 'manifest.json'));
  const { snapshotContent: _snapshotContent, manifestSha256: _manifestSha256, pointId: _pointId, ...plan } = test.options;
  const preparation = await prepareTimeMachineImages(plan);
  expect(app.running).toBe(true);
  expect(test.engine.saveImage).toHaveBeenCalledOnce();
  await fs.writeFile(path.join(test.content, 'manifest.json'), test.manifest, { mode: 0o600 });
  app.running = false;
  const first = await captureTimeMachineImages({ ...test.options, preparation });
  const second = await captureTimeMachineImages({ ...test.options, pointId: '22345678-1234-4123-8123-123456789abc', preparation });
  expect(test.engine.saveImage).toHaveBeenCalledOnce();
  expect(first.capture.inventorySha256).toBe(second.capture.inventorySha256);
  expect(() => {
    const image = first.capture.inventory.images[0];
    if (image) image.sha256 = '0'.repeat(64);
  }).toThrow();
  expect(await fs.readdir(first.directory)).toEqual(['capture.json']);
  expect(await fs.readdir(second.directory)).toEqual(['capture.json']);
  await first.dispose();
  await second.dispose();
  await preparation.dispose();
  await clean(test);
});
it('revalidates no-follow inode/size/hash while packaging after resume rather than trusting a saved path', async () => {
  const test = await fixture();
  const result = await capture(test);
  const file = result.files.find((item) => item.name.startsWith('images/'));
  if (!file) throw new Error('Missing archive fixture');
  const reader = await file.open(new AbortController().signal);
  const target = path.join(result.preparation.directory, file.name);
  const bytes = await fs.readFile(target);
  bytes[512] = (bytes[512] ?? 0) ^ 1;
  await fs.writeFile(target, bytes);
  await expect(collect(reader)).rejects.toThrow();
  await expect(file.open(new AbortController().signal)).rejects.toThrow();
  await result.dispose();
  await result.preparation.dispose();
  await clean(test);
});
it('does not delete a caller replacement when a prepared staging path loses its owned identity', async () => {
  const test = await fixture();
  const prepared = await prepareTimeMachineImages(test.options);
  await fs.rename(prepared.directory, `${prepared.directory}-held`);
  await fs.mkdir(prepared.directory, { mode: 0o700 });
  await fs.writeFile(path.join(prepared.directory, 'caller-file'), 'preserve');
  await expect(prepared.dispose()).rejects.toThrow();
  expect(await fs.readFile(path.join(prepared.directory, 'caller-file'), 'utf8')).toBe('preserve');
});

it.each(['container', 'live-source'])(
  'rejects %s drift between retained preparation and manifest-bound finalization without another save',
  async (kind) => {
    const test = await fixture();
    const prepared = await prepareTimeMachineImages(test.options);
    if (kind === 'container') {
      const app = test.values.get(test.ids.app);
      if (!app) throw new Error('Missing app fixture');
      app.imageId = `sha256:${'0'.repeat(64)}`;
    } else {
      const source = JSON.parse(await fs.readFile(test.live, 'utf8'));
      source.services.web.image = 'nginx:v2';
      await fs.writeFile(test.live, JSON.stringify(source));
    }
    await expect(captureTimeMachineImages({ ...test.options, preparation: prepared })).rejects.toThrow();
    expect(test.engine.saveImage).toHaveBeenCalledOnce();
    expect(await fs.readdir(test.staging)).toEqual(expect.arrayContaining(['unrelated', path.basename(prepared.directory)]));
    await prepared.dispose();
    await clean(test);
  },
);
it.each(['oversized', 'unlabelled'])('bounds or rejects %s Docker metadata without projecting unrelated values', async (kind) => {
  const image = imageFixture();
  let input: Readable | undefined;
  const adapter = imageCaptureDocker({
    modem: {
      dial: (_request: unknown, callback: (error: null, stream: Readable) => void) => {
        input = Readable.from([
          kind === 'oversized'
            ? Buffer.alloc(2 * 1024 * 1024 + 1, 32)
            : Buffer.from(
                JSON.stringify({
                  Id: 'c'.repeat(64),
                  Image: image.id,
                  Config: { Image: 'core:v1', Labels: {} },
                  State: { Running: true, Paused: false, Restarting: false },
                }),
              ),
        ]);
        callback(null, input);
      },
    },
  } as unknown as Dockerode);
  await expect(adapter.container('c'.repeat(64), new AbortController().signal)).rejects.toThrow();
  expect(input?.destroyed).toBe(true);
});

it.skipIf(process.platform === 'win32')(
  'rejects temporary FIFO replacements without blocking or requiring a writer',
  async () => {
    const execute = promisify(execFile);
    if (process.env.ORBIS_IMAGE_FIFO_TEST_WORKER !== '1') {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-image-fifo-driver-')));
      roots.push(root);
      const output = path.join(root, 'worker.json');
      // Threads keep a regressed blocking open inside the bounded child process.
      await execute(
        process.execPath,
        [
          path.resolve('node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          'vitest.backup.config.mts',
          '--pool=threads',
          '--maxWorkers=1',
          'src/modules/system-backups/backup-image-capture.files.test.ts',
          '-t',
          '^rejects temporary FIFO replacements without blocking or requiring a writer$',
          '--reporter=json',
          `--outputFile=${output}`,
        ],
        {
          cwd: process.cwd(),
          timeout: 8_000,
          killSignal: 'SIGKILL',
          maxBuffer: 128 * 1024,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, ORBIS_IMAGE_FIFO_TEST_WORKER: '1' },
        },
      );
      const report = JSON.parse(await fs.readFile(output, 'utf8'));
      expect(report.success).toBe(true);
      expect(report.numPassedTests).toBe(1);
      return;
    }
    for (const kind of ['manifest', 'finalization-archive', 'reader-open', 'reader-consume'] as const) {
      const test = await fixture();
      const preparation = await prepareTimeMachineImages(test.options);
      let captureResult: Awaited<ReturnType<typeof captureTimeMachineImages>> | undefined;
      let reader: Readable | undefined;
      if (kind.startsWith('reader')) captureResult = await captureTimeMachineImages({ ...test.options, preparation });
      const archived = captureResult?.files.find((file) => file.name.startsWith('images/'));
      if (kind === 'reader-consume') {
        if (!archived) throw new Error('Missing archive fixture');
        reader = await archived.open(new AbortController().signal);
      }
      const target =
        kind === 'manifest'
          ? path.join(test.content, 'manifest.json')
          : path.join(preparation.directory, 'images', `image-${test.image.id.slice(7)}.tar`);
      await fs.unlink(target);
      await execute('mkfifo', [target], { timeout: 2_000, killSignal: 'SIGKILL' });
      expect((await fs.lstat(target)).isFIFO()).toBe(true);
      const started = performance.now();
      if (kind === 'reader-consume') {
        if (!reader) throw new Error('Missing reader fixture');
        await expect(collect(reader)).rejects.toThrow();
      } else if (kind === 'reader-open') {
        if (!archived) throw new Error('Missing archive fixture');
        await expect(archived.open(new AbortController().signal)).rejects.toThrow();
      } else await expect(captureTimeMachineImages({ ...test.options, preparation })).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(1_500);
      await captureResult?.dispose();
      await preparation.dispose();
      await clean(test);
    }
  },
  12_000,
);

it.each([
  'valid',
  'saved-file-drift',
  'omitted-root-file',
  'runtime-identity-drift',
  'runtime-reference-drift',
  'missing-protected-runtime',
] as const)('checks v2 saved files and historical container binding against the extracted backup: %s', async (change) => {
  const test = await fixture();
  const manifest = JSON.parse(test.manifest.toString()) as { files: { name: string; bytes: number; sha256: string }[] };
  const savedFiles = manifest.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })).sort((a, b) => (a.name < b.name ? -1 : 1));
  if (change === 'omitted-root-file')
    savedFiles.splice(
      savedFiles.findIndex((file) => file.name.endsWith('/docker-compose.generated.yml')),
      1,
    );
  const hash = 'a'.repeat(64);
  const runtimeApp = {
    id: 1,
    urn: 'demo:store',
    project: 'demo_store',
    status: 'running',
    pendingRestart: true,
    userConfigEnabled: true,
    sourceSha256: sha(`orbis.app-runtime-saved-source.v1\n${canonicalAppRuntimeJson(savedFiles)}`),
    configurationSha256: required(savedFiles.find((file) => file.name.endsWith('/config.json'))).sha256,
    savedFiles,
    services: [{ name: 'web', replicas: 1 }],
  };
  const raw = {
    schema: 'orbis.app-runtime-capture.v1',
    version: 1,
    pointId: test.options.pointId,
    rootSha256: hash,
    dockerContextSha256: hash,
    daemonSha256: hash,
    configurationSetSha256: hash,
    preparationSha256: hash,
    capturedAt: 1,
    apps: [runtimeApp],
    containers: [
      {
        appUrn: runtimeApp.urn,
        service: 'web',
        ordinal: 1,
        wasRunning: true,
        inspect: {
          Id: test.ids.app,
          Name: '/demo-web-1',
          Image: test.image.id,
          Config: {
            Image: 'nginx:v1',
            Labels: {
              'com.docker.compose.project': 'demo_store',
              'com.docker.compose.service': 'web',
              'com.docker.compose.container-number': '1',
              'com.docker.compose.oneoff': 'False',
              'runtipi.appurn': 'demo:store',
              'runtipi.managed': 'true',
            },
          },
          HostConfig: {},
          Mounts: [],
          NetworkSettings: { Networks: {}, Ports: null },
        },
        image: {
          sourceImageId: test.image.id,
          creationReference: test.image.id,
          platform: { os: 'linux', architecture: 'arm64' },
          selection: 'docker-config.v1',
        },
        transformPolicy: 'orbis.app-runtime-transform.same-host.v1',
      },
    ],
    networkDefinitions: [],
  };
  const blob = Buffer.from(canonicalAppRuntimeJson({ ...raw, sha256: sha(`${raw.schema}\n${canonicalAppRuntimeJson(raw)}`) }));
  const runtime = decodeAppRuntimeCapture(blob, {
    pointId: raw.pointId,
    rootSha256: hash,
    dockerContextSha256: hash,
    daemonSha256: hash,
    configurationSetSha256: hash,
    preparationSha256: hash,
    entrySha256: sha(blob),
  });
  const capture = {
    schema: 'orbis.time-machine-image-capture.v2',
    pointId: raw.pointId,
    createdAt: 123456,
    backupManifestSha256: sha(test.manifest),
    platform: { architecture: 'arm64' },
    apps: [
      {
        urn: runtimeApp.urn,
        project: runtimeApp.project,
        userConfigEnabled: true,
        sourceSha256: runtimeApp.sourceSha256,
        configurationSha256: runtimeApp.configurationSha256,
        services: ['web'],
      },
    ],
    containers: [
      {
        id: test.ids.app,
        appUrn: runtimeApp.urn,
        role: 'app',
        imageId: test.image.id,
        project: runtimeApp.project,
        service: 'web',
        ordinal: change === 'runtime-identity-drift' ? 2 : 1,
        key: 'apps/demo:store/web/1',
        wasRunning: true,
        reference: change === 'runtime-reference-drift' ? 'nginx:other' : 'nginx:v1',
      },
    ],
  };
  if (change === 'saved-file-drift') await fs.writeFile(path.join(test.content, 'data/apps/store/demo/config.json'), 'tampered');
  const result = verifyCaptureAgainstBackup({
    capture,
    content: test.content,
    manifestSha256: sha(test.manifest),
    appRuntime: change === 'missing-protected-runtime' ? undefined : runtime,
    signal: new AbortController().signal,
  });
  if (change === 'valid') await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toThrow();
});

function protectedRuntimeForProducer(
  test: Awaited<ReturnType<typeof fixture>>,
  selection: 'docker-config.v1' | 'docker29-platform-manifest.v1' = 'docker-config.v1',
  secondImageId = test.image.id,
  selectedManifest = `sha256:${'f'.repeat(64)}`,
) {
  const manifest = JSON.parse(test.manifest.toString()) as { files: { name: string; bytes: number; sha256: string }[] };
  const savedFiles = manifest.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })).sort((a, b) => (a.name < b.name ? -1 : 1));
  const h = 'a'.repeat(64);
  const app = {
    id: 1,
    urn: 'demo:store',
    project: 'demo_store',
    status: 'running',
    pendingRestart: true,
    userConfigEnabled: true,
    sourceSha256: sha(`orbis.app-runtime-saved-source.v1\n${canonicalAppRuntimeJson(savedFiles)}`),
    configurationSha256: required(savedFiles.find((file) => file.name.endsWith('/config.json'))).sha256,
    savedFiles,
    services: [{ name: 'web', replicas: 2 }],
  };
  const second = 'b'.repeat(64);
  const first = required(test.values.get(test.ids.app));
  first.running = true;
  test.values.set(second, { ...first, id: second, imageId: secondImageId, running: false });
  const descriptor = {
    schema: 'orbis.app-runtime-capture.v1',
    version: 1,
    pointId: test.options.pointId,
    rootSha256: h,
    dockerContextSha256: h,
    daemonSha256: h,
    configurationSetSha256: h,
    preparationSha256: h,
    capturedAt: 1,
    apps: [app],
    containers: [test.ids.app, second].map((id, index) => ({
      appUrn: app.urn,
      service: 'web',
      ordinal: index + 1,
      wasRunning: index === 0,
      inspect: {
        Id: id,
        Name: `/demo-web-${index + 1}`,
        Image: index === 0 ? test.image.id : secondImageId,
        Config: {
          Image: 'nginx:v1',
          Labels: {
            'com.docker.compose.project': app.project,
            'com.docker.compose.service': 'web',
            'com.docker.compose.container-number': String(index + 1),
            'com.docker.compose.oneoff': 'False',
            'runtipi.appurn': app.urn,
            'runtipi.managed': 'true',
          },
        },
        HostConfig: {},
        Mounts: [],
        NetworkSettings: { Networks: {}, Ports: null },
      },
      image: {
        sourceImageId: index === 0 ? test.image.id : secondImageId,
        creationReference: selection === 'docker-config.v1' ? (index === 0 ? test.image.id : secondImageId) : selectedManifest,
        platform: { os: 'linux', architecture: 'arm64' },
        selection,
      },
      transformPolicy: 'orbis.app-runtime-transform.same-host.v1',
    })),
    networkDefinitions: [],
  };
  const body = Buffer.from(canonicalAppRuntimeJson({ ...descriptor, sha256: sha(`${descriptor.schema}\n${canonicalAppRuntimeJson(descriptor)}`) }));
  return decodeAppRuntimeCapture(body, {
    pointId: descriptor.pointId,
    rootSha256: h,
    dockerContextSha256: h,
    daemonSha256: h,
    configurationSetSha256: h,
    preparationSha256: h,
    entrySha256: sha(body),
  });
}

it('exports replica-specific protected v2 bindings and verifies each archive on read', async () => {
  const test = await fixture();
  const appRuntime = protectedRuntimeForProducer(test);
  const prepared = await prepareProtectedImageCaptureV2({ ...test.options, appRuntime });
  expect(prepared.inventory.bindings.filter((item) => item.key.startsWith('apps/')).map((item) => item.key)).toEqual([
    'apps/demo:store/web/1',
    'apps/demo:store/web/2',
  ]);
  expect(prepared.containers.filter((item) => item.role === 'app').map((item) => item.wasRunning)).toEqual([true, false]);
  expect(prepared.files).toHaveLength(1);
  expect(sha(await collect(await required(prepared.files[0]).open(new AbortController().signal)))).toBe(required(prepared.files[0]).sha256);
  expect(() => JSON.stringify(prepared)).toThrow();
  await prepared.dispose();
  await clean(test);
});
it.each(['valid', 'wrong-selected', 'source-drift', 'wrong-platform', 'wrong-creation', 'config', 'layer', 'diff'] as const)(
  'checks distinct Docker 29 source, selected manifest and config identities: %s',
  async (scenario) => {
    const test = await fixture();
    const image = ociImageFixture(scenario === 'config' || scenario === 'layer' || scenario === 'diff' ? scenario : undefined);
    expect(new Set([image.sourceId, image.manifestId, image.configId]).size).toBe(3);
    test.image.id = image.sourceId;
    for (const container of test.values.values()) container.imageId = image.sourceId;
    const appRuntime = protectedRuntimeForProducer(
      test,
      'docker29-platform-manifest.v1',
      image.sourceId,
      scenario === 'wrong-creation' ? `sha256:${'f'.repeat(64)}` : image.manifestId,
    );
    let unfiltered = 0;
    let filtered = 0;
    test.engine.inspectImage.mockImplementation(async (id, _signal, platform) => {
      if (!platform) {
        unfiltered++;
        return {
          Id: scenario === 'source-drift' && unfiltered >= 3 ? `sha256:${'d'.repeat(64)}` : id,
          Os: 'linux',
          Architecture: 'arm64',
          RepoDigests: [],
          Manifests: [{ Kind: 'image', Available: true, Descriptor: { digest: image.manifestId, platform: image.platform } }],
        };
      }
      filtered++;
      return {
        Id: scenario === 'wrong-selected' && filtered >= 4 ? `sha256:${'e'.repeat(64)}` : image.manifestId,
        Os: 'linux',
        Architecture: scenario === 'wrong-platform' && filtered >= 4 ? 'amd64' : 'arm64',
        RepoDigests: [],
      };
    });
    test.engine.saveImage.mockImplementation(async () => Readable.from([image.archive]));
    const result = prepareProtectedImageCaptureV2({ ...test.options, appRuntime });
    if (scenario === 'valid') {
      const prepared = await result;
      const retained = required(prepared.inventory.images[0]);
      expect(retained.imageId).toBe(image.sourceId);
      expect(retained.identity).toMatchObject({ kind: 'oci', manifestId: image.manifestId, configId: image.configId, platform: image.platform });
      expect(unfiltered).toBeGreaterThanOrEqual(3);
      expect(filtered).toBeGreaterThanOrEqual(4);
      expect(sha(await collect(await required(prepared.files[0]).open(new AbortController().signal)))).toBe(required(prepared.files[0]).sha256);
      await prepared.dispose();
    } else {
      await expect(result).rejects.toThrow();
    }
    await clean(test);
  },
);
it.each(['unknown-container', 'image-graph-drift', 'cancel'] as const)('fails closed and cleans up a v2 preparation on %s', async (kind) => {
  const test = await fixture();
  const appRuntime = protectedRuntimeForProducer(test, kind === 'image-graph-drift' ? 'docker29-platform-manifest.v1' : 'docker-config.v1');
  if (kind === 'unknown-container') test.values.set('f'.repeat(64), { ...required(test.values.get(test.ids.app)), id: 'f'.repeat(64) });
  const controller = new AbortController();
  const result = prepareProtectedImageCaptureV2({
    ...test.options,
    appRuntime,
    signal: controller.signal,
    preflight: kind === 'cancel' ? async () => new Promise<void>(() => {}) : test.preflight,
  });
  if (kind === 'cancel') controller.abort();
  await expect(result).rejects.toThrow();
  await clean(test);
});

it('rejects a changed app after v2 image export and removes the owned staging files', async () => {
  const test = await fixture();
  const appRuntime = protectedRuntimeForProducer(test);
  let calls = 0;
  const prepared = prepareProtectedImageCaptureV2({
    ...test.options,
    appRuntime,
    preflight: async () => {
      if (++calls === 2) required(test.values.get(test.ids.app)).running = false;
    },
  });
  await expect(prepared).rejects.toThrow();
  await clean(test);
});
it('refuses a v2 archive changed after its authenticated capture', async () => {
  const test = await fixture();
  const appRuntime = protectedRuntimeForProducer(test);
  const prepared = await prepareProtectedImageCaptureV2({ ...test.options, appRuntime });
  const directory = required((await fs.readdir(test.staging)).find((name) => name.startsWith('retained-images-')));
  const file = required(prepared.files[0]);
  await fs.appendFile(path.join(test.staging, directory, path.basename(file.name)), 'changed');
  await expect(collect(await file.open(new AbortController().signal))).rejects.toThrow();
  await prepared.dispose();
  await clean(test);
});

it('retains distinct historical images for replicas of the same service', async () => {
  const test = await fixture();
  const second = imageFixture('-second');
  const appRuntime = protectedRuntimeForProducer(test, 'docker-config.v1', second.id);
  test.engine.saveImage.mockImplementation(async (id: string) => Readable.from([id === second.id ? second.archive : test.image.archive]));
  const prepared = await prepareProtectedImageCaptureV2({ ...test.options, appRuntime });
  const apps = prepared.inventory.bindings.filter((item) => item.key.startsWith('apps/'));
  expect(apps).toEqual([
    { key: 'apps/demo:store/web/1', imageId: test.image.id },
    { key: 'apps/demo:store/web/2', imageId: second.id },
  ]);
  expect(prepared.inventory.images).toHaveLength(2);
  await prepared.dispose();
  await clean(test);
});
it('rejects a forged v2 runtime object before reading Docker', async () => {
  const test = await fixture();
  const runtime = protectedRuntimeForProducer(test);
  await expect(prepareProtectedImageCaptureV2({ ...test.options, appRuntime: { metadata: runtime.metadata } as never })).rejects.toThrow();
  expect(test.engine.containers).not.toHaveBeenCalled();
  await clean(test);
});

it.each(['valid', 'app-still-running', 'saved-file-changed', 'archive-changed', 'unsupported-backup-format'] as const)(
  'finalizes v2 only after stopped runtime, saved files and archive are consistent: %s',
  async (kind) => {
    const test = await fixture();
    const appRuntime = protectedRuntimeForProducer(test);
    const prepared = await prepareProtectedImageCaptureV2({ ...test.options, appRuntime });
    const original = required(test.values.get(test.ids.app));
    if (kind !== 'app-still-running') original.running = false;
    const manifest = JSON.parse(test.manifest.toString());
    if (kind === 'unsupported-backup-format') Object.assign(manifest, { version: 3, mediaPolicy: 'included', volumes: [] });
    manifest.containers.push({ id: 'b'.repeat(64), project: 'demo_store', running: false });
    manifest.images.push({ project: 'demo_store', image: 'nginx:v1' });
    const bytes = Buffer.from(JSON.stringify(manifest));
    await fs.writeFile(path.join(test.content, 'manifest.json'), bytes, { mode: 0o600 });
    if (kind === 'saved-file-changed') await fs.writeFile(path.join(test.content, 'data/apps/store/demo/config.json'), 'changed');
    if (kind === 'archive-changed') {
      const directory = required((await fs.readdir(test.staging)).find((name) => name.startsWith('retained-images-')));
      await fs.appendFile(path.join(test.staging, directory, path.basename(required(prepared.files[0]).name)), 'changed');
    }
    const result = finalizeProtectedImageCaptureV2({
      prepared,
      snapshotContent: test.content,
      manifestSha256: sha(bytes),
      signal: new AbortController().signal,
    });
    if (kind === 'valid') {
      const finalized = await result;
      expect(finalized.capture.schema).toBe('orbis.time-machine-image-capture.v2');
      expect(
        finalized.capture.containers.filter((entry) => entry.role === 'app').map((entry) => [entry.ordinal, entry.running, entry.wasRunning]),
      ).toEqual([
        [1, false, true],
        [2, false, false],
      ]);
      expect(sha(await collect(await required(finalized.files[0]).open(new AbortController().signal)))).toBe(finalized.sha256);
    } else await expect(result).rejects.toThrow();
    await prepared.dispose();
    await clean(test);
  },
);
