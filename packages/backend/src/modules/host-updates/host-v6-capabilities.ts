import { createHash } from 'node:crypto';
import { canonicalPublicationJson } from './host-controller-publication';

const capture = {
  version: 3,
  runtimeSchema: 'orbis.time-machine-runtime.v6',
  imageCaptureSchema: 'orbis.time-machine-image-capture.v2',
  controllerAuthoritySchema: 'orbis.controller-capture-authority.v4',
  appRuntimeSchema: 'orbis.app-runtime-capture.v1',
  proxyHostIdentitySchema: 'orbis.proxy-host-identity-policy.v1',
  coherenceSchema: 'orbis.capture-coherence.v1',
} as const;
const restore = {
  version: 2,
  runtimeSchema: 'orbis.time-machine-runtime.v6',
  controllerAuthoritySchema: 'orbis.controller-capture-authority.v4',
  coordinatorProtocol: 'orbis.retained-worker-phase.v1',
  candidateAppResultProtocol: 'root-candidate-app-result.v1',
  targetAppCapability: 'orbis.retained-app-engine.v1',
  normalBootstrapProtocol: 'root-normal-bootstrap.v1',
  portsProtocol: 'inet-diag-self-proof.v1',
} as const;
const archive = {
  version: 1,
  format: 'orbis-full-backup',
  manifestVersion: 2,
  mediaPolicy: 'explicit-inclusion.v1',
  appDataLinks: 'confined-relative.v1',
} as const;

type Capability<T> = Readonly<T & { sourceSha256: string; contractSha256: string }>;
function decode<T extends Record<string, string | number>>(value: unknown, expected: T, domain: string): Capability<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid protected capability.');
  const record = value as Record<string, unknown>;
  const keys = [...Object.keys(expected), 'sourceSha256', 'contractSha256'];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw new Error('Invalid protected capability.');
  if (Object.entries(expected).some(([key, item]) => record[key] !== item)) throw new Error('Invalid protected capability.');
  if (
    typeof record.sourceSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.sourceSha256) ||
    typeof record.contractSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.contractSha256)
  )
    throw new Error('Invalid protected capability.');
  const unsigned = { ...expected, sourceSha256: record.sourceSha256 };
  const hash = createHash('sha256')
    .update(`${domain}\n${canonicalPublicationJson(unsigned)}`)
    .digest('hex');
  if (hash !== record.contractSha256) throw new Error('Invalid protected capability.');
  return Object.freeze({ ...unsigned, contractSha256: hash }) as Capability<T>;
}

export const decodeCaptureV6Capability = (value: unknown) => decode(value, capture, 'orbis.controller-capture-capability.v3');
export const decodeRestoreV6Capability = (value: unknown) => decode(value, restore, 'orbis.retained-restore-capability.v2');
export const decodeBackupArchiveCapability = (value: unknown) => decode(value, archive, 'orbis.backup-archive-capability.v1');
