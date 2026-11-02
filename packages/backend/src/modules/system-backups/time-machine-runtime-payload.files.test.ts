import { expect, it } from 'vitest';
import { backupGcmPlaintextLimit } from './backup-crypto';
import { controllerConfigPaths } from '../host-updates/host-controller-config';
import {
  runtimePayloadLength,
  runtimeImageBytesLimit,
  runtimeV6ImageBytesLimit,
  decodeRuntimePayloadManifest,
  runtimePayloadManifestSchema,
} from './time-machine-runtime-payload';

it('includes framing and metadata in the exact GCM per-invocation boundary without allocating large buffers', () => {
  expect(runtimePayloadLength(1, [{ bytes: backupGcmPlaintextLimit - 13 }])).toBe(backupGcmPlaintextLimit);
  expect(() => runtimePayloadLength(1, [{ bytes: backupGcmPlaintextLimit - 12 }])).toThrow();
  expect(runtimePayloadLength(1024 * 1024, [{ bytes: runtimeImageBytesLimit }, { bytes: 13 * 1024 * 1024 + 80 * 1024 }])).toBe(
    backupGcmPlaintextLimit,
  );
});
it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])('refuses an invalid declared entry size %s', (bytes) => {
  expect(() => runtimePayloadLength(1, [{ bytes }])).toThrow();
});
it('bounds metadata and the number of declared entries before consumption', () => {
  expect(() => runtimePayloadLength(1024 * 1024 + 1, [])).toThrow();
  expect(() =>
    runtimePayloadLength(
      1,
      Array.from({ length: 267 }, () => ({ bytes: 0 })),
    ),
  ).toThrow();
});

function manifest() {
  const pointId = '11111111-1111-4111-8111-111111111111';
  const hash = 'a'.repeat(64);
  const controller = {
    id: 'b'.repeat(64),
    imageId: `sha256:${'c'.repeat(64)}`,
    imageReference: `ghcr.io/twentylines/orbis@sha256:${'d'.repeat(64)}`,
    project: 'runtipi',
    service: 'runtipi',
    startedAt: '2026-10-31T00:00:00Z',
    releaseTag: 'v0.5.0-beta.3',
    releaseDigest: `sha256:${'d'.repeat(64)}`,
  };
  return {
    schema: 'orbis.time-machine-runtime.v2',
    pointId,
    legacy: { bytes: 52, cipherSha256: hash, manifestSha256: hash },
    imageCaptureSha256: hash,
    imageInventorySha256: hash,
    configurationSetSha256: hash,
    publicationProofSha256: hash,
    controller: {
      containerId: controller.id,
      sourceImageId: controller.imageId,
      publishedReference: controller.imageReference,
      publishedDigest: controller.releaseDigest,
    },
    configuration: {
      version: 1,
      pointId,
      configurationSetSha256: hash,
      controller,
      rootIdentity: { device: '1', inode: '1', uid: 0, gid: 0, mode: 0o700, pathSha256: hash },
      files: controllerConfigPaths.map((path) => ({ path, present: false })),
    },
    entries: [
      { name: 'controller-publication/proof.json', bytes: 1, sha256: hash },
      { name: 'image-capture/capture.json', bytes: 1, sha256: hash },
    ],
    controllerRuntimeCoherence: false,
    restoreReady: false,
  };
}
it('keeps legacy v1 keys and entry whitelist strict while accepting explicit bound v2', () => {
  const value = manifest();
  expect(decodeRuntimePayloadManifest(value).schema).toBe('orbis.time-machine-runtime.v2');
  expect(runtimePayloadManifestSchema.allows(value)).toBe(false);
  const { publicationProofSha256: _proof, ...legacy } = value;
  legacy.schema = 'orbis.time-machine-runtime.v1';
  expect(runtimePayloadManifestSchema.allows(legacy)).toBe(false);
  legacy.entries = legacy.entries.filter((entry) => entry.name !== 'controller-publication/proof.json');
  expect(decodeRuntimePayloadManifest(legacy).schema).toBe('orbis.time-machine-runtime.v1');
  expect(() => decodeRuntimePayloadManifest({ ...legacy, publicationProofSha256: 'a'.repeat(64) })).toThrow();
});
it.each(['missing', 'duplicate', 'hash', 'bytes', 'order', 'config', 'ready', 'path'] as const)('rejects v2 %s proof/frame mismatch', (kind) => {
  const value = manifest();
  const first = value.entries[0];
  if (!first) throw new Error('Missing proof fixture entry');
  if (kind === 'missing') value.entries.shift();
  if (kind === 'duplicate') value.entries.unshift({ ...first });
  if (kind === 'hash') value.publicationProofSha256 = 'e'.repeat(64);
  if (kind === 'bytes') first.bytes = 4 * 1024 * 1024 + 1;
  if (kind === 'order') value.entries.reverse();
  if (kind === 'config') value.configuration.configurationSetSha256 = 'e'.repeat(64);
  if (kind === 'ready') value.restoreReady = true;
  if (kind === 'path') first.name = '../proof.json';
  expect(() => decodeRuntimePayloadManifest(value)).toThrow();
});
it('reserves exactly all seven metadata components and the header at the GCM boundary', () => {
  expect(runtimeImageBytesLimit).toBe(backupGcmPlaintextLimit - 14 * 1024 * 1024 - 80 * 1024 - 12);
  expect(
    runtimePayloadLength(
      1,
      Array.from({ length: 263 }, () => ({ bytes: 0 })),
    ),
  ).toBe(13);
});

it('requires one bound v6 app-intent entry without relaxing older manifests', () => {
  const base = manifest();
  const digest = 'a'.repeat(64);
  const value = {
    ...base,
    schema: 'orbis.time-machine-runtime.v6',
    controllerRuntimeCoherence: true,
    coherenceSha256: digest,
    controllerAuthoritySha256: digest,
    proxyHostIdentitySha256: digest,
    appRuntimeSha256: digest,
    entries: [
      { name: 'app-runtime/create-intents.json', bytes: 1, sha256: digest },
      { name: 'coherence/receipt.json', bytes: 1, sha256: digest },
      { name: 'controller-authority/receipt.json', bytes: 1, sha256: digest },
      ...base.entries.slice(0, 1),
      { name: 'host-identity/proxy.json', bytes: 1, sha256: digest },
      ...base.entries.slice(1),
    ],
  };
  expect(decodeRuntimePayloadManifest(value).schema).toBe('orbis.time-machine-runtime.v6');
  expect(() => decodeRuntimePayloadManifest({ ...value, appRuntimeSha256: 'b'.repeat(64) })).toThrow();
  expect(() => decodeRuntimePayloadManifest({ ...value, entries: value.entries.slice(1) })).toThrow();
  expect(() => decodeRuntimePayloadManifest({ ...value, schema: 'orbis.time-machine-runtime.v4' })).toThrow();
});

it('reserves v6 descriptor capacity without expanding older limits', () => {
  const entries = Array.from({ length: 267 }, () => ({ bytes: 0 }));
  expect(() => runtimePayloadLength(1, entries)).toThrow();
  expect(() => runtimePayloadLength(1, entries, 'orbis.time-machine-runtime.v4')).toThrow();
  expect(runtimePayloadLength(1, entries, 'orbis.time-machine-runtime.v6')).toBe(13);
  expect(runtimeV6ImageBytesLimit).toBe(runtimeImageBytesLimit - 16 * 1024 * 1024);
});
