import { createHash, X509Certificate } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { type } from 'arktype';

const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
export const clusterCertificateTrustSchema = type({
  '+': 'reject',
  version: '1',
  origin: 'string > 0 & string <= 2048',
  memberId: 'string > 0 & string <= 64',
  generation: hash,
  pem: 'string > 0 & string <= 65536',
  sha256: hash,
});
export type ClusterCertificateTrust = typeof clusterCertificateTrustSchema.infer;
export type ClusterCertificate = Readonly<{ pem: string; sha256: string }>;

export function clusterCertificate(
  input: {
    peerCertificatePem?: unknown;
    peerCertificateSha256?: unknown;
    confirmPeerCertificate?: unknown;
  },
  now = Date.now(),
): ClusterCertificate | undefined {
  const { peerCertificatePem: pem, peerCertificateSha256: fingerprint, confirmPeerCertificate: confirmed } = input;
  if (pem === undefined && fingerprint === undefined && confirmed === undefined) return undefined;
  const refuse = () => {
    throw new BadRequestException(
      'Upload one current public peer certificate and confirm its SHA-256 fingerprint on that server. Never upload a private key.',
    );
  };
  if (confirmed !== true || typeof pem !== 'string' || Buffer.byteLength(pem) > 65536 || typeof fingerprint !== 'string') return refuse();
  const normalized = fingerprint.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized) && !/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/.test(normalized)) return refuse();
  const match = /^\s*-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----\s*$/.exec(pem);
  if (!match?.[1]) return refuse();
  try {
    const encoded = match[1].replace(/[\r\n]/g, '');
    const der = Buffer.from(encoded, 'base64');
    if (!der.length || der.toString('base64') !== encoded) return refuse();
    const certificate = new X509Certificate(der);
    if (
      !certificate.raw.equals(der) ||
      certificate.subject !== certificate.issuer ||
      !certificate.verify(certificate.publicKey) ||
      !Number.isFinite(Date.parse(certificate.validFrom)) ||
      Date.parse(certificate.validFrom) > now ||
      !Number.isFinite(Date.parse(certificate.validTo)) ||
      Date.parse(certificate.validTo) <= now
    )
      return refuse();
    const sha256 = createHash('sha256').update(certificate.raw).digest('hex');
    if (sha256 !== normalized.replaceAll(':', '')) return refuse();
    return Object.freeze({ pem: certificate.toString(), sha256 });
  } catch {
    return refuse();
  }
}

const generation = (adminId: string, memberId: string, secret: string) =>
  createHash('sha256').update(JSON.stringify({ adminId, memberId, secret })).digest('hex');

export function bindClusterCertificate(
  certificate: ClusterCertificate,
  adminId: string,
  memberId: string,
  origin: string,
  secret: string,
): ClusterCertificateTrust {
  return { version: 1, origin, memberId, generation: generation(adminId, memberId, secret), pem: certificate.pem, sha256: certificate.sha256 };
}

export function pairedClusterCertificate(
  adminId: string,
  peer: { id: string; url: string; secret: string; tls?: ClusterCertificateTrust },
): ClusterCertificate | undefined {
  if (peer.tls === undefined) return undefined;
  const trust = peer.tls;
  if (
    !clusterCertificateTrustSchema.allows(trust) ||
    trust.origin !== peer.url ||
    trust.memberId !== peer.id ||
    trust.generation !== generation(adminId, peer.id, peer.secret)
  )
    throw new ConflictException('The approved certificate no longer matches this paired server. Remove it and pair again.');
  return clusterCertificate({ peerCertificatePem: trust.pem, peerCertificateSha256: trust.sha256, confirmPeerCertificate: true });
}
