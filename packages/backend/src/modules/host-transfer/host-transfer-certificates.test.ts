import { createHash, X509Certificate } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { HostTransferController } from './host-transfer.controller';
import { HostTransferService } from './host-transfer.service';
import type { TransferIngress } from './transfer-ingress';
import { transferTlsFixture } from './transfer-tls.fixture';

vi.unmock('node:fs');
let fixture: ReturnType<typeof transferTlsFixture>;
let transfers: HostTransferService;
const imports = { create: vi.fn(async () => ({ id: 'import-fixture' })), remove: vi.fn() };
const transport = {
  resolve: vi.fn(async (origin: string, certificate: unknown) =>
    Object.freeze({
      origin,
      hostname: 'source.example.test',
      address: '192.168.20.5',
      family: 4,
      port: '443',
      ...(certificate ? { certificate } : {}),
    }),
  ),
  json: vi.fn(async (_target: unknown, _endpoint: string, _body: unknown, _signal: AbortSignal) => ({
    claimId: '12345678-1234-4123-8123-123456789012',
    claimToken: 'b'.repeat(64),
    sourceFingerprint: 'c'.repeat(64),
    bytes: 64,
    expiresAt: Date.now() + 60_000,
  })),
};
const credentials = { password: 'disposable-password' };
const origin = 'https://source.example.test';
beforeAll(() => {
  fixture = transferTlsFixture();
});
beforeEach(() => {
  vi.clearAllMocks();
  transfers = new HostTransferService(...([{}, imports, {}, transport] as unknown as ConstructorParameters<typeof HostTransferService>));
});
afterEach(() => transfers.onModuleDestroy());
afterAll(() => fixture?.remove());
const trust = () => ({
  sourceCertificatePem: fixture.root,
  sourceCertificateSha256: createHash('sha256').update(new X509Certificate(fixture.root).raw).digest('hex'),
  confirmSourceCertificate: true,
});

it('keeps approved trust on its own immutable import target, out of peer bodies and public job lists', async () => {
  const input = trust();
  const approved = await transfers.createImport(1, origin, 'a'.repeat(64), credentials, input);
  await transfers.createImport(1, origin, 'a'.repeat(64), credentials);
  expect(transport.resolve.mock.calls[0]?.[1]).toEqual({ pem: new X509Certificate(fixture.root).toString(), sha256: input.sourceCertificateSha256 });
  expect(transport.resolve.mock.calls[1]?.[1]).toBeUndefined();
  const firstTarget = transport.json.mock.calls[0]?.[0] as { certificate: unknown };
  expect(Object.isFrozen(firstTarget)).toBe(true);
  expect(firstTarget.certificate).toBeTruthy();
  expect((transport.json.mock.calls[1]?.[0] as { certificate?: unknown }).certificate).toBeUndefined();
  const publicState = JSON.stringify({ approved, list: transfers.list(1), peerBody: transport.json.mock.calls[0]?.[2] });
  expect(publicState).not.toContain('BEGIN CERTIFICATE');
  expect(publicState).not.toContain(input.sourceCertificateSha256);
  expect(transfers.list(2).jobs).toEqual([]);
});

it('refuses invalid certificate confirmation before DNS, import creation or claim code transmission', async () => {
  await expect(transfers.createImport(1, origin, 'a'.repeat(64), credentials, { ...trust(), confirmSourceCertificate: false })).rejects.toThrow(
    'SHA-256',
  );
  expect(transport.resolve).not.toHaveBeenCalled();
  expect(imports.create).not.toHaveBeenCalled();
  expect(transport.json).not.toHaveBeenCalled();
});

it('accepts only the agreed flat trust fields through the actual controller contract', async () => {
  const controller = new HostTransferController(transfers, {} as TransferIngress);
  const operator = { user: { id: 1, operator: true }, authMethod: 'session' } as unknown as Request;
  await expect(controller.createImport(operator, { ...credentials, sourceOrigin: origin, code: 'a'.repeat(64), ...trust() })).resolves.toMatchObject({
    status: 'awaiting-source-approval',
  });
  expect(() => controller.createImport(operator, { ...credentials, sourceOrigin: origin, code: 'a'.repeat(64), sourceCertificate: trust() })).toThrow(
    'only the requested',
  );
});
