import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { ClusterStateService } from './cluster-state.service';
import { ClusterService } from './cluster.service';
import { clusterRequest, CLUSTER_PROTOCOL } from './cluster-transport';
import { clusterTlsFixture } from './cluster-tls.fixture';

vi.unmock('node:fs');
vi.mock('./cluster-transport', async (original) => ({ ...(await original<typeof import('./cluster-transport')>()), clusterRequest: vi.fn() }));
const memberId = '01234567-89ab-4cde-8fab-0123456789ab';
const credentials = { password: 'disposable-pairing-password', totpCode: '123456' };
const auth = { verifySensitiveAction: vi.fn() };
let fixture: ReturnType<typeof clusterTlsFixture>;
let root: string;
let state: ClusterStateService;
let service: ClusterService;
let config: ConfigurationService;
beforeAll(() => {
  fixture = clusterTlsFixture();
});
afterAll(() => fixture?.remove());
beforeEach(async () => {
  vi.clearAllMocks();
  auth.verifySensitiveAction.mockResolvedValue({ id: 1, operator: true });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-cluster-trust-'));
  config = { get: (key: string) => (key === 'directories' ? { dataDir: root } : { localDomain: 'fixture.lan' }) } as unknown as ConfigurationService;
  state = new ClusterStateService(config);
  service = new ClusterService(
    ...([state, ...Array.from({ length: 17 }, () => ({})), auth] as unknown as ConstructorParameters<typeof ClusterService>),
  );
  vi.mocked(clusterRequest).mockResolvedValue({ protocol: CLUSTER_PROTOCOL, id: memberId, name: 'Joining fixture' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const pair = () => ({
  ...credentials,
  url: 'https://source.example.test:8443',
  code: 'A'.repeat(24),
  peerCertificatePem: fixture.root,
  peerCertificateSha256: createHash('sha256').update(new X509Certificate(fixture.root).raw).digest('hex'),
  confirmPeerCertificate: true,
});

it('requires fresh credentials for both issuing a pairing code and pairing, before creating trust or sending a code', async () => {
  for (const body of [{}, { password: '' }, { ...credentials, totpCode: 'bad' }]) {
    await expect(service.invite(body, 1)).rejects.toThrow('Confirm pairing');
    await expect(service.pair({ ...body, url: 'https://source.example.test', code: 'A'.repeat(24) }, 1)).rejects.toThrow('Confirm pairing');
  }
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect(clusterRequest).not.toHaveBeenCalled();
  const invitation = await service.invite(credentials, 1);
  expect(invitation.code).toMatch(/^[A-F0-9]{24}$/);
  expect(auth.verifySensitiveAction).toHaveBeenCalledWith(1, credentials.password, credentials.totpCode);
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Fresh authentication failed'));
  await expect(service.pair(pair(), 1)).rejects.toThrow('Fresh authentication failed');
  expect(clusterRequest).not.toHaveBeenCalled();
  auth.verifySensitiveAction.mockResolvedValueOnce({ id: 1, operator: false });
  await expect(service.invite(credentials, 1)).rejects.toThrow('operator account');
});

it('persists only the exact verified member certificate after pairing succeeds, and never sends credentials/certificates in protocol bodies', async () => {
  await state.create('Fixture cluster', 'Primary');
  const result = await service.pair(pair(), 1);
  expect(result).toMatchObject({ paired: true, id: memberId, certificateSha256: pair().peerCertificateSha256 });
  const saved = (await state.read()).peers[0];
  expect(saved?.tls).toMatchObject({ origin: pair().url, memberId, sha256: pair().peerCertificateSha256 });
  const body = JSON.stringify(vi.mocked(clusterRequest).mock.calls[0]?.[2]);
  for (const forbidden of [credentials.password, 'BEGIN CERTIFICATE', pair().peerCertificateSha256]) expect(body).not.toContain(forbidden);
  expect(body).not.toMatch(/"(?:password|totpCode)"\s*:/);
  expect(vi.mocked(clusterRequest).mock.calls[0]?.[5]?.pem).toBe(new X509Certificate(fixture.root).toString());
  const reloaded = new ClusterStateService(config);
  expect((await reloaded.read()).peers[0]?.tls).toEqual(saved?.tls);
  const publicValue = JSON.stringify(await reloaded.describe());
  expect(publicValue).toContain(pair().peerCertificateSha256);
  expect(publicValue).not.toContain('BEGIN CERTIFICATE');
  expect(publicValue).not.toContain(saved?.secret ?? 'missing-secret');
  expect((await fs.stat(path.join(root, 'state', 'cluster.json'))).mode & 0o777).toBe(0o600);
  const privateState = await fs.readFile(path.join(root, 'state', 'cluster.json'), 'utf8');
  expect(privateState).not.toContain(credentials.password);
  expect(privateState).not.toMatch(/"(?:password|totpCode)"\s*:/);
  vi.mocked(clusterRequest).mockClear();
  await service.read(memberId, 'apps');
  expect(vi.mocked(clusterRequest).mock.calls[0]?.[5]).toEqual({ pem: saved?.tls?.pem, sha256: saved?.tls?.sha256 });
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
});

it('does not persist certificate trust on a refused or malformed pairing response', async () => {
  await state.create('Fixture cluster');
  vi.mocked(clusterRequest).mockRejectedValueOnce(new Error('TLS certificate rejected'));
  await expect(service.pair(pair(), 1)).rejects.toThrow('TLS certificate rejected');
  expect((await state.read()).peers).toEqual([]);
  vi.mocked(clusterRequest).mockResolvedValueOnce({ protocol: CLUSTER_PROTOCOL, id: 'invalid', name: 'Fixture' });
  await expect(service.pair(pair(), 1)).rejects.toThrow('cluster protocol');
  expect((await state.read()).peers).toEqual([]);
  vi.mocked(clusterRequest).mockResolvedValueOnce(null);
  await expect(service.pair(pair(), 1)).rejects.toThrow('cluster protocol');
  expect((await state.read()).peers).toEqual([]);
});

it('does not retain approved certificate trust when primary identity changes during pairing', async () => {
  await state.create('Fixture cluster');
  vi.mocked(clusterRequest).mockImplementationOnce(async () => {
    await state.transaction((value) => {
      value.id = 'changed-primary-generation';
    });
    return { protocol: CLUSTER_PROTOCOL, id: memberId, name: 'Joining fixture' };
  });
  await expect(service.pair(pair(), 1)).rejects.toThrow('membership changed while pairing');
  expect((await new ClusterStateService(config).read()).peers).toEqual([]);
});

it('rejects trust copied across member/origin/identity/secret generation, and requires removal/re-pair for changed CA', async () => {
  await state.create('Fixture cluster');
  const adminId = (await state.read()).id;
  await service.pair(pair(), 1);
  const original = structuredClone((await state.read()).peers[0]);
  if (!original?.tls) throw new Error('Missing paired trust');
  for (const change of [{ id: 'different-member' }, { url: 'https://changed.example.test' }, { secret: 'c'.repeat(64) }]) {
    await state.transaction((value) => {
      value.peers = [{ ...original, ...change }];
    });
    vi.mocked(clusterRequest).mockClear();
    await expect(service.read(change.id ?? original.id, 'apps')).rejects.toThrow('pair again');
    expect(clusterRequest).not.toHaveBeenCalled();
  }
  await state.transaction((value) => {
    value.peers = [original];
    value.id = 'changed-admin-generation';
  });
  vi.mocked(clusterRequest).mockClear();
  await expect(service.read(original.id, 'apps')).rejects.toThrow('pair again');
  expect(clusterRequest).not.toHaveBeenCalled();
  const tls = original.tls;
  await state.transaction((value) => {
    value.id = adminId;
    value.peers = [{ ...original, tls: { ...tls, pem: fixture.self } }];
  });
  await expect(service.read(original.id, 'apps')).rejects.toThrow();
  expect(clusterRequest).not.toHaveBeenCalled();
});

it('rejects expired persisted trust before network access, and rejects unknown persisted trust fields on reload', async () => {
  await state.create('Fixture cluster');
  await service.pair(pair(), 1);
  vi.mocked(clusterRequest).mockClear();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(new X509Certificate(fixture.root).validTo));
  try {
    await expect(service.read(memberId, 'apps')).rejects.toThrow('current public');
  } finally {
    clock.mockRestore();
  }
  expect(clusterRequest).not.toHaveBeenCalled();
  await state.transaction((value) => {
    const peer = value.peers[0];
    if (!peer?.tls) throw new Error('Missing stored trust');
    Object.assign(peer.tls, { privateKey: 'must-never-load' });
  });
  await expect(new ClusterStateService(config).read()).rejects.toThrow('Invalid cluster state');
});

it('ordinary trusted HTTPS needs no uploaded certificate, while legacy private HTTP remains explicit', async () => {
  await state.create('Fixture cluster');
  const plain = { ...credentials, url: 'https://source.example.test', code: 'A'.repeat(24) };
  await expect(service.pair(plain, 1)).resolves.toMatchObject({ paired: true });
  expect(vi.mocked(clusterRequest).mock.calls[0]?.[5]).toBeUndefined();
  expect((await state.read()).peers[0]?.tls).toBeUndefined();
  await service.remove(memberId, true);
  vi.mocked(clusterRequest).mockClear();
  await expect(service.pair({ ...plain, url: 'http://192.168.20.5' }, 1)).rejects.toThrow('HTTPS');
  expect(clusterRequest).not.toHaveBeenCalled();
  await expect(service.pair({ ...plain, url: 'http://192.168.20.5', allowInsecureLan: true }, 1)).resolves.toMatchObject({ paired: true });
  expect(vi.mocked(clusterRequest).mock.calls[0]?.[4]).toBe(true);
});

it('removal deletes member trust; re-pair creates a new generation and old states without TLS remain readable', async () => {
  await state.create('Fixture cluster');
  await service.pair(pair(), 1);
  const first = (await state.read()).peers[0];
  await service.remove(memberId, true);
  expect((await new ClusterStateService(config).read()).peers).toEqual([]);
  await service.pair(pair(), 1);
  const second = (await state.read()).peers[0];
  expect(second?.secret).not.toBe(first?.secret);
  expect(second?.tls?.generation).not.toBe(first?.tls?.generation);
  await state.transaction((value) => {
    value.peers = [{ id: memberId, name: 'Legacy private HTTP', url: 'http://192.168.20.5', secret: 'b'.repeat(64), insecureLan: true }];
  });
  const legacy = new ClusterStateService(config);
  expect((await legacy.read()).peers[0]?.tls).toBeUndefined();
  vi.mocked(clusterRequest).mockClear();
  await service.read(memberId, 'apps');
  expect(vi.mocked(clusterRequest).mock.calls[0]?.[4]).toBe(true);
  expect(vi.mocked(clusterRequest).mock.calls[0]?.[5]).toBeUndefined();
});
