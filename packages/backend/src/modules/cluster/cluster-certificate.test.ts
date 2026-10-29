import { createHash, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { bindClusterCertificate, clusterCertificate, pairedClusterCertificate } from './cluster-certificate';
import { clusterTlsFixture } from './cluster-tls.fixture';

vi.unmock('node:fs');
let fixture: ReturnType<typeof clusterTlsFixture>;
beforeAll(() => {
  fixture = clusterTlsFixture();
});
afterAll(() => fixture?.remove());
const input = (pem = fixture.root) => ({
  peerCertificatePem: pem,
  peerCertificateSha256: createHash('sha256').update(new X509Certificate(pem).raw).digest('hex'),
  confirmPeerCertificate: true,
});
const certificate = () => {
  const value = clusterCertificate(input());
  if (!value) throw new Error('Missing test certificate');
  return value;
};

it('keeps default trust unchanged, and requires all optional approval fields together', () => {
  expect(clusterCertificate({})).toBeUndefined();
  for (const value of [
    { peerCertificatePem: fixture.root },
    { peerCertificateSha256: input().peerCertificateSha256 },
    { confirmPeerCertificate: true },
    { ...input(), confirmPeerCertificate: false },
    { ...input(), confirmPeerCertificate: 'true' },
  ])
    expect(() => clusterCertificate(value)).toThrow('confirm its SHA-256');
});

it('accepts one confirmed current root or stock self-signed certificate, with a canonical DER fingerprint', () => {
  for (const pem of [fixture.root, fixture.self]) {
    const value = input(pem);
    const accepted = clusterCertificate(value);
    expect(accepted?.sha256).toBe(value.peerCertificateSha256);
    expect(accepted?.pem).toBe(new X509Certificate(pem).toString());
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(clusterCertificate({ ...value, peerCertificateSha256: value.peerCertificateSha256.toUpperCase().match(/.{2}/g)?.join(':') })?.sha256).toBe(
      value.peerCertificateSha256,
    );
  }
});

it('rejects private keys, mixed/bundled input, trailing DER/text, invalid fingerprints and CA-signed leaf-only uploads', () => {
  const extra = Buffer.concat([new X509Certificate(fixture.root).raw, Buffer.from('extra DER')]);
  for (const pem of [
    fixture.key,
    fixture.root + fixture.key,
    fixture.root + fixture.root,
    fixture.leaf,
    `junk\n${fixture.root}`,
    `${fixture.root}junk`,
    'x'.repeat(65537),
    '-----BEGIN CERTIFICATE-----\ninvalid!\n-----END CERTIFICATE-----',
    `-----BEGIN CERTIFICATE-----\n${extra.toString('base64')}\n-----END CERTIFICATE-----`,
  ])
    expect(() => clusterCertificate({ ...input(), peerCertificatePem: pem })).toThrow('Never upload a private key');
  expect(() => clusterCertificate({ ...input(), peerCertificateSha256: '0'.repeat(64) })).toThrow('SHA-256');
  expect(() => clusterCertificate({ ...input(), peerCertificateSha256: 'aa:'.repeat(32) })).toThrow('SHA-256');
  const root = new X509Certificate(fixture.root);
  expect(() => clusterCertificate(input(), Date.parse(root.validFrom) - 1)).toThrow('current public');
  expect(() => clusterCertificate(input(), Date.parse(root.validTo))).toThrow('current public');
});

it('binds stored public trust to exact member, origin, admin identity and pairing-secret generation without fallback', () => {
  const admin = 'admin-fixture';
  const peer = { id: 'member-fixture', url: 'https://source.example.test:8443', secret: 'a'.repeat(64) };
  const tls = bindClusterCertificate(certificate(), admin, peer.id, peer.url, peer.secret);
  expect(pairedClusterCertificate(admin, { ...peer, tls })).toEqual(certificate());
  expect(pairedClusterCertificate(admin, peer)).toBeUndefined();
  for (const changed of [
    { ...peer, id: 'other-member' },
    { ...peer, url: 'https://other.example.test' },
    { ...peer, secret: 'b'.repeat(64) },
  ])
    expect(() => pairedClusterCertificate(admin, { ...changed, tls })).toThrow('pair again');
  expect(() => pairedClusterCertificate('changed-admin-generation', { ...peer, tls })).toThrow('pair again');
  expect(() => pairedClusterCertificate(admin, { ...peer, tls: { ...tls, pem: fixture.self } })).toThrow('SHA-256');
  expect(() => pairedClusterCertificate(admin, { ...peer, tls: { ...tls, unknown: 'unsafe' } as typeof tls })).toThrow('pair again');
});
