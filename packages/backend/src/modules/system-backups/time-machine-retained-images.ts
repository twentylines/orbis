import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { encodeAppImagePins } from '../docker/app-image-pins';
import { loadRetainedImages, validateRetainedImageInventory, type RetainedImageDocker } from './backup-image-retention';
import { imageCaptureDocker, verifyCaptureAgainstBackup } from './backup-image-capture';
import { canonicalRuntimeJson, decodeRuntimePayloadManifest, runtimePayloadLimits } from './time-machine-runtime-payload';
import { decodeControllerPublicationReceipt, parseControllerPublicationResponse } from '../host-updates/host-controller-publication';
import { decodeControllerCaptureAuthority } from '../host-updates/host-controller-capture-authority';
import { appRuntimeEntryLimit, appRuntimeImageBindings, decodeAppRuntimeCapture } from './time-machine-app-runtime-capture';
import type { RetainedRootBinding } from './time-machine-retained-bootstrap';

const fail = () => new Error('Retained app images could not be verified.');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
async function readPrivate(file: string, maximum: number, signal: AbortSignal) {
  if ((await fs.realpath(path.dirname(file))) !== path.dirname(file)) throw fail();
  const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      before.size < 1 ||
      before.size > maximum ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw fail();
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const part = await input.read(buffer, offset, buffer.length - offset, offset);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    const after = await input.stat();
    const current = await fs.lstat(file);
    if (
      offset !== before.size ||
      [after, current].some((stat) =>
        ['ino', 'dev', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(before, key)),
      )
    )
      throw fail();
    return buffer.subarray(0, offset);
  } finally {
    await input.close();
  }
}

// The manifest digest comes from the freshly authenticated protected root phase binding.
export async function readRootBoundImageExpectations(options: {
  dataDirectory: string;
  restoreId: string;
  manifestSha256: string;
  pointId: string;
  target?: RetainedRootBinding['target'];
  signal: AbortSignal;
}) {
  if (
    !path.isAbsolute(options.dataDirectory) ||
    path.resolve(options.dataDirectory) !== options.dataDirectory ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.restoreId) ||
    !/^[a-f0-9]{64}$/.test(options.manifestSha256)
  )
    throw fail();
  const retained = path.join(options.dataDirectory, 'backups', 'restores', options.restoreId, 'retained');
  const manifestBytes = await readPrivate(path.join(retained, 'runtime-manifest.json'), runtimePayloadLimits.metadataBytes, options.signal);
  if (sha(manifestBytes) !== options.manifestSha256) throw fail();
  const manifest = decodeRuntimePayloadManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)));
  if (
    !['orbis.time-machine-runtime.v3', 'orbis.time-machine-runtime.v4', 'orbis.time-machine-runtime.v6'].includes(manifest.schema) ||
    manifest.pointId !== options.pointId
  )
    throw fail();
  const captureBytes = await readPrivate(path.join(retained, 'image-capture.json'), 4 * 1024 * 1024, options.signal);
  if (sha(captureBytes) !== manifest.imageCaptureSha256) throw fail();
  const capture: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captureBytes));
  if (!record(capture) || capture.pointId !== options.pointId) throw fail();
  if (manifest.schema !== 'orbis.time-machine-runtime.v6')
    return { expectedManifest: manifest, expectedManifestSha256: options.manifestSha256, expectedCapture: capture };
  if (!options.target || capture.schema !== 'orbis.time-machine-image-capture.v2') throw fail();
  const inventory = validateRetainedImageInventory(capture.inventory);
  if (sha(canonicalRuntimeJson(inventory)) !== manifest.imageInventorySha256) throw fail();
  const image = inventory.images.find((item) => item.imageId === manifest.controller.sourceImageId);
  if (!image) throw fail();
  const publicationBytes = await readPrivate(path.join(retained, 'controller-publication.json'), 1024 * 1024, options.signal);
  if (sha(publicationBytes) !== manifest.publicationProofSha256) throw fail();
  const expectation = { configuration: manifest.configuration, publication: options.target.publication, platform: options.target.platform };
  const publication = decodeControllerPublicationReceipt(parseControllerPublicationResponse(publicationBytes), expectation);
  const authorityBytes = await readPrivate(path.join(retained, 'controller-authority.json'), 64 * 1024, options.signal);
  if (sha(authorityBytes) !== manifest.controllerAuthoritySha256) throw fail();
  const authority = decodeControllerCaptureAuthority(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(authorityBytes)),
    expectation,
    publication,
    image,
  );
  if (
    authority.metadata.version !== 4 ||
    !authority.read().equals(authorityBytes) ||
    authority.metadata.archive.creationReference !== options.target.creationReference ||
    publication.metadata.platformManifestDigest !== options.target.platformManifestDigest ||
    publication.metadata.configDigest !== options.target.configDigest
  )
    throw fail();
  const appBytes = await readPrivate(path.join(retained, 'app-runtime.json'), appRuntimeEntryLimit, options.signal);
  const appRuntime = decodeAppRuntimeCapture(appBytes, {
    pointId: options.pointId,
    rootSha256: manifest.configuration.rootIdentity.pathSha256,
    dockerContextSha256: authority.metadata.proxyHostIdentity.dockerContextSha256,
    daemonSha256: authority.metadata.appRuntimeDaemonSha256,
    configurationSetSha256: manifest.configurationSetSha256,
    preparationSha256: publication.metadata.preparationSha256,
    entrySha256: manifest.appRuntimeSha256,
  });
  if (authority.metadata.appRuntimeSha256 !== manifest.appRuntimeSha256) throw fail();
  return { expectedManifest: manifest, expectedManifestSha256: options.manifestSha256, expectedCapture: capture, expectedAppRuntime: appRuntime };
}

/** V6 images are loaded by their independently bound replica keys; no Compose pins are generated. */
export async function loadRetainedV6Images(options: {
  dataDirectory: string;
  restoreId: string;
  expectedManifest: unknown;
  expectedManifestSha256: string;
  expectedCapture: unknown;
  expectedAppRuntime: ReturnType<typeof decodeAppRuntimeCapture>;
  docker: RetainedImageDocker;
  signal: AbortSignal;
}) {
  if (
    !path.isAbsolute(options.dataDirectory) ||
    path.resolve(options.dataDirectory) !== options.dataDirectory ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.restoreId) ||
    !/^[a-f0-9]{64}$/.test(options.expectedManifestSha256)
  )
    throw fail();
  const manifest = decodeRuntimePayloadManifest(options.expectedManifest);
  if (manifest.schema !== 'orbis.time-machine-runtime.v6' || !record(options.expectedCapture)) throw fail();
  const root = path.join(options.dataDirectory, 'backups', 'restores', options.restoreId);
  const retained = path.join(root, 'retained');
  const manifestBytes = await readPrivate(path.join(retained, 'runtime-manifest.json'), runtimePayloadLimits.metadataBytes, options.signal);
  const captureBytes = await readPrivate(path.join(retained, 'image-capture.json'), 4 * 1024 * 1024, options.signal);
  const appBytes = await readPrivate(path.join(retained, 'app-runtime.json'), appRuntimeEntryLimit, options.signal);
  if (
    sha(manifestBytes) !== options.expectedManifestSha256 ||
    sha(captureBytes) !== manifest.imageCaptureSha256 ||
    sha(appBytes) !== manifest.appRuntimeSha256 ||
    !appBytes.equals(options.expectedAppRuntime.read()) ||
    canonicalRuntimeJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captureBytes))) !== canonicalRuntimeJson(options.expectedCapture)
  )
    throw fail();
  const inventory = validateRetainedImageInventory(options.expectedCapture.inventory);
  if (sha(canonicalRuntimeJson(inventory)) !== manifest.imageInventorySha256) throw fail();
  const bindings = appRuntimeImageBindings(options.expectedAppRuntime);
  if (inventory.bindings.filter((item) => item.key.startsWith('apps/')).length !== bindings.length) throw fail();
  for (const binding of bindings) {
    const historical = options.expectedAppRuntime.metadata.containers.find((item) => item.inspect.Id === binding.containerId);
    const image = inventory.images.find((item) => item.imageId === binding.imageId);
    const creation = image?.identity.kind === 'oci' ? image.identity.manifestId : image?.identity.configId;
    if (
      !historical ||
      !image ||
      !creation ||
      creation !== historical.image.creationReference ||
      (historical.image.selection === 'docker29-platform-manifest.v1') !== (image.identity.kind === 'oci') ||
      (image.identity.kind === 'oci' && canonicalRuntimeJson(image.identity.platform) !== canonicalRuntimeJson(historical.image.platform)) ||
      !inventory.bindings.some((item) => item.key === binding.key && item.imageId === binding.imageId)
    )
      throw fail();
  }
  await verifyCaptureAgainstBackup({
    capture: options.expectedCapture,
    content: path.join(root, 'source', 'payload', 'content'),
    manifestSha256: manifest.legacy.manifestSha256,
    appRuntime: options.expectedAppRuntime,
    signal: options.signal,
  });
  const loaded = await loadRetainedImages({
    stagingDirectory: path.join(retained, 'images'),
    inventory,
    docker: options.docker,
    signal: options.signal,
  });
  for (const binding of bindings) {
    const image = inventory.images.find((item) => item.imageId === binding.imageId);
    const creation = image?.identity.kind === 'oci' ? image.identity.manifestId : image?.identity.configId;
    if (!creation || loaded.get(binding.key) !== creation) throw fail();
  }
}

/** Expected manifest/capture must come from the point-bound v3 admission, not the staged files. */
export async function prepareRetainedImagePins(options: {
  dataDirectory: string;
  restoreId: string;
  expectedManifest: unknown;
  expectedManifestSha256: string;
  expectedCapture: unknown;
  docker: RetainedImageDocker;
  signal: AbortSignal;
}) {
  if (
    !path.isAbsolute(options.dataDirectory) ||
    path.resolve(options.dataDirectory) !== options.dataDirectory ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.restoreId) ||
    !/^[a-f0-9]{64}$/.test(options.expectedManifestSha256)
  )
    throw fail();
  const root = path.join(options.dataDirectory, 'backups', 'restores', options.restoreId);
  const retained = path.join(root, 'retained');
  const manifestBytes = await readPrivate(path.join(retained, 'runtime-manifest.json'), runtimePayloadLimits.metadataBytes, options.signal);
  if (sha(manifestBytes) !== options.expectedManifestSha256) throw fail();
  const manifest = decodeRuntimePayloadManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)));
  if (
    !['orbis.time-machine-runtime.v3', 'orbis.time-machine-runtime.v4'].includes(manifest.schema) ||
    canonicalRuntimeJson(manifest) !== canonicalRuntimeJson(options.expectedManifest)
  )
    throw fail();
  const captureBytes = await readPrivate(path.join(retained, 'image-capture.json'), 4 * 1024 * 1024, options.signal);
  if (sha(captureBytes) !== manifest.imageCaptureSha256) throw fail();
  const capture: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captureBytes));
  if (
    !record(capture) ||
    canonicalRuntimeJson(capture) !== canonicalRuntimeJson(options.expectedCapture) ||
    capture.pointId !== manifest.pointId ||
    !Array.isArray(capture.apps)
  )
    throw fail();
  const inventory = validateRetainedImageInventory(capture.inventory);
  if (sha(canonicalRuntimeJson(inventory)) !== manifest.imageInventorySha256) throw fail();
  await verifyCaptureAgainstBackup({
    capture,
    content: path.join(root, 'source', 'payload', 'content'),
    manifestSha256: manifest.legacy.manifestSha256,
    signal: options.signal,
  });
  const loaded = await loadRetainedImages({
    stagingDirectory: path.join(retained, 'images'),
    inventory,
    docker: options.docker,
    signal: options.signal,
  });
  const pins: { name: string; data: Uint8Array }[] = [];
  for (const app of capture.apps) {
    if (
      !record(app) ||
      typeof app.urn !== 'string' ||
      typeof app.project !== 'string' ||
      typeof app.sourceSha256 !== 'string' ||
      !Array.isArray(app.services) ||
      app.services.some((service: unknown) => typeof service !== 'string')
    )
      throw fail();
    const services: Record<string, string> = {};
    for (const service of app.services as string[]) {
      const image = loaded.get(`apps/${app.urn}/${service}`);
      if (!image || Object.hasOwn(services, service)) throw fail();
      services[service] = image;
    }
    const encoded = encodeAppImagePins(
      { appUrn: app.urn, project: app.project, sourceSha256: app.sourceSha256 },
      { version: 1, pointId: manifest.pointId, sourceSha256: app.sourceSha256, services },
    );
    pins.push({ name: `${sha(app.urn)}.json`, data: encoded.data });
  }
  return pins;
}

// Root must supply a preflight that checks the Docker daemon's actual storage, not the container filesystem.
export function retainedImageDocker(docker: Dockerode, preflightLoad: RetainedImageDocker['preflightLoad']): RetainedImageDocker {
  const source = imageCaptureDocker(docker);
  return {
    inspect: source.inspectImage,
    save: source.saveImage,
    preflightLoad,
    load: async (input, signal) => {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        let settled = false;
        const abort = () => {
          input.destroy(fail());
          if (!settled) {
            settled = true;
            reject(fail());
          }
        };
        signal.addEventListener('abort', abort, { once: true });
        docker.modem.dial(
          {
            path: '/images/load?',
            method: 'POST',
            options: {},
            file: input,
            abortSignal: signal,
            isStream: true,
            statusCodes: { 200: true, 400: 'Image load failed', 500: 'Image load failed' },
          },
          (error, value) => {
            if (settled) {
              if (value && typeof value === 'object' && 'destroy' in value && typeof value.destroy === 'function') value.destroy();
              return;
            }
            settled = true;
            signal.removeEventListener('abort', abort);
            if (error || !(value instanceof Readable) || signal.aborted) {
              input.destroy();
              if (value instanceof Readable) value.destroy();
              reject(fail());
              return;
            }
            resolve(value);
          },
        );
        if (signal.aborted) abort();
      });
    },
  };
}
