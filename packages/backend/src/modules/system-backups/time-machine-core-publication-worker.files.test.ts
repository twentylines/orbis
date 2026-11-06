import { expect, it } from 'vitest';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { corePublicationCapability, parseCorePublicationArguments } from './time-machine-core-publication-worker';
import { coreSentinelRecoveryCapability } from './time-machine-core-recovery-contract';

const hash = 'a'.repeat(64);
const expectation = {
  pointId: '12345678-1234-4234-8234-123456789abc',
  sourceSha256: hash,
  checkpointSha256: hash,
  captureReceiptSha256: hash,
  resourceCount: 2,
  images: { controller: `sha256:${hash}`, database: `sha256:${hash}`, queue: `sha256:${hash}` },
  compatibility: { os: 'linux', architecture: 'arm64', database: { engine: 'postgresql', major: 17 }, storageFormat: 'physical-pgdata.v1' },
  checkpoint: { bytes: 10240, sha256: hash },
};
it('exposes a fixed contract and accepts only a canonical protected expectation', () => {
  expect(parseCorePublicationArguments(['--capability'])).toEqual({ mode: 'capability' });
  expect(corePublicationCapability.dataRoot).toBe('/data');
  expect(parseCorePublicationArguments(['--sentinel-recovery-capability'])).toEqual({ mode: 'sentinel-recovery-capability' });
  expect(coreSentinelRecoveryCapability.publisher).toBe('sentinel.v1');
  const parsed = parseCorePublicationArguments(['--verify', canonicalPublicationJson(expectation)]);
  expect(parsed).toEqual({ mode: 'verify', expectation });
  if (parsed.mode === 'verify') expect(parsed.expectation).not.toBe(expectation);
});
it('does not admit caller paths, extra arguments, invalid identities or ambiguous JSON', () => {
  for (const args of [
    [],
    ['--capability', '/other'],
    ['--verify'],
    ['--verify', '{}', '/other'],
    ['--verify', JSON.stringify(expectation)],
    ['--verify', canonicalPublicationJson({ ...expectation, dataDir: '/other' })],
    ['--verify', canonicalPublicationJson({ ...expectation, pointId: '../../other' })],
    ['--verify', ' '.repeat(8193)],
  ])
    expect(() => parseCorePublicationArguments(args)).toThrow();
});
