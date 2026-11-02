import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalPublicationJson } from './host-controller-publication';
import { decodeCaptureV6Capability, decodeRestoreV6Capability } from './host-v6-capabilities';

const sourceSha256 = 'a'.repeat(64);
const capture = {
  version: 3,
  runtimeSchema: 'orbis.time-machine-runtime.v6',
  imageCaptureSchema: 'orbis.time-machine-image-capture.v2',
  controllerAuthoritySchema: 'orbis.controller-capture-authority.v4',
  appRuntimeSchema: 'orbis.app-runtime-capture.v1',
  proxyHostIdentitySchema: 'orbis.proxy-host-identity-policy.v1',
  coherenceSchema: 'orbis.capture-coherence.v1',
  sourceSha256,
};
const restore = {
  version: 2,
  runtimeSchema: 'orbis.time-machine-runtime.v6',
  controllerAuthoritySchema: 'orbis.controller-capture-authority.v4',
  coordinatorProtocol: 'orbis.retained-worker-phase.v1',
  candidateAppResultProtocol: 'root-candidate-app-result.v1',
  targetAppCapability: 'orbis.retained-app-engine.v1',
  normalBootstrapProtocol: 'root-normal-bootstrap.v1',
  portsProtocol: 'inet-diag-self-proof.v1',
  sourceSha256,
};
const sign = (value: object, domain: string) => ({
  ...value,
  contractSha256: createHash('sha256')
    .update(`${domain}\n${canonicalPublicationJson(value)}`)
    .digest('hex'),
});

describe('protected v6 capability contracts', () => {
  it.each([
    [capture, 'orbis.controller-capture-capability.v3', decodeCaptureV6Capability],
    [restore, 'orbis.retained-restore-capability.v2', decodeRestoreV6Capability],
  ] as const)('requires an exact, domain-bound contract', (value, domain, decode) => {
    const signed = sign(value, domain);
    expect(Object.isFrozen(decode(signed))).toBe(true);
    expect(() => decode({ ...signed, extra: true })).toThrow();
    expect(() => decode({ ...signed, sourceSha256: 'b'.repeat(64) })).toThrow();
    expect(() => decode({ ...signed, sourceSha256: null })).toThrow();
    expect(() => decode({ ...signed, contractSha256: 'A'.repeat(64) })).toThrow();
    expect(() => decode(sign(value, `${domain}.other`))).toThrow();
    expect(() => decode({ ...signed, version: 99 })).toThrow();
  });
});
