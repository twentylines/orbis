import {
  controllerAuthorityEntryName,
  controllerAuthorityLimit,
  decodeControllerCaptureAuthority,
  type ControllerCaptureAuthorityReceipt,
} from '../host-updates/host-controller-capture-authority';
import {
  coherenceEntryName,
  coherenceReceiptLimit,
  verifyCaptureCoherenceReceipt,
  type CaptureCoherenceReceipt,
} from './time-machine-capture-coherence';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { type } from 'arktype';
import { timeMachineHashSchema, timeMachineIdSchema } from '@runtipi/common/schemas/time-machine';
import type { ControllerConfigurationCapture } from '../host-updates/host-controller-config';
import { controllerConfigPaths, controllerConfigurationMetadataSchema } from '../host-updates/host-controller-config';
import {
  controllerPublicationLimits,
  decodeControllerPublicationReceipt,
  parseControllerPublicationResponse,
  type ControllerPublicationExpectation,
  type ControllerPublicationReceipt,
} from '../host-updates/host-controller-publication';
import type { captureTimeMachineImages, VerifiedImageCaptureFile } from './backup-image-capture';
import { backupGcmPlaintextLimit } from './backup-crypto';
import { appRuntimeEntryName, appRuntimeImageBindings, type decodeAppRuntimeCapture } from './time-machine-app-runtime-capture';
import type { finalizeProtectedImageCaptureV2 } from './backup-image-capture-v2';
import { timeMachineConflict } from './time-machine-policy';
import { decodeProxyHostIdentity, proxyHostIdentityEntryName, proxyHostIdentityLimit } from '../host-updates/host-proxy-identity';

export const runtimePayloadLimits = { metadataBytes: 1024 * 1024, entries: 266, plaintextBytes: backupGcmPlaintextLimit } as const;
export const runtimeImageBytesLimit = backupGcmPlaintextLimit - 14 * 1024 * 1024 - 64 * 1024 - proxyHostIdentityLimit - 12;
export const runtimeV6ImageBytesLimit = runtimeImageBytesLimit - 16 * 1024 * 1024;
export const runtimePublicationEntryName = 'controller-publication/proof.json';
const magic = Buffer.from('ORBISTM1');
const image = type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value));
const entryName = type('string').narrow(
  (value) =>
    value === 'image-capture/capture.json' ||
    /^image-capture\/images\/image-[a-f0-9]{64}\.tar$/.test(value) ||
    controllerConfigPaths.some((name) => value === `controller-config/${name}`),
);
const entrySchema = type({ name: entryName, bytes: '0 <= number.integer <= 68719476704', sha256: timeMachineHashSchema }).onUndeclaredKey('reject');
export const runtimePayloadManifestSchema = type({
  schema: "'orbis.time-machine-runtime.v1'",
  pointId: timeMachineIdSchema,
  legacy: type({
    bytes: '52 <= number.integer <= 137438953472',
    cipherSha256: timeMachineHashSchema,
    manifestSha256: timeMachineHashSchema,
  }).onUndeclaredKey('reject'),
  imageCaptureSha256: timeMachineHashSchema,
  imageInventorySha256: timeMachineHashSchema,
  configurationSetSha256: timeMachineHashSchema,
  controller: type({
    containerId: timeMachineHashSchema,
    sourceImageId: image,
    publishedReference: 'string > 0 & string <= 2048',
    publishedDigest: image,
  }).onUndeclaredKey('reject'),
  configuration: controllerConfigurationMetadataSchema,
  entries: entrySchema.array().atMostLength(262),
  controllerRuntimeCoherence: 'false',
  restoreReady: 'false',
}).onUndeclaredKey('reject');
export type RuntimePayloadManifest = typeof runtimePayloadManifestSchema.infer;
const publicationEntrySchema = type({
  name: "'controller-publication/proof.json'",
  bytes: '1 <= number.integer <= 4194304',
  sha256: timeMachineHashSchema,
}).onUndeclaredKey('reject');
export const runtimePayloadV2ManifestSchema = runtimePayloadManifestSchema
  .omit('schema', 'entries')
  .merge({
    schema: "'orbis.time-machine-runtime.v2'",
    publicationProofSha256: timeMachineHashSchema,
    entries: entrySchema.or(publicationEntrySchema).array().atMostLength(263),
  })
  .onUndeclaredKey('reject');
const authorityEntrySchema = type({
  name: "'controller-authority/receipt.json'",
  bytes: '1 <= number.integer <= 65536',
  sha256: timeMachineHashSchema,
}).onUndeclaredKey('reject');
const coherenceEntrySchema = type({
  name: "'coherence/receipt.json'",
  bytes: '1 <= number.integer <= 1048576',
  sha256: timeMachineHashSchema,
}).onUndeclaredKey('reject');
export const runtimePayloadV3ManifestSchema = runtimePayloadV2ManifestSchema
  .omit('schema', 'entries', 'controllerRuntimeCoherence')
  .merge({
    schema: "'orbis.time-machine-runtime.v3'",
    coherenceSha256: timeMachineHashSchema,
    controllerAuthoritySha256: timeMachineHashSchema,
    controllerRuntimeCoherence: 'true',
    entries: entrySchema.or(publicationEntrySchema).or(coherenceEntrySchema).or(authorityEntrySchema).array().atMostLength(265),
  })
  .onUndeclaredKey('reject');
const proxyEntrySchema = type({
  name: "'host-identity/proxy.json'",
  bytes: '1 <= number.integer <= 16384',
  sha256: timeMachineHashSchema,
}).onUndeclaredKey('reject');
export const runtimePayloadV4ManifestSchema = runtimePayloadV3ManifestSchema
  .omit('schema', 'entries')
  .merge({
    schema: "'orbis.time-machine-runtime.v4'",
    proxyHostIdentitySha256: timeMachineHashSchema,
    entries: entrySchema.or(publicationEntrySchema).or(coherenceEntrySchema).or(authorityEntrySchema).or(proxyEntrySchema).array().atMostLength(266),
  })
  .onUndeclaredKey('reject');
const appRuntimeEntrySchema = type({
  name: "'app-runtime/create-intents.json'",
  bytes: '1 <= number.integer <= 16777216',
  sha256: timeMachineHashSchema,
}).onUndeclaredKey('reject');
export const runtimePayloadV6ManifestSchema = runtimePayloadV4ManifestSchema
  .omit('schema', 'entries')
  .merge({
    schema: "'orbis.time-machine-runtime.v6'",
    appRuntimeSha256: timeMachineHashSchema,
    entries: entrySchema
      .or(publicationEntrySchema)
      .or(coherenceEntrySchema)
      .or(authorityEntrySchema)
      .or(proxyEntrySchema)
      .or(appRuntimeEntrySchema)
      .array()
      .atMostLength(267),
  })
  .onUndeclaredKey('reject');
export type CapturedRuntimeInput = {
  images: Awaited<ReturnType<typeof captureTimeMachineImages>> | Awaited<ReturnType<typeof finalizeProtectedImageCaptureV2>>;
  appRuntime?: ReturnType<typeof decodeAppRuntimeCapture>;
  configuration: ControllerConfigurationCapture;
  publication: ControllerPublicationReceipt;
  publicationExpectation: ControllerPublicationExpectation;
  coherence?: CaptureCoherenceReceipt;
  controllerAuthority?: ControllerCaptureAuthorityReceipt;
};
export const canonicalRuntimeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export function decodeRuntimePayloadManifest(raw: unknown) {
  const value = runtimePayloadManifestSchema
    .or(runtimePayloadV2ManifestSchema)
    .or(runtimePayloadV3ManifestSchema)
    .or(runtimePayloadV4ManifestSchema)
    .or(runtimePayloadV6ManifestSchema)(raw);
  if (value instanceof type.errors) throw timeMachineConflict('point-integrity-failed');
  if (value.schema !== 'orbis.time-machine-runtime.v1') {
    const proof = value.entries.filter((entry) => entry.name === runtimePublicationEntryName);
    if (
      proof.length !== 1 ||
      proof[0]?.sha256 !== value.publicationProofSha256 ||
      value.entries.some((entry, index) => index > 0 && entry.name <= (value.entries[index - 1]?.name ?? '')) ||
      value.pointId !== value.configuration.pointId ||
      value.configurationSetSha256 !== value.configuration.configurationSetSha256 ||
      value.controller.containerId !== value.configuration.controller.id ||
      value.controller.sourceImageId !== value.configuration.controller.imageId ||
      value.controller.publishedReference !== value.configuration.controller.imageReference ||
      value.controller.publishedDigest !== value.configuration.controller.releaseDigest
    )
      throw timeMachineConflict('point-integrity-failed');
    if (
      value.schema === 'orbis.time-machine-runtime.v3' ||
      value.schema === 'orbis.time-machine-runtime.v4' ||
      value.schema === 'orbis.time-machine-runtime.v6'
    ) {
      const receipts = value.entries.filter((entry) => entry.name === coherenceEntryName);
      const authorities = value.entries.filter((entry) => entry.name === controllerAuthorityEntryName);
      if (
        receipts.length !== 1 ||
        receipts[0]?.sha256 !== value.coherenceSha256 ||
        authorities.length !== 1 ||
        authorities[0]?.sha256 !== value.controllerAuthoritySha256
      )
        throw timeMachineConflict('point-integrity-failed');
      if (value.schema === 'orbis.time-machine-runtime.v4' || value.schema === 'orbis.time-machine-runtime.v6') {
        const policies = value.entries.filter((entry) => entry.name === proxyHostIdentityEntryName);
        if (policies.length !== 1 || policies[0]?.sha256 !== value.proxyHostIdentitySha256) throw timeMachineConflict('point-integrity-failed');
      }
      if (value.schema === 'orbis.time-machine-runtime.v6') {
        const appRuntime = value.entries.filter((entry) => entry.name === appRuntimeEntryName);
        if (appRuntime.length !== 1 || appRuntime[0]?.sha256 !== value.appRuntimeSha256) throw timeMachineConflict('point-integrity-failed');
      }
    }
    const capture = value.entries.filter((entry) => entry.name === 'image-capture/capture.json');
    if (
      capture.length !== 1 ||
      !capture[0] ||
      capture[0].bytes < 1 ||
      capture[0].bytes > 4 * 1024 * 1024 ||
      capture[0].sha256 !== value.imageCaptureSha256
    )
      throw timeMachineConflict('point-integrity-failed');
    for (const file of value.configuration.files) {
      const entries = value.entries.filter((entry) => entry.name === `controller-config/${file.path}`);
      if (file.present ? entries.length !== 1 || entries[0]?.bytes !== file.bytes || entries[0]?.sha256 !== file.sha256 : entries.length !== 0)
        throw timeMachineConflict('point-integrity-failed');
    }
  }
  return value;
}

export function decodeRuntimePublicationEntry(rawManifest: unknown, bytes: Buffer, expected: ControllerPublicationExpectation) {
  const manifest = decodeRuntimePayloadManifest(rawManifest);
  if (manifest.schema === 'orbis.time-machine-runtime.v1') throw timeMachineConflict('point-integrity-failed');
  const entry = manifest.entries.find((entry) => entry.name === runtimePublicationEntryName);
  if (!entry || bytes.length > controllerPublicationLimits.receiptBytes || bytes.length !== entry.bytes || sha(bytes) !== entry.sha256)
    throw timeMachineConflict('point-integrity-failed');
  const result = decodeControllerPublicationReceipt(parseControllerPublicationResponse(bytes), expected);
  if (
    result.metadata.pointId !== manifest.pointId ||
    result.metadata.configurationSetSha256 !== manifest.configurationSetSha256 ||
    canonicalRuntimeJson(result.metadata.controller) !== canonicalRuntimeJson(manifest.configuration.controller) ||
    canonicalRuntimeJson(result.metadata.rootIdentity) !== canonicalRuntimeJson(manifest.configuration.rootIdentity)
  )
    throw timeMachineConflict('point-integrity-failed');
  return result;
}

export function runtimePayloadLength(metadataBytes: number, entries: readonly { bytes: number }[], schema?: string) {
  let total = 12 + metadataBytes;
  if (
    !Number.isSafeInteger(metadataBytes) ||
    metadataBytes < 1 ||
    metadataBytes > runtimePayloadLimits.metadataBytes ||
    entries.length > runtimePayloadLimits.entries + (schema === 'orbis.time-machine-runtime.v6' ? 1 : 0)
  )
    throw timeMachineConflict('capacity-exceeded');
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw timeMachineConflict('capacity-exceeded');
    total += entry.bytes;
    if (!Number.isSafeInteger(total) || total > runtimePayloadLimits.plaintextBytes) throw timeMachineConflict('capacity-exceeded');
  }
  return total;
}

export function verifyCapturedControllerPublication(input: CapturedRuntimeInput) {
  const capture = input.images.capture;
  const config = input.configuration.metadata;
  const publication = decodeControllerPublicationReceipt(parseControllerPublicationResponse(input.publication.read()), {
    ...input.publicationExpectation,
    configuration: config,
  });
  const controller = capture.containers.find((container) => container.role === 'controller');
  if (
    !controller ||
    config.pointId !== capture.pointId ||
    config.controller.id !== controller.id ||
    config.controller.imageId !== controller.imageId ||
    config.controller.imageReference !== controller.reference
  )
    throw timeMachineConflict('point-integrity-failed');
  const controllerImage = capture.inventory.images.find((image) => image.imageId === controller.imageId);
  if (
    !controllerImage ||
    controllerImage.identity.configId !== publication.metadata.configDigest ||
    (controllerImage.identity.kind === 'oci' &&
      (controllerImage.identity.manifestId !== publication.metadata.platformManifestDigest ||
        canonicalRuntimeJson(controllerImage.identity.platform) !== canonicalRuntimeJson(input.publicationExpectation.platform)))
  )
    throw timeMachineConflict('point-integrity-failed');
  return publication;
}

export function runtimePayload(input: CapturedRuntimeInput, legacy: RuntimePayloadManifest['legacy'], signal: AbortSignal) {
  if ((input.coherence === undefined) !== (input.controllerAuthority === undefined)) throw timeMachineConflict('point-integrity-failed');
  const capture = input.images.capture;
  const config = input.configuration.metadata;
  if ((capture.schema === 'orbis.time-machine-image-capture.v2') !== (input.appRuntime !== undefined))
    throw timeMachineConflict('point-integrity-failed');
  if (input.appRuntime && (!input.coherence || !input.controllerAuthority)) throw timeMachineConflict('point-integrity-failed');
  const publication = verifyCapturedControllerPublication(input);
  const controller = capture.containers.find((container) => container.role === 'controller');
  if (!controller || capture.backupManifestSha256 !== legacy.manifestSha256) throw timeMachineConflict('point-integrity-failed');
  const captureFile = input.images.files.find((file) => file.name === 'capture.json');
  if (
    !captureFile ||
    captureFile.sha256 !== input.images.sha256 ||
    input.images.files.length !== capture.inventory.images.length + 1 ||
    capture.inventory.images.some(
      (image) =>
        !input.images.files.some((file) => file.name === `images/${image.archive}` && file.bytes === image.bytes && file.sha256 === image.sha256),
    )
  )
    throw timeMachineConflict('point-integrity-failed');
  const entries: VerifiedImageCaptureFile[] = input.images.files.map((file) => ({ ...file, name: `image-capture/${file.name}` }));
  const proofBytes = publication.read();
  const publicationProofSha256 = sha(proofBytes);
  entries.push({
    name: runtimePublicationEntryName,
    bytes: proofBytes.length,
    sha256: publicationProofSha256,
    open: async () => Readable.from([proofBytes]),
  });
  for (const file of config.files) {
    if (!file.present) continue;
    const bytes = input.configuration.read(file.path);
    if (!bytes || bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw timeMachineConflict('point-integrity-failed');
    entries.push({ name: `controller-config/${file.path}`, bytes: bytes.length, sha256: file.sha256, open: async () => Readable.from([bytes]) });
  }
  let coherenceSha256: string | undefined;
  let controllerAuthoritySha256: string | undefined;
  let proxyHostIdentitySha256: string | undefined;
  let appRuntimeSha256: string | undefined;
  if (input.coherence) {
    const controllerImage = capture.inventory.images.find((image) => image.imageId === controller.imageId);
    if (!controllerImage || !input.controllerAuthority) throw timeMachineConflict('point-integrity-failed');
    const authority = decodeControllerCaptureAuthority(
      JSON.parse(input.controllerAuthority.read().toString()),
      input.publicationExpectation,
      publication,
      controllerImage,
    );
    if ((capture.schema === 'orbis.time-machine-image-capture.v2') !== (authority.metadata.version === 4))
      throw timeMachineConflict('point-integrity-failed');
    const authorityBytes = authority.read();
    if (authorityBytes.length > controllerAuthorityLimit) throw timeMachineConflict('capacity-exceeded');
    controllerAuthoritySha256 = sha(authorityBytes);
    if (authority.metadata.version === 2 || authority.metadata.version === 4) {
      const policy = decodeProxyHostIdentity(authority.metadata.proxyHostIdentity, config.rootIdentity.pathSha256);
      const proxies = capture.containers.filter(
        (item) => item.project === 'runtipi' && item.service === 'runtipi-reverse-proxy' && item.role === 'controller-service',
      );
      if (proxies.length !== 1 || proxies[0]?.id !== policy.proxy.containerId || proxies[0]?.imageId !== policy.proxy.imageId)
        throw timeMachineConflict('point-integrity-failed');
      const bytes = Buffer.from(canonicalRuntimeJson(policy));
      proxyHostIdentitySha256 = sha(bytes);
      entries.push({
        name: proxyHostIdentityEntryName,
        bytes: bytes.length,
        sha256: proxyHostIdentitySha256,
        open: async () => Readable.from([bytes]),
      });
    }
    if (authority.metadata.version === 4) {
      if (!input.appRuntime || capture.schema !== 'orbis.time-machine-image-capture.v2') throw timeMachineConflict('point-integrity-failed');
      const runtime = input.appRuntime;
      const runtimeBytes = runtime.read();
      const bindings = appRuntimeImageBindings(runtime);
      const actualApps = capture.containers.filter((item) => item.role === 'app');
      const appBindings = capture.inventory.bindings.filter((item) => item.key.startsWith('apps/'));
      const represented = new Set(bindings.map((item) => item.project));
      const expectedApps = runtime.metadata.apps
        .filter((app) => represented.has(app.project))
        .map((app) => ({
          urn: app.urn,
          project: app.project,
          userConfigEnabled: app.userConfigEnabled,
          sourceSha256: app.sourceSha256,
          configurationSha256: app.configurationSha256,
          services: app.services.filter((service) => service.replicas > 0).map((service) => service.name),
        }));
      if (
        runtime.metadata.pointId !== config.pointId ||
        runtime.metadata.rootSha256 !== config.rootIdentity.pathSha256 ||
        runtime.metadata.dockerContextSha256 !== authority.metadata.proxyHostIdentity.dockerContextSha256 ||
        runtime.metadata.daemonSha256 !== authority.metadata.appRuntimeDaemonSha256 ||
        runtime.metadata.configurationSetSha256 !== config.configurationSetSha256 ||
        runtime.metadata.preparationSha256 !== publication.metadata.preparationSha256 ||
        sha(runtimeBytes) !== authority.metadata.appRuntimeSha256 ||
        actualApps.length !== bindings.length ||
        appBindings.length !== bindings.length ||
        canonicalRuntimeJson(capture.apps) !== canonicalRuntimeJson(expectedApps) ||
        bindings.some(
          (binding) =>
            !actualApps.some(
              (item) =>
                item.id === binding.containerId &&
                item.key === binding.key &&
                item.imageId === binding.imageId &&
                item.project === binding.project &&
                item.service === binding.service &&
                item.ordinal === binding.ordinal &&
                item.wasRunning === binding.wasRunning &&
                item.appUrn === binding.key.split('/')[1] &&
                item.running === false &&
                item.paused === false &&
                item.restarting === false &&
                item.oneOff === false,
            ),
        ) ||
        bindings.some((binding) => !appBindings.some((item) => item.key === binding.key && item.imageId === binding.imageId)) ||
        runtime.metadata.containers.some((item) => {
          const actual = actualApps.find((entry) => entry.id === item.inspect.Id);
          const image = capture.inventory.images.find((entry) => entry.imageId === item.image.sourceImageId);
          const config = item.inspect.Config;
          return (
            !actual ||
            !image ||
            !config ||
            typeof config !== 'object' ||
            Array.isArray(config) ||
            typeof Reflect.get(config, 'Image') !== 'string' ||
            actual.reference !== Reflect.get(config, 'Image') ||
            (item.image.selection === 'docker29-platform-manifest.v1'
              ? image.identity.kind !== 'oci' ||
                image.identity.manifestId !== item.image.creationReference ||
                canonicalRuntimeJson(image.identity.platform) !== canonicalRuntimeJson(item.image.platform)
              : image.identity.kind !== 'docker' || image.identity.configId !== item.image.creationReference)
          );
        })
      )
        throw timeMachineConflict('point-integrity-failed');
      appRuntimeSha256 = sha(runtimeBytes);
      entries.push({
        name: appRuntimeEntryName,
        bytes: runtimeBytes.length,
        sha256: appRuntimeSha256,
        open: async () => Readable.from([runtimeBytes]),
      });
    }
    entries.push({
      name: controllerAuthorityEntryName,
      bytes: authorityBytes.length,
      sha256: controllerAuthoritySha256,
      open: async () => Readable.from([authorityBytes]),
    });
    const coherence = verifyCaptureCoherenceReceipt(input.coherence, {
      pointId: config.pointId,
      manifestSha256: legacy.manifestSha256,
      imageCaptureSha256: input.images.sha256,
      imageInventorySha256: capture.inventorySha256,
      publicationProofSha256,
      controllerAuthoritySha256,
      databaseId: capture.containers.find((item) => item.role === 'database')?.id,
    });
    if (
      coherence.hostFence.configurationSetSha256 !== config.configurationSetSha256 ||
      coherence.hostFence.preparationSha256 !== publication.metadata.preparationSha256 ||
      authority.metadata.finalizedAt > coherence.hostFence.verifiedAt ||
      canonicalRuntimeJson(coherence.apps.map(({ id, project, wasRunning }) => ({ id, project, wasRunning }))) !==
        canonicalRuntimeJson(
          capture.containers
            .filter((item) => item.role === 'app')
            .map(({ id, project, wasRunning }) => ({ id, project, wasRunning }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        )
    )
      throw timeMachineConflict('point-integrity-failed');
    const bytes = Buffer.from(canonicalRuntimeJson(coherence));
    if (bytes.length > coherenceReceiptLimit) throw timeMachineConflict('capacity-exceeded');
    coherenceSha256 = sha(bytes);
    entries.push({ name: coherenceEntryName, bytes: bytes.length, sha256: coherenceSha256, open: async () => Readable.from([bytes]) });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) throw timeMachineConflict('point-integrity-failed');
  const descriptor = {
    pointId: config.pointId,
    legacy,
    imageCaptureSha256: input.images.sha256,
    imageInventorySha256: capture.inventorySha256,
    configurationSetSha256: config.configurationSetSha256,
    publicationProofSha256,
    controller: {
      containerId: controller.id,
      sourceImageId: controller.imageId,
      publishedReference: config.controller.imageReference,
      publishedDigest: config.controller.releaseDigest,
    },
    configuration: config,
    entries: entries.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    restoreReady: false as const,
  };
  const manifest = coherenceSha256
    ? proxyHostIdentitySha256
      ? appRuntimeSha256
        ? runtimePayloadV6ManifestSchema.assert({
            ...descriptor,
            schema: 'orbis.time-machine-runtime.v6',
            coherenceSha256,
            controllerAuthoritySha256,
            proxyHostIdentitySha256,
            appRuntimeSha256,
            controllerRuntimeCoherence: true,
          })
        : runtimePayloadV4ManifestSchema.assert({
            ...descriptor,
            schema: 'orbis.time-machine-runtime.v4',
            coherenceSha256,
            controllerAuthoritySha256,
            proxyHostIdentitySha256,
            controllerRuntimeCoherence: true,
          })
      : runtimePayloadV3ManifestSchema.assert({
          ...descriptor,
          schema: 'orbis.time-machine-runtime.v3',
          coherenceSha256,
          controllerAuthoritySha256,
          controllerRuntimeCoherence: true,
        })
    : runtimePayloadV2ManifestSchema.assert({ ...descriptor, schema: 'orbis.time-machine-runtime.v2', controllerRuntimeCoherence: false });
  const metadata = Buffer.from(canonicalRuntimeJson(manifest));
  const bytes = runtimePayloadLength(metadata.length, entries, manifest.schema);
  const header = Buffer.alloc(12);
  magic.copy(header);
  header.writeUInt32BE(metadata.length, 8);
  const stream = Readable.from(
    (async function* () {
      let total = header.length + metadata.length;
      signal.throwIfAborted();
      yield header;
      yield metadata;
      for (const entry of entries) {
        signal.throwIfAborted();
        const source = await entry.open(signal);
        let received = 0;
        const hash = createHash('sha256');
        try {
          for await (const raw of source) {
            signal.throwIfAborted();
            const chunk = Buffer.from(raw);
            received += chunk.length;
            total += chunk.length;
            if (received > entry.bytes || total > bytes || total > backupGcmPlaintextLimit) throw timeMachineConflict('point-integrity-failed');
            hash.update(chunk);
            yield chunk;
          }
          if (received !== entry.bytes || hash.digest('hex') !== entry.sha256) throw timeMachineConflict('point-integrity-failed');
        } finally {
          source.destroy();
        }
      }
      if (total !== bytes) throw timeMachineConflict('point-integrity-failed');
    })(),
  );
  return {
    stream,
    bytes,
    manifest,
    manifestSha256: sha(metadata),
    imageCount: capture.inventory.images.length,
    bindingCount: capture.inventory.bindings.length,
  };
}
