import { appRuntimeEntryLimit, appRuntimeEntryName, appRuntimeImageBindings, decodeAppRuntimeCapture } from './time-machine-app-runtime-capture';
import { coherenceEntryName, verifyCaptureCoherenceReceipt, type CaptureCoherenceReceipt } from './time-machine-capture-coherence';
import { decodeProxyHostIdentity, proxyHostIdentityEntryName } from '../host-updates/host-proxy-identity';
import {
  controllerAuthorityEntryName,
  decodeControllerCaptureAuthority,
  type ControllerCaptureAuthorityReceipt,
} from '../host-updates/host-controller-capture-authority';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { decryptBackup, backupCipherOverhead } from './backup-crypto';
import { validateRetainedImageInventory, verifyRetainedImageArchives } from './backup-image-retention';
import { decodeControllerConfigurationCapture } from '../host-updates/host-controller-config';
import type { ControllerPublicationExpectation } from '../host-updates/host-controller-publication';
import {
  canonicalRuntimeJson,
  decodeRuntimePayloadManifest,
  decodeRuntimePublicationEntry,
  runtimePayloadLength,
  runtimePayloadLimits,
} from './time-machine-runtime-payload';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const fail = () => new Error('Runtime admission failed');
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

/** All expected values must come from an independently authenticated point record, never the runtime response. */
export type RuntimeAdmissionExpectation = {
  manifestSha256: string;
  manifest: unknown;
  publication: ControllerPublicationExpectation;
};

/** Admission only: authenticates GCM before parsing or exposing any staged file. Does not load or activate images. */
export async function admitRuntimeFile(options: {
  source: string;
  stagingParent: string;
  passphrase: string;
  expected: RuntimeAdmissionExpectation;
  signal: AbortSignal;
  maximumBytes: number;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    !Number.isSafeInteger(options.maximumBytes) ||
    options.maximumBytes < 13 ||
    options.maximumBytes > runtimePayloadLimits.plaintextBytes
  )
    throw fail();
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
  const expected = decodeRuntimePayloadManifest(structuredClone(options.expected.manifest));
  if (expected.schema === 'orbis.time-machine-runtime.v1')
    throw new Error('Runtime admission requires a protected publication; legacy v1 handling is unchanged');
  if (!/^[a-f0-9]{64}$/.test(options.expected.manifestSha256)) throw fail();
  const publicationExpectation = structuredClone(options.expected.publication);
  let directory: string | undefined;
  let source: FileHandle | undefined;
  let plaintext: FileHandle | undefined;
  try {
    signal.throwIfAborted();
    const parent = path.resolve(options.stagingParent);
    const stat = await fs.lstat(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (await fs.realpath(parent)) !== parent
    )
      throw fail();
    directory = await fs.mkdtemp(path.join(parent, 'runtime-admission-'));
    await fs.chmod(directory, 0o700);
    // Freeze a bounded input copy so path replacement cannot change the file passed to decryptBackup.
    source = await fs.open(options.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await source.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      (process.getuid && before.uid !== process.getuid()) ||
      before.size < backupCipherOverhead ||
      before.size > options.maximumBytes + backupCipherOverhead
    )
      throw fail();
    // Reserve for the encrypted snapshot, authenticated plaintext, and extracted files.
    const space = await fs.statfs(directory, { bigint: true });
    if (space.bavail * space.bsize < BigInt(before.size) * 3n + 16n * 1024n * 1024n) throw fail();
    signal.throwIfAborted();
    const encryptedPath = path.join(directory, 'encrypted');
    const encrypted = await fs.open(encryptedPath, 'wx', 0o600);
    const buffer = Buffer.alloc(64 * 1024);
    try {
      let offset = 0;
      while (offset < before.size) {
        signal.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (!bytesRead) throw fail();
        let written = 0;
        while (written < bytesRead) {
          const result = await encrypted.write(buffer, written, bytesRead - written);
          if (!result.bytesWritten) throw fail();
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      const after = await source.stat();
      if (before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) throw fail();
    } finally {
      await encrypted.close();
    }
    await source.close();
    source = undefined;
    const plaintextPath = path.join(directory, 'authenticated');
    await decryptBackup({ source: encryptedPath, destination: plaintextPath, passphrase: options.passphrase, signal });
    await fs.rm(encryptedPath);
    plaintext = await fs.open(plaintextPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let position = 0;
    const read = async (length: number) => {
      const bytes = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        signal.throwIfAborted();
        if (!plaintext) throw fail();
        const result = await plaintext.read(bytes, offset, length - offset, position);
        if (!result.bytesRead) throw fail();
        offset += result.bytesRead;
        position += result.bytesRead;
      }
      return bytes;
    };
    const header = await read(12);
    const metadataLength = header.readUInt32BE(8);
    if (!header.subarray(0, 8).equals(Buffer.from('ORBISTM1')) || metadataLength < 1 || metadataLength > runtimePayloadLimits.metadataBytes)
      throw fail();
    const metadata = await read(metadataLength);
    if (sha(metadata) !== options.expected.manifestSha256) throw fail();
    const manifest = decodeRuntimePayloadManifest(json(metadata));
    if (manifest.schema === 'orbis.time-machine-runtime.v1' || canonicalRuntimeJson(manifest) !== canonicalRuntimeJson(expected)) throw fail();
    const total = runtimePayloadLength(metadataLength, manifest.entries, manifest.schema);
    if (total > options.maximumBytes || (await plaintext.stat()).size !== total) throw fail();
    const files = new Map<string, string>();
    const small = new Map<string, Buffer>();
    for (const [index, entry] of manifest.entries.entries()) {
      signal.throwIfAborted();
      // Stored names are flat internal identifiers, never paths supplied by the archive.
      const filename = path.join(directory, `entry-${index}`);
      const limit =
        manifest.schema === 'orbis.time-machine-runtime.v6' && entry.name === appRuntimeEntryName ? appRuntimeEntryLimit : 4 * 1024 * 1024;
      if (!entry.name.endsWith('.tar') && entry.bytes > limit) throw fail();
      const output = await fs.open(filename, 'wx', 0o600);
      const hash = createHash('sha256');
      const pieces: Buffer[] = [];
      const isMetadata = !entry.name.endsWith('.tar');
      try {
        let remaining = entry.bytes;
        while (remaining) {
          const chunk = await read(Math.min(remaining, 64 * 1024));
          hash.update(chunk);
          if (isMetadata) pieces.push(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const result = await output.write(chunk, offset, chunk.length - offset);
            if (!result.bytesWritten) throw fail();
            offset += result.bytesWritten;
          }
          remaining -= chunk.length;
        }
      } finally {
        await output.close();
      }
      if (hash.digest('hex') !== entry.sha256) throw fail();
      files.set(entry.name, filename);
      if (isMetadata) small.set(entry.name, Buffer.concat(pieces));
    }
    if (position !== total || (await plaintext.stat()).size !== total) throw fail();
    const proof = small.get('controller-publication/proof.json');
    const captureBytes = small.get('image-capture/capture.json');
    if (!proof || !captureBytes) throw fail();
    const publication = decodeRuntimePublicationEntry(manifest, proof, publicationExpectation);
    const configuration = decodeControllerConfigurationCapture(
      {
        ...manifest.configuration,
        files: manifest.configuration.files.map((file) =>
          file.present ? { ...file, data: small.get(`controller-config/${file.path}`)?.toString('base64') } : file,
        ),
      },
      { pointId: manifest.pointId, controllerId: manifest.controller.containerId, imageId: manifest.controller.sourceImageId },
    );
    if (canonicalRuntimeJson(configuration.metadata) !== canonicalRuntimeJson(publicationExpectation.configuration)) throw fail();
    const captureValue = json(captureBytes);
    if (!captureValue || typeof captureValue !== 'object' || Array.isArray(captureValue)) throw fail();
    const capture = captureValue as Record<string, unknown>;
    if (!Array.isArray(capture.containers)) throw fail();
    const controllers = capture.containers.filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === 'object' && !Array.isArray(item) && 'role' in item && item.role === 'controller',
    );
    if (controllers.length !== 1) throw fail();
    const inventory = validateRetainedImageInventory(capture.inventory);
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
    const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (
      !exact(capture, [
        'schema',
        'pointId',
        'createdAt',
        'backupManifestSha256',
        'platform',
        'apps',
        'containers',
        'inventorySha256',
        'inventory',
        'coverage',
      ]) ||
      typeof capture.createdAt !== 'number' ||
      !Number.isSafeInteger(capture.createdAt) ||
      capture.createdAt <= 0 ||
      capture.createdAt > 8.64e15 ||
      canonicalRuntimeJson(capture.platform) !== canonicalRuntimeJson(publicationExpectation.platform) ||
      !Array.isArray(capture.apps) ||
      capture.apps.length > 512 ||
      capture.containers.length > 1024 ||
      canonicalRuntimeJson(capture.coverage) !==
        canonicalRuntimeJson({
          appData: 'legacy-quiesced-container-copy',
          database: 'legacy-logical-dump',
          controller: 'not-quiesced',
          controllerConfiguration: 'not-captured',
          encryptedEnvelope: 'not-integrated',
          restoreReady: false,
        })
    )
      throw fail();
    const apps = capture.apps;
    const captureContainers = capture.containers;
    const appIds = new Set<string>();
    for (const app of apps) {
      if (
        !object(app) ||
        !exact(app, ['urn', 'project', 'userConfigEnabled', 'sourceSha256', 'configurationSha256', 'services']) ||
        typeof app.urn !== 'string' ||
        !(manifest.schema === 'orbis.time-machine-runtime.v6'
          ? /^[a-z0-9][a-z0-9_-]{0,127}:(?:[a-z0-9][a-z0-9_-]{0,127}|_user)$/.test(app.urn)
          : /^[a-z0-9][a-z0-9_-]{0,127}:[a-z0-9][a-z0-9_-]{0,127}$/.test(app.urn)) ||
        appIds.has(app.urn) ||
        app.project !== app.urn.replace(':', '_') ||
        typeof app.userConfigEnabled !== 'boolean' ||
        !hash(app.sourceSha256) ||
        !hash(app.configurationSha256) ||
        !Array.isArray(app.services) ||
        !app.services.length ||
        app.services.length > 256 ||
        app.services.some((service: unknown) => typeof service !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(service)) ||
        new Set(app.services).size !== app.services.length
      )
        throw fail();
      appIds.add(app.urn);
    }
    const ids = new Set<string>();
    const keys = new Set<string>();
    let databases = 0;
    for (const container of capture.containers) {
      if (
        !object(container) ||
        !exact(container, [
          ...(manifest.schema === 'orbis.time-machine-runtime.v6' ? ['ordinal'] : []),
          'id',
          'imageId',
          'reference',
          'project',
          'service',
          'oneOff',
          'running',
          'paused',
          'restarting',
          'role',
          'appUrn',
          'key',
          'wasRunning',
        ]) ||
        !hash(container.id) ||
        typeof container.imageId !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(container.imageId) ||
        typeof container.reference !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,2047}$/.test(container.reference) ||
        typeof container.project !== 'string' ||
        typeof container.service !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,254}$/.test(container.project) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container.service) ||
        container.oneOff !== false ||
        container.paused !== false ||
        container.restarting !== false ||
        typeof container.running !== 'boolean' ||
        typeof container.wasRunning !== 'boolean' ||
        !['controller', 'controller-service', 'database', 'app'].includes(String(container.role)) ||
        typeof container.key !== 'string' ||
        ids.has(container.id as string) ||
        keys.has(container.key)
      )
        throw fail();
      const app = apps.find((item: unknown) => object(item) && item.urn === container.appUrn);
      if (container.role === 'app') {
        if (
          !object(app) ||
          app.project !== container.project ||
          !Array.isArray(app.services) ||
          !app.services.includes(container.service) ||
          container.running ||
          container.key !==
            `apps/${container.appUrn}/${container.service}${manifest.schema === 'orbis.time-machine-runtime.v6' ? `/${container.ordinal}` : ''}` ||
          (manifest.schema === 'orbis.time-machine-runtime.v6' &&
            (!Number.isInteger(container.ordinal) || Number(container.ordinal) < 1 || Number(container.ordinal) > 1024))
        )
          throw fail();
      } else if (
        container.appUrn !== null ||
        (manifest.schema === 'orbis.time-machine-runtime.v6' && container.ordinal !== null) ||
        container.key !== `controller/${container.project}/${container.service}` ||
        ((container.role === 'controller' || container.role === 'database') && (!container.running || !container.wasRunning))
      )
        throw fail();
      if (container.role === 'database') {
        if (!/(?:^|\/)postgres(?:[:@]|$)/.test(container.reference)) throw fail();
        databases++;
      }
      if (!inventory.bindings.some((binding) => binding.key === container.key && binding.imageId === container.imageId)) throw fail();
      ids.add(container.id as string);
      keys.add(container.key);
    }
    if (
      databases !== 1 ||
      inventory.bindings.length !== keys.size ||
      apps.some(
        (app: unknown) =>
          object(app) &&
          Array.isArray(app.services) &&
          app.services.some(
            (service: unknown) =>
              !captureContainers.some((container: unknown) => object(container) && container.appUrn === app.urn && container.service === service),
          ),
      )
    )
      throw fail();
    const controller = controllers[0];
    if (
      capture.schema !==
        (manifest.schema === 'orbis.time-machine-runtime.v6' ? 'orbis.time-machine-image-capture.v2' : 'orbis.time-machine-image-capture.v1') ||
      capture.pointId !== manifest.pointId ||
      capture.backupManifestSha256 !== manifest.legacy.manifestSha256 ||
      capture.inventorySha256 !== manifest.imageInventorySha256 ||
      sha(canonicalRuntimeJson(inventory)) !== manifest.imageInventorySha256 ||
      controller?.id !== manifest.controller.containerId ||
      controller?.imageId !== manifest.controller.sourceImageId ||
      controller?.reference !== manifest.controller.publishedReference
    )
      throw fail();
    const image = inventory.images.find((item) => item.imageId === controller.imageId);
    if (
      !image ||
      image.identity.configId !== publication.metadata.configDigest ||
      (image.identity.kind === 'oci' &&
        (image.identity.manifestId !== publication.metadata.platformManifestDigest ||
          canonicalRuntimeJson(image.identity.platform) !== canonicalRuntimeJson(publicationExpectation.platform)))
    )
      throw fail();
    const archives = manifest.entries.filter((entry) => entry.name.endsWith('.tar'));
    if (
      archives.length !== inventory.images.length ||
      inventory.images.some(
        (image) =>
          !archives.some(
            (entry) => entry.name === `image-capture/images/${image.archive}` && entry.bytes === image.bytes && entry.sha256 === image.sha256,
          ),
      )
    )
      throw fail();
    let coherence: CaptureCoherenceReceipt | null = null;
    let controllerAuthority: ControllerCaptureAuthorityReceipt | null = null;
    let appRuntime: ReturnType<typeof decodeAppRuntimeCapture> | null = null;
    if (
      manifest.schema === 'orbis.time-machine-runtime.v3' ||
      manifest.schema === 'orbis.time-machine-runtime.v4' ||
      manifest.schema === 'orbis.time-machine-runtime.v6'
    ) {
      const receiptBytes = small.get(coherenceEntryName);
      const authorityBytes = small.get(controllerAuthorityEntryName);
      if (
        !receiptBytes ||
        !authorityBytes ||
        !image ||
        sha(receiptBytes) !== manifest.coherenceSha256 ||
        sha(authorityBytes) !== manifest.controllerAuthoritySha256
      )
        throw fail();
      controllerAuthority = decodeControllerCaptureAuthority(json(authorityBytes), publicationExpectation, publication, image);
      if (manifest.schema === 'orbis.time-machine-runtime.v3' && controllerAuthority.metadata.version !== 1) throw fail();
      if (manifest.schema === 'orbis.time-machine-runtime.v4' || manifest.schema === 'orbis.time-machine-runtime.v6') {
        const policyBytes = small.get(proxyHostIdentityEntryName);
        if (
          controllerAuthority.metadata.version !== (manifest.schema === 'orbis.time-machine-runtime.v6' ? 4 : 2) ||
          !policyBytes ||
          sha(policyBytes) !== manifest.proxyHostIdentitySha256
        )
          throw fail();
        const policy = decodeProxyHostIdentity(json(policyBytes), manifest.configuration.rootIdentity.pathSha256);
        const proxies = captureContainers.filter(
          (item) => item.project === 'runtipi' && item.service === 'runtipi-reverse-proxy' && item.role === 'controller-service',
        );
        if (
          canonicalRuntimeJson(policy) !== canonicalRuntimeJson(controllerAuthority.metadata.proxyHostIdentity) ||
          proxies.length !== 1 ||
          proxies[0]?.id !== policy.proxy.containerId ||
          proxies[0]?.imageId !== policy.proxy.imageId
        )
          throw fail();
      }
      if (manifest.schema === 'orbis.time-machine-runtime.v6') {
        const bytes = small.get(appRuntimeEntryName);
        if (
          !bytes ||
          controllerAuthority.metadata.version !== 4 ||
          sha(bytes) !== manifest.appRuntimeSha256 ||
          sha(bytes) !== controllerAuthority.metadata.appRuntimeSha256
        )
          throw fail();
        appRuntime = decodeAppRuntimeCapture(bytes, {
          pointId: manifest.pointId,
          rootSha256: manifest.configuration.rootIdentity.pathSha256,
          dockerContextSha256: controllerAuthority.metadata.proxyHostIdentity.dockerContextSha256,
          daemonSha256: controllerAuthority.metadata.appRuntimeDaemonSha256,
          configurationSetSha256: manifest.configurationSetSha256,
          preparationSha256: publication.metadata.preparationSha256,
          entrySha256: manifest.appRuntimeSha256,
        });
        const bindings = appRuntimeImageBindings(appRuntime);
        const represented = new Set(bindings.map((item) => item.project));
        const expectedApps = appRuntime.metadata.apps
          .filter((app) => represented.has(app.project))
          .map((app) => ({
            urn: app.urn,
            project: app.project,
            userConfigEnabled: app.userConfigEnabled,
            sourceSha256: app.sourceSha256,
            configurationSha256: app.configurationSha256,
            services: app.services.filter((service) => service.replicas > 0).map((service) => service.name),
          }));
        const actualApps = captureContainers.filter((item) => item.role === 'app');
        if (
          canonicalRuntimeJson(apps) !== canonicalRuntimeJson(expectedApps) ||
          actualApps.length !== bindings.length ||
          bindings.some(
            (binding) =>
              !actualApps.some(
                (item) =>
                  item.id === binding.containerId &&
                  item.imageId === binding.imageId &&
                  item.key === binding.key &&
                  item.project === binding.project &&
                  item.service === binding.service &&
                  item.ordinal === binding.ordinal &&
                  item.appUrn === binding.key.split('/')[1] &&
                  item.wasRunning === binding.wasRunning,
              ),
          ) ||
          appRuntime.metadata.containers.some((item) => {
            const actual = actualApps.find((entry) => entry.id === item.inspect.Id);
            const retained = inventory.images.find((entry) => entry.imageId === item.image.sourceImageId);
            const config = item.inspect.Config;
            return (
              !actual ||
              !retained ||
              !object(config) ||
              actual.reference !== config.Image ||
              (item.image.selection === 'docker29-platform-manifest.v1'
                ? retained.identity.kind !== 'oci' ||
                  retained.identity.manifestId !== item.image.creationReference ||
                  canonicalRuntimeJson(retained.identity.platform) !== canonicalRuntimeJson(item.image.platform)
                : retained.identity.kind !== 'docker' || retained.identity.configId !== item.image.creationReference)
            );
          })
        )
          throw fail();
      }
      coherence = verifyCaptureCoherenceReceipt(json(receiptBytes), {
        pointId: manifest.pointId,
        manifestSha256: manifest.legacy.manifestSha256,
        imageCaptureSha256: manifest.imageCaptureSha256,
        imageInventorySha256: manifest.imageInventorySha256,
        publicationProofSha256: manifest.publicationProofSha256,
        controllerAuthoritySha256: manifest.controllerAuthoritySha256,
        databaseId: captureContainers.find((item) => item.role === 'database')?.id,
      });
      if (
        coherence.hostFence.configurationSetSha256 !== manifest.configurationSetSha256 ||
        coherence.hostFence.preparationSha256 !== publication.metadata.preparationSha256 ||
        controllerAuthority.metadata.finalizedAt > coherence.hostFence.verifiedAt ||
        canonicalRuntimeJson(coherence.apps.map(({ id, project, wasRunning }) => ({ id, project, wasRunning }))) !==
          canonicalRuntimeJson(
            captureContainers
              .filter((item) => item.role === 'app')
              .map(({ id, project, wasRunning }) => ({ id, project, wasRunning }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          )
      )
        throw fail();
    }
    await verifyRetainedImageArchives({ inventory, files, signal });
    signal.throwIfAborted();
    await plaintext.close();
    plaintext = undefined;
    await fs.rm(plaintextPath);
    signal.throwIfAborted();
    const admittedDirectory = directory;
    return {
      manifest,
      capture: structuredClone(capture),
      coherence,
      controllerAuthority,
      appRuntime,
      files: new Map(files),
      restoreReady: false as const,
      dispose: () => fs.rm(admittedDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await plaintext?.close().catch(() => undefined);
    plaintext = undefined;
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await source?.close().catch(() => undefined);
    await plaintext?.close().catch(() => undefined);
  }
}
