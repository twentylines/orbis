import { createHash } from 'node:crypto';
import { backupGcmPlaintextLimit } from '../system-backups/backup-crypto';
import { canonicalPublicationJson } from './host-controller-publication';

export type CoreCaptureBinding = { id: string; sourceSha256: string; sourceHoldSha256: string };
export type CoreCheckpointArtifact = {
  schema: 'orbis.time-machine-core-checkpoint-artifact.v1';
  pointId: string;
  sourceSha256: string;
  checkpointSha256: string;
  captureJobSha256: string;
  portableStorageSha256: string;
  manifestSha256: string;
  resourceCount: number;
  roleImageIds: { controller: string; database: string; queue: string };
  compatibility: {
    os: 'linux';
    architecture: 'amd64' | 'arm64';
    database: { engine: 'postgresql'; major: number };
    storageFormat: 'physical-pgdata.v1';
  };
  checkpoint: { bytes: number; sha256: string };
};
type BaseStatus = CoreCaptureBinding & { version: 1 };
export type CoreCaptureStatus =
  | (BaseStatus & { state: 'reserved' | 'launch-unsettled' | 'running' | 'recovery-required' | 'unsupported' })
  | (BaseStatus & {
      state: 'resumed-awaiting-publication';
      ready: { captureReceiptSha256: string; checkpointArtifactSha256: string; artifact: CoreCheckpointArtifact };
    });
export const coreCaptureLimits = { metadataBytes: 65536, checkpointBytes: backupGcmPlaintextLimit - 1024 * 1024, chunkBytes: 65536 } as const;

const fail = () => new Error('Core capture response could not be verified.');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const image = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export function validateCoreCaptureBinding(raw: unknown): CoreCaptureBinding {
  if (
    !record(raw) ||
    !keys(raw, ['id', 'sourceSha256', 'sourceHoldSha256']) ||
    !uuid(raw.id) ||
    !hash(raw.sourceSha256) ||
    !hash(raw.sourceHoldSha256)
  )
    throw fail();
  return Object.freeze({ id: raw.id, sourceSha256: raw.sourceSha256, sourceHoldSha256: raw.sourceHoldSha256 });
}

function artifact(raw: unknown, binding: CoreCaptureBinding): CoreCheckpointArtifact {
  if (
    !record(raw) ||
    !keys(raw, [
      'schema',
      'pointId',
      'sourceSha256',
      'checkpointSha256',
      'captureJobSha256',
      'portableStorageSha256',
      'manifestSha256',
      'resourceCount',
      'roleImageIds',
      'compatibility',
      'checkpoint',
    ]) ||
    raw.schema !== 'orbis.time-machine-core-checkpoint-artifact.v1' ||
    raw.pointId !== binding.id ||
    raw.sourceSha256 !== binding.sourceSha256 ||
    !hash(raw.checkpointSha256) ||
    !hash(raw.captureJobSha256) ||
    !hash(raw.portableStorageSha256) ||
    !hash(raw.manifestSha256) ||
    !integer(raw.resourceCount, 1, 4096) ||
    !record(raw.roleImageIds) ||
    !keys(raw.roleImageIds, ['controller', 'database', 'queue']) ||
    !image(raw.roleImageIds.controller) ||
    !image(raw.roleImageIds.database) ||
    !image(raw.roleImageIds.queue) ||
    !record(raw.compatibility) ||
    !keys(raw.compatibility, ['os', 'architecture', 'database', 'storageFormat']) ||
    raw.compatibility.os !== 'linux' ||
    (raw.compatibility.architecture !== 'amd64' && raw.compatibility.architecture !== 'arm64') ||
    raw.compatibility.storageFormat !== 'physical-pgdata.v1' ||
    !record(raw.compatibility.database) ||
    !keys(raw.compatibility.database, ['engine', 'major']) ||
    raw.compatibility.database.engine !== 'postgresql' ||
    !integer(raw.compatibility.database.major, 1, 99) ||
    !record(raw.checkpoint) ||
    !keys(raw.checkpoint, ['bytes', 'sha256']) ||
    !integer(raw.checkpoint.bytes, 1, coreCaptureLimits.checkpointBytes) ||
    !hash(raw.checkpoint.sha256)
  )
    throw fail();
  return Object.freeze({
    schema: raw.schema,
    pointId: binding.id,
    sourceSha256: binding.sourceSha256,
    checkpointSha256: raw.checkpointSha256,
    captureJobSha256: raw.captureJobSha256,
    portableStorageSha256: raw.portableStorageSha256,
    manifestSha256: raw.manifestSha256,
    resourceCount: raw.resourceCount,
    roleImageIds: Object.freeze({ controller: raw.roleImageIds.controller, database: raw.roleImageIds.database, queue: raw.roleImageIds.queue }),
    compatibility: Object.freeze({
      os: raw.compatibility.os,
      architecture: raw.compatibility.architecture,
      database: Object.freeze({ engine: raw.compatibility.database.engine, major: raw.compatibility.database.major }),
      storageFormat: raw.compatibility.storageFormat,
    }),
    checkpoint: Object.freeze({ bytes: raw.checkpoint.bytes, sha256: raw.checkpoint.sha256 }),
  });
}

export function decodeCoreCaptureStatus(raw: unknown, expected: CoreCaptureBinding): CoreCaptureStatus {
  const binding = validateCoreCaptureBinding(expected);
  if (
    !record(raw) ||
    raw.version !== 1 ||
    raw.id !== binding.id ||
    raw.sourceSha256 !== binding.sourceSha256 ||
    raw.sourceHoldSha256 !== binding.sourceHoldSha256
  )
    throw fail();
  if (
    raw.state === 'reserved' ||
    raw.state === 'launch-unsettled' ||
    raw.state === 'running' ||
    raw.state === 'recovery-required' ||
    raw.state === 'unsupported'
  ) {
    if (!keys(raw, ['version', 'id', 'state', 'sourceSha256', 'sourceHoldSha256'])) throw fail();
    return Object.freeze({ version: 1, ...binding, state: raw.state });
  }
  if (
    raw.state !== 'resumed-awaiting-publication' ||
    !keys(raw, ['version', 'id', 'state', 'sourceSha256', 'sourceHoldSha256', 'ready']) ||
    !record(raw.ready) ||
    !keys(raw.ready, ['captureReceiptSha256', 'checkpointArtifactSha256', 'artifact']) ||
    !hash(raw.ready.captureReceiptSha256) ||
    !hash(raw.ready.checkpointArtifactSha256)
  )
    throw fail();
  const decoded = artifact(raw.ready.artifact, binding);
  if (createHash('sha256').update(canonicalPublicationJson(decoded)).digest('hex') !== raw.ready.checkpointArtifactSha256) throw fail();
  return Object.freeze({
    version: 1,
    ...binding,
    state: raw.state,
    ready: Object.freeze({
      captureReceiptSha256: raw.ready.captureReceiptSha256,
      checkpointArtifactSha256: raw.ready.checkpointArtifactSha256,
      artifact: decoded,
    }),
  });
}
