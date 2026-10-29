import { createHash, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sourceCertificate } from './transfer-certificates';
import { transferTlsFixture } from './transfer-tls.fixture';

vi.unmock('node:fs');

let fixture: ReturnType<typeof transferTlsFixture>;
beforeAll(() => {
  fixture = transferTlsFixture();
});
afterAll(() => fixture?.remove());
const input = (pem = fixture.root) => ({
  sourceCertificatePem: pem,
  sourceCertificateSha256: createHash('sha256').update(new X509Certificate(pem).raw).digest('hex'),
  confirmSourceCertificate: true,
});

it('leaves normal trust unchanged unless all three optional fields are supplied', () => {
  expect(sourceCertificate({})).toBeUndefined();
  expect(
    sourceCertificate({ sourceCertificatePem: undefined, sourceCertificateSha256: undefined, confirmSourceCertificate: undefined }),
  ).toBeUndefined();
  for (const value of [
    { sourceCertificatePem: fixture.root },
    { sourceCertificateSha256: input().sourceCertificateSha256 },
    { confirmSourceCertificate: true },
    { ...input(), confirmSourceCertificate: false },
    { ...input(), confirmSourceCertificate: 'true' },
  ])
    expect(() => sourceCertificate(value)).toThrow('confirm its SHA-256');
});

it('accepts one confirmed current private CA root or stock self-signed server certificate, using DER fingerprint', () => {
  for (const pem of [fixture.root, fixture.self]) {
    const value = input(pem);
    const accepted = sourceCertificate(value);
    expect(accepted?.sha256).toBe(value.sourceCertificateSha256);
    expect(accepted?.pem).toBe(new X509Certificate(pem).toString());
    expect(Object.isFrozen(accepted)).toBe(true);
    const formatted = value.sourceCertificateSha256.toUpperCase().match(/.{2}/g)?.join(':') ?? '';
    expect(sourceCertificate({ ...value, sourceCertificateSha256: formatted })?.sha256).toBe(value.sourceCertificateSha256);
    expect(sourceCertificate({ ...value, sourceCertificatePem: `\n${pem.replaceAll('\n', '\r\n')}\n` })?.sha256).toBe(value.sourceCertificateSha256);
  }
});

it('rejects keys, mixed bundles, trailing content, malformed DER/base64 and oversized PEM without exposing input', () => {
  const der = Buffer.concat([new X509Certificate(fixture.root).raw, Buffer.from('trailing DER')]);
  for (const pem of [
    fixture.key,
    fixture.root + fixture.key,
    fixture.root + fixture.root,
    `text\n${fixture.root}`,
    `${fixture.root}\ntext`,
    'x'.repeat(65537),
    '-----BEGIN CERTIFICATE-----\ninvalid!\n-----END CERTIFICATE-----',
    `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----`,
    fixture.root.replace('-----END CERTIFICATE-----', 'A\n-----END CERTIFICATE-----'),
  ]) {
    expect(() => sourceCertificate({ ...input(), sourceCertificatePem: pem })).toThrow('Never upload a private key');
  }
});

it('refuses wrong fingerprints, CA-signed leaf uploads, expiry and not-yet-valid anchors', () => {
  expect(() => sourceCertificate({ ...input(), sourceCertificateSha256: '0'.repeat(64) })).toThrow('SHA-256');
  expect(() => sourceCertificate({ ...input(), sourceCertificateSha256: 'aa:'.repeat(32) })).toThrow('SHA-256');
  expect(() => sourceCertificate(input(fixture.leaf))).toThrow('public source certificate');
  const cert = new X509Certificate(fixture.root);
  expect(() => sourceCertificate(input(), Date.parse(cert.validFrom) - 1)).toThrow('current public');
  expect(() => sourceCertificate(input(), Date.parse(cert.validTo))).toThrow('current public');
});
