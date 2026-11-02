import { createHash } from 'node:crypto';
import { type } from 'arktype';
import { timeMachineHashSchema as hash } from '@runtipi/common/schemas/time-machine';
import { canonicalPublicationJson as canonical } from './host-controller-publication';

export const proxyHostIdentityEntryName = 'host-identity/proxy.json';
export const proxyHostIdentityLimit = 16 * 1024;
const digest = type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value));
export const proxyHostIdentitySchema = type({
  schema: "'orbis.proxy-host-identity-policy.v1'",
  policy: "'preserve-live-proxy-identity.v1'",
  rootSha256: hash,
  dockerContextSha256: hash,
  configuration: type({
    destination: "'/etc/traefik'",
    readOnly: 'true',
    staticSha256: hash,
    capture: "'encrypted-review-only'",
    restore: "'preserve-live'",
  }).onUndeclaredKey('reject'),
  mutableIdentity: type({
    destination: "'/shared'",
    capture: "'excluded'",
    restore: "'preserve-live'",
    ownershipSha256: hash,
  }).onUndeclaredKey('reject'),
  proxy: type({ containerId: hash, imageId: digest }).onUndeclaredKey('reject'),
  sha256: hash,
}).onUndeclaredKey('reject');
export type ProxyHostIdentity = typeof proxyHostIdentitySchema.infer;

export function decodeProxyHostIdentity(raw: unknown, rootSha256?: string): ProxyHostIdentity {
  const value = proxyHostIdentitySchema(raw);
  if (value instanceof type.errors) throw new Error('Protected proxy host identity could not be verified.');
  const { sha256, ...descriptor } = value;
  if (
    Buffer.byteLength(canonical(value)) > proxyHostIdentityLimit ||
    createHash('sha256')
      .update(`orbis.proxy-host-identity-policy.v1\n${canonical(descriptor)}`)
      .digest('hex') !== sha256 ||
    (rootSha256 !== undefined && value.rootSha256 !== rootSha256)
  )
    throw new Error('Protected proxy host identity could not be verified.');
  return structuredClone(value);
}
