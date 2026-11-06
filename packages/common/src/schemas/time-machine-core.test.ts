import { expect, test } from 'bun:test';
import {
  timeMachineCoreMetadataSchema,
  timeMachineCoreSummarySchema,
  timeMachineLegacyMetadataSchema,
  timeMachineLimits,
  timeMachineMetadataSchema,
} from './time-machine.js';

const hash = (character: string) => character.repeat(64);
const core = {
  version: 1,
  format: 'orbis.time-machine-core.v1',
  cipherBytes: 52,
  cipherSha256: hash('a'),
  manifestSha256: hash('b'),
  sourceSha256: hash('c'),
  checkpointSha256: hash('d'),
  captureReceiptSha256: hash('e'),
  imageInventorySha256: hash('f'),
  imageCount: 1,
  resourceCount: 1,
};
const metadata = {
  version: 3,
  kind: 'orbis-core',
  coreFormat: 'orbis.time-machine-core.v1',
  id: '12345678-1234-4123-8123-123456789abc',
  createdAt: 1,
  label: 'Core',
  source: 'manual',
  archiveBytes: core.cipherBytes,
  archiveSha256: core.cipherSha256,
  manifestSha256: core.manifestSha256,
  software: { orbis: '1', runtipi: '1', architecture: 'amd64' },
  coverage: {
    database: true,
    configuration: true,
    appearance: true,
    controllerConfiguration: true,
    controllerVersion: true,
    dockerImages: true,
    appData: false,
    cluster: 'local-only',
  },
  excludedApps: [],
  restore: { ready: false, blockers: [] },
  restorePolicy: { managedApps: 'preserve-current', proxy: 'preserve-current', recoveryAuthority: 'preserve-current', queue: 'current-drained' },
  compatibility: { os: 'linux', architecture: 'amd64', database: { engine: 'postgresql', major: 16 }, storageFormat: 'physical-pgdata.v1' },
  preview: { available: false, reason: { code: 'preview-not-captured', message: '' } },
  breakdown: [],
  core,
};

test('core metadata binds summary identities and preserves current app runtime', () => {
  expect(timeMachineCoreMetadataSchema.allows(metadata)).toBe(true);
  for (const source of ['manual', 'scheduled', 'pre-update', 'pre-restart'])
    expect(timeMachineCoreMetadataSchema.allows({ ...metadata, source })).toBe(true);
  for (const value of [
    { ...metadata, archiveBytes: 53 },
    { ...metadata, archiveSha256: hash('b') },
    { ...metadata, manifestSha256: hash('a') },
    { ...metadata, excludedApps: ['app:store'] },
    { ...metadata, coverage: { ...metadata.coverage, appData: true } },
    { ...metadata, restorePolicy: { ...metadata.restorePolicy, managedApps: 'restore' } },
    { ...metadata, restore: { ready: true, blockers: [] } },
  ])
    expect(timeMachineCoreMetadataSchema.allows(value)).toBe(false);
});

test('core schemas reject private or undeclared fields at every level', () => {
  for (const value of [
    { ...metadata, hostPath: '/private' },
    { ...metadata, core: { ...core, receipt: {} } },
    { ...metadata, coverage: { ...metadata.coverage, extra: true } },
    { ...metadata, restorePolicy: { ...metadata.restorePolicy, extra: true } },
    { ...metadata, compatibility: { ...metadata.compatibility, extra: true } },
    { ...metadata, compatibility: { ...metadata.compatibility, database: { ...metadata.compatibility.database, extra: true } } },
    { ...metadata, software: { ...metadata.software, extra: true } },
  ])
    expect(timeMachineCoreMetadataSchema.allows(value)).toBe(false);
});

test('core summary and compatibility enforce bounds and formats', () => {
  expect(timeMachineCoreSummarySchema.allows({ ...core, cipherBytes: timeMachineLimits.bytes, imageCount: 3, resourceCount: 4096 })).toBe(true);
  for (const changes of [
    { cipherBytes: 51 },
    { cipherBytes: timeMachineLimits.bytes + 1 },
    { imageCount: 0 },
    { imageCount: 4 },
    { resourceCount: 0 },
    { resourceCount: 4097 },
    { sourceSha256: 'x'.repeat(64) },
    { format: 'other' },
  ])
    expect(timeMachineCoreSummarySchema.allows({ ...core, ...changes })).toBe(false);
  for (const major of [0, 100, 1.5])
    expect(
      timeMachineCoreMetadataSchema.allows({ ...metadata, compatibility: { ...metadata.compatibility, database: { engine: 'postgresql', major } } }),
    ).toBe(false);
});

test('the metadata union accepts core without changing legacy coverage', () => {
  const { kind: _kind, coreFormat: _format, core: _core, restorePolicy: _policy, compatibility: _compatibility, ...common } = metadata;
  const legacy = {
    ...common,
    version: 1,
    coverage: {
      database: true,
      configuration: true,
      appData: true,
      dockerImages: false,
      controllerVersion: false,
      appearance: true,
      cluster: 'local-only',
    },
    excludedApps: ['app:store'],
  };
  expect(timeMachineLegacyMetadataSchema.allows(legacy)).toBe(true);
  expect(timeMachineMetadataSchema.allows(legacy)).toBe(true);
  expect(timeMachineMetadataSchema.allows(metadata)).toBe(true);
  expect(timeMachineLegacyMetadataSchema.allows({ ...legacy, coverage: { ...legacy.coverage, appData: false } })).toBe(false);
});
