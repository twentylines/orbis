import { createHash, X509Certificate } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export type SourceCertificateInput = {
  sourceCertificatePem?: unknown;
  sourceCertificateSha256?: unknown;
  confirmSourceCertificate?: unknown;
};
export type SourceCertificate = Readonly<{ pem: string; sha256: string }>;

export function sourceCertificate(input: SourceCertificateInput, now = Date.now()): SourceCertificate | undefined {
  const { sourceCertificatePem: pem, sourceCertificateSha256: fingerprint, confirmSourceCertificate: confirmed } = input;
  if (pem === undefined && fingerprint === undefined && confirmed === undefined) return undefined;
  const refuse = () => {
    throw new BadRequestException(
      'Upload one current public source certificate and confirm its SHA-256 fingerprint on the source. Never upload a private key.',
    );
  };
  if (confirmed !== true || typeof pem !== 'string' || Buffer.byteLength(pem) > 65536 || typeof fingerprint !== 'string') return refuse();
  const hash = fingerprint.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash) && !/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/.test(hash)) return refuse();
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
    if (sha256 !== hash.replaceAll(':', '')) return refuse();
    return Object.freeze({ pem: certificate.toString(), sha256 });
  } catch {
    return refuse();
  }
}
