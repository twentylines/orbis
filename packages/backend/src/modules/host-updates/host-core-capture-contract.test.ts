import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalPublicationJson } from './host-controller-publication';
import { coreCaptureLimits, decodeCoreCaptureStatus, validateCoreCaptureBinding } from './host-core-capture-contract';

const h = 'a'.repeat(64);
const binding = { id: '12345678-1234-4234-8234-123456789abc', sourceSha256: h, sourceHoldSha256: 'b'.repeat(64) };
const base = { version: 1, ...binding };
const makeReady = () => {
  const artifact = {
    schema: 'orbis.time-machine-core-checkpoint-artifact.v1',
    pointId: binding.id,
    sourceSha256: h,
    checkpointSha256: h,
    captureJobSha256: h,
    portableStorageSha256: h,
    manifestSha256: h,
    resourceCount: 1,
    roleImageIds: { controller: `sha256:${h}`, database: `sha256:${h}`, queue: `sha256:${h}` },
    compatibility: { os: 'linux', architecture: 'amd64', database: { engine: 'postgresql', major: 16 }, storageFormat: 'physical-pgdata.v1' },
    checkpoint: { bytes: 1, sha256: h },
  };
  const checkpointArtifactSha256 = createHash('sha256').update(canonicalPublicationJson(artifact)).digest('hex');
  return { ...base, state: 'resumed-awaiting-publication', ready: { captureReceiptSha256: 'c'.repeat(64), checkpointArtifactSha256, artifact } };
};
const rehash = (value: ReturnType<typeof makeReady>) => {
  value.ready.checkpointArtifactSha256 = createHash('sha256').update(canonicalPublicationJson(value.ready.artifact)).digest('hex');
  return value;
};
describe('core capture status contract', () => {
  it('accepts each non-ready state and validates binding', () => {
    for (const state of ['reserved', 'launch-unsettled', 'recovery-required', 'unsupported'])
      expect(decodeCoreCaptureStatus({ ...base, state }, binding)).toEqual({ ...base, state });
    expect(() => validateCoreCaptureBinding({ ...binding, id: binding.id.toUpperCase() })).toThrow();
    expect(() => validateCoreCaptureBinding({ ...binding, extra: true })).toThrow();
    expect(() => decodeCoreCaptureStatus({ ...base, state: 'reserved' }, { ...binding, sourceHoldSha256: h })).toThrow();
    expect(() => decodeCoreCaptureStatus({ ...base, state: 'reserved', ready: {} }, binding)).toThrow();
  });
  it('returns detached deeply frozen data and checks the artifact digest', () => {
    const raw = makeReady();
    const result = decodeCoreCaptureStatus(raw, binding);
    expect(result).toEqual(raw);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.state !== 'resumed-awaiting-publication') throw new Error('unexpected state');
    expect(Object.isFrozen(result.ready.artifact.compatibility.database)).toBe(true);
    raw.ready.artifact.compatibility.database.major = 17;
    expect(result.ready.artifact.compatibility.database.major).toBe(16);
    expect(() => decodeCoreCaptureStatus(raw, binding)).toThrow();
  });
  it('rejects unknown nested fields, invalid types, changed identity and bounds even with a matching digest', () => {
    const variants: Array<(value: ReturnType<typeof makeReady>) => void> = [
      (v) => {
        Object.assign(v.ready.artifact.checkpoint, { extra: 1 });
      },
      (v) => {
        v.ready.artifact.pointId = '12345678-1234-4234-9234-123456789abc';
      },
      (v) => {
        v.ready.artifact.roleImageIds.queue = h;
      },
      (v) => {
        v.ready.artifact.compatibility.database.major = 100;
      },
      (v) => {
        v.ready.artifact.resourceCount = 4097;
      },
      (v) => {
        v.ready.artifact.resourceCount = 0;
      },
      (v) => {
        v.ready.artifact.checkpoint.bytes = coreCaptureLimits.checkpointBytes + 1;
      },
      (v) => {
        v.ready.artifact.checkpoint.bytes = 0;
      },
      (v) => {
        v.ready.artifact.checkpoint.bytes = 1.5;
      },
    ];
    for (const mutate of variants) {
      const raw = makeReady();
      mutate(raw);
      expect(() => decodeCoreCaptureStatus(rehash(raw), binding)).toThrow();
    }
    expect(() => decodeCoreCaptureStatus([], binding)).toThrow();
    expect(() => decodeCoreCaptureStatus({ ...base, state: 'unknown' }, binding)).toThrow();
    const edge = makeReady();
    edge.ready.artifact.checkpoint.bytes = coreCaptureLimits.checkpointBytes;
    edge.ready.artifact.resourceCount = 4096;
    expect(() => decodeCoreCaptureStatus(rehash(edge), binding)).not.toThrow();
  });
});
