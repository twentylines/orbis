import { HttpException } from '@nestjs/common';
import { decodeControllerCaptureAuthority } from '../host-updates/host-controller-capture-authority';
import type { RetainedImage } from './backup-image-retention';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import { convertLegacyToYaml } from '@runtipi/common/schemas';
import type { ImageCaptureContainer } from './backup-image-capture';
import { TimeMachineCaptureRuntime } from './time-machine-capture-runtime';
import { controllerConfigPaths, decodeControllerConfigurationCapture, type ControllerCaptureIdentity } from '../host-updates/host-controller-config';
import {
  decodeControllerPublicationReceipt,
  type ControllerPublicationExpectation,
  type ControllerPublicationReceipt,
} from '../host-updates/host-controller-publication';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );
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
function imageFixture() {
  const layer = tar([{ name: 'app-data', bytes: Buffer.from('image layer bytes') }]);
  const labels = {
    'org.opencontainers.image.source': 'https://github.com/twentylines/orbis',
    'org.opencontainers.image.version': 'v0.5.0-beta.3',
    'org.opencontainers.image.revision': 'a'.repeat(40),
    'io.orbis.installation-protocol': 'orbis.installation-state.v1',
  };
  const config = Buffer.from(
    JSON.stringify({
      architecture: 'arm64',
      os: 'linux',
      config: { Labels: labels },
      rootfs: { type: 'layers', diff_ids: [`sha256:${sha(layer)}`] },
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${sha(config)}`, size: config.length },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${sha(layer)}`, size: layer.length }],
    }),
  );
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${sha(manifest)}`,
          size: manifest.length,
          platform: { os: 'linux', architecture: 'arm64' },
        },
      ],
    }),
  );
  const publication = {
    schema: 'orbis.release.v1',
    image: 'ghcr.io/twentylines/orbis',
    tag: labels['org.opencontainers.image.version'],
    commit: labels['org.opencontainers.image.revision'],
    digest: `sha256:${sha(index)}`,
    runtipiCompatibility: '4.10.1',
    installationProtocol: labels['io.orbis.installation-protocol'],
  };
  const id = `sha256:${sha(config)}`;
  const configName = `${id.slice(7)}.json`;
  const layerName = `${'b'.repeat(64)}/layer.tar`;
  return {
    id,
    labels,
    publication,
    proof: {
      schema: 'orbis.controller-publication-proof.v1',
      publication,
      platform: { os: 'linux', architecture: 'arm64' },
      index: index.toString('base64'),
      manifest: manifest.toString('base64'),
      config: config.toString('base64'),
    },
    archive: tar([
      { name: configName, bytes: config },
      { name: layerName, bytes: layer },
      { name: 'manifest.json', bytes: Buffer.from(JSON.stringify([{ Config: configName, Layers: [layerName], RepoTags: null }])) },
    ]),
  };
}

// Docker and the privileged host boundary are explicit fixtures; capture, archive and encryption code are real.
export async function connectedCaptureFixture(data: string, config: unknown) {
  const image = imageFixture();
  const ids = { app: 'a'.repeat(64), core: 'c'.repeat(64), database: 'b'.repeat(64) };
  const reference = `ghcr.io/twentylines/orbis@${image.publication.digest}`;
  const values = new Map<string, ImageCaptureContainer>();
  const add = (id: string, project: string, service: string, ref: string) =>
    values.set(id, { id, project, service, reference: ref, imageId: image.id, running: true, paused: false, restarting: false, oneOff: false });
  add(ids.app, 'fixture_store', 'web', 'fixture:v1');
  add(ids.core, 'runtipi', 'runtipi', reference);
  add(ids.database, 'runtipi', 'runtipi-db', 'postgres:16');
  const source = convertLegacyToYaml({ schemaVersion: 2, services: [{ name: 'web', image: 'fixture:v1', isMain: true, internalPort: 80 }] });
  const app = path.join(data, 'apps', 'store', 'fixture');
  await fs.mkdir(app, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(app, 'docker-compose.yml'), JSON.stringify(source), { mode: 0o600 });
  await fs.writeFile(path.join(app, 'docker-compose.generated.yml'), 'services:\n  web:\n    image: fixture:v1\n', { mode: 0o600 });
  await fs.writeFile(path.join(app, 'config.json'), JSON.stringify({ name: 'fixture', tipi_version: 1 }), { mode: 0o600 });
  const engine = {
    containers: vi.fn(async (project: string) => [...values.values()].filter((item) => item.project === project).map((item) => item.id)),
    container: vi.fn(async (id: string) => structuredClone(values.get(id))),
    inspectImage: vi.fn(async (id: string) => ({
      Id: id,
      Os: 'linux',
      Architecture: 'arm64',
      RepoDigests: [reference],
    })),
    saveImage: vi.fn(async () => Readable.from([image.archive])),
    inspectControllerSource: vi.fn(async (id: string) => ({
      Id: id,
      Os: 'linux',
      Architecture: 'arm64',
      RepoDigests: [reference],
      Labels: image.labels,
    })),
  };
  let configRevision = 0;
  const hostRead = {
    requireControllerConfigurationSupport: vi.fn(async () => undefined),
    requireControllerPublicationSupport: vi.fn(async () => undefined),
    prepareControllerPublication: vi.fn(async (expected: ControllerPublicationExpectation) => {
      const descriptor = {
        version: 1,
        pointId: expected.configuration.pointId,
        controller: expected.configuration.controller,
        rootIdentity: expected.configuration.rootIdentity,
        configurationSetSha256: expected.configuration.configurationSetSha256,
        proof: image.proof,
      };
      return decodeControllerPublicationReceipt(
        { ...descriptor, preparationSha256: sha(`orbis.controller-publication-capture.v1\n${canonical(descriptor)}`) },
        expected,
      );
    }),
    captureControllerConfiguration: vi.fn(async (identity: ControllerCaptureIdentity) => {
      const files = await Promise.all(
        controllerConfigPaths.map(async (name) => {
          if (name === 'user-config/tipi-compose.yml' || name === 'orbis-host-compose.yml') return { path: name, present: false };
          const bytes = name === '.env' ? await fs.readFile(path.join(data, '.env')) : Buffer.from(`services: {}\n# fixture ${configRevision}`);
          return {
            path: name,
            present: true,
            bytes: bytes.length,
            mode: 0o600,
            uid: process.getuid?.() ?? 0,
            gid: process.getgid?.() ?? 0,
            device: '1',
            inode: '2',
            mtimeNs: '1',
            ctimeNs: '1',
            sha256: sha(bytes),
            data: bytes.toString('base64'),
          };
        }),
      );
      const descriptor = {
        version: 1,
        pointId: identity.pointId,
        controller: {
          id: ids.core,
          imageId: image.id,
          imageReference: reference,
          project: 'runtipi',
          service: 'runtipi',
          startedAt: '2026-10-31T00:00:00Z',
          releaseTag: image.publication.tag,
          releaseDigest: image.publication.digest,
        },
        rootIdentity: { device: '1', inode: '1', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mode: 0o700, pathSha256: sha(data) },
        files: files.map(({ data: _data, ...item }) => item),
      };
      return decodeControllerConfigurationCapture(
        { ...descriptor, files, configurationSetSha256: sha(`orbis.controller-config.v1\n${canonical(descriptor)}`) },
        identity,
      );
    }),
  };
  const fence = {
    renew: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    finalizeControllerArchive: vi.fn(
      async (
        expected: ControllerPublicationExpectation,
        receipt: ControllerPublicationReceipt,
        archive: RetainedImage,
        open: () => Promise<Readable>,
        signal?: AbortSignal,
      ) => {
        let bytes = 0;
        const hash = createHash('sha256');
        const source = await open();
        for await (const chunk of source) {
          signal?.throwIfAborted();
          bytes += chunk.length;
          hash.update(chunk);
        }
        if (bytes !== archive.bytes || hash.digest('hex') !== archive.sha256) throw new Error('Fixture root archive changed');
        const descriptor = {
          schema: 'orbis.controller-capture-authority.v1',
          version: 1,
          pointId: expected.configuration.pointId,
          configurationSetSha256: expected.configuration.configurationSetSha256,
          preparationSha256: receipt.metadata.preparationSha256,
          publicationProofSha256: sha(receipt.read()),
          rootIdentitySha256: sha(canonical(expected.configuration.rootIdentity)),
          publication: expected.publication,
          platform: expected.platform,
          archive: {
            kind: archive.identity.kind,
            sha256: archive.sha256,
            bytes: archive.bytes,
            archiveRootId: archive.identity.archiveRootId,
            platformManifestDigest: receipt.metadata.platformManifestDigest,
            configDigest: receipt.metadata.configDigest,
            sourceImageId: expected.configuration.controller.imageId,
            creationReference: archive.identity.kind === 'oci' ? archive.identity.manifestId : archive.identity.configId,
          },
          finalizedAt: Date.now(),
        };
        return decodeControllerCaptureAuthority(
          { ...descriptor, authoritySha256: sha(`orbis.controller-capture-authority.v1\n${canonical(descriptor)}`) },
          expected,
          receipt,
          archive,
        );
      },
    ),
  };
  const host = Object.assign(hostRead, {
    requireControllerCaptureFenceSupport: vi.fn(async () => undefined),
    requireControllerCaptureAuthoritySupport: vi.fn(async () => undefined),
    requireBackupArchiveSupport: vi.fn(async () => undefined),
    requireV6CaptureCapability: vi.fn(async () => {
      throw new HttpException('Unsupported', 404);
    }),
    reconcileControllerCaptureFence: vi.fn(async (_expected: ControllerPublicationExpectation, _receipt: unknown, _clientKey: string) => undefined),
    acquireControllerCaptureFence: vi.fn(
      async (expected: ControllerPublicationExpectation, _receipt: unknown, _signal?: AbortSignal, _clientKey?: string) => ({
        renew: fence.renew,
        release: fence.release,
        finalizeControllerArchive: (archive: RetainedImage, open: () => Promise<Readable>, signal?: AbortSignal) =>
          fence.finalizeControllerArchive(expected, _receipt as ControllerPublicationReceipt, archive, open, signal),
        capture: async () =>
          hostRead.captureControllerConfiguration({
            pointId: expected.configuration.pointId,
            controllerId: expected.configuration.controller.id,
            imageId: expected.configuration.controller.imageId,
          }),
      }),
    ),
  });
  const appDocker = { requireNoPendingAppImageUpdates: vi.fn(async () => undefined), readAppImagePins: vi.fn(async () => null) };
  const docker = {
    getContainer: () => ({
      inspect: async () => ({
        Id: ids.core,
        Image: image.id,
        Config: { Labels: { 'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi' } },
        Mounts: [{ Type: 'bind', Source: data, Destination: data }],
      }),
    }),
  };
  const runtime = new TimeMachineCaptureRuntime(
    ...([config, host, appDocker, docker, engine, 3] as unknown as ConstructorParameters<typeof TimeMachineCaptureRuntime>),
  );
  const failures: unknown[] = [];
  const operation = runtime.operation.bind(runtime);
  vi.spyOn(runtime, 'operation').mockImplementation((...args) => {
    const result = operation(...args);
    for (const key of ['hostPreflight', 'beforeQuiesce', 'finalize'] as const) {
      const run = result[key].bind(result);
      Reflect.set(result, key, async (...values: never[]) => {
        try {
          return await Reflect.apply(run, result, values);
        } catch (error) {
          failures.push(error);
          throw error;
        }
      });
    }
    return result;
  });
  return {
    runtime,
    failures,
    fence,
    host,
    engine,
    values,
    ids,
    image,
    app,
    driftConfiguration: () => {
      configRevision++;
    },
  };
}
