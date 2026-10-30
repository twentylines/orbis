import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { clusterTlsFixture } from './cluster-tls.fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { AuthService } from '../auth/auth.service';
import type { UserRepository } from '../user/user.repository';
import { ClusterService } from './cluster.service';
import { ClusterStateService } from './cluster-state.service';
import { ClusterPairingService } from './cluster-pairing.service';
import { clusterRequest, CLUSTER_PROTOCOL, PAIRING_AUTH_PROTOCOL } from './cluster-transport';
vi.unmock('node:fs');
vi.mock('./cluster-transport', async (original) => ({ ...(await original<typeof import('./cluster-transport')>()), clusterRequest: vi.fn() }));
let root: string;
let localState: ClusterStateService;
let remoteState: ClusterStateService;
let local: ClusterPairingService;
let remote: ClusterPairingService;
let code: string;
const actor = { userId: 1, session: 'a'.repeat(64) };
const localAuth = { verifySensitiveAction: vi.fn() };
const remoteAuth = { verifySensitiveAction: vi.fn() };
const remoteUsers = { getUserDtoById: vi.fn() };
const config = (directory: string) =>
  ({ get: (key: string) => (key === 'directories' ? { dataDir: directory } : { localDomain: 'unit.home.arpa' }) }) as ConfigurationService;
const connectBody = () => ({ url: 'https://other.home.arpa', code, password: 'local-only' });
const completeBody = (pendingId: string) => ({ pendingId, password: 'remote-only', totpCode: '123456' });
const connect = () => local.connect(connectBody(), actor);
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-account-pairing-'));
  localState = new ClusterStateService(config(path.join(root, 'admin')));
  remoteState = new ClusterStateService(config(path.join(root, 'other')));
  await localState.create('Test group', 'Admin');
  code = (await remoteState.invite(42)).code;
  localAuth.verifySensitiveAction.mockImplementation(async (id, password) => {
    if (id !== 1 || password !== 'local-only') throw new Error('wrong local account');
    return { id, operator: true };
  });
  remoteAuth.verifySensitiveAction.mockImplementation(async (id, password, totp) => {
    if (id !== 42 || password !== 'remote-only' || totp !== '123456') throw new Error('private authentication detail');
    return { id, operator: true };
  });
  remoteUsers.getUserDtoById.mockResolvedValue({ id: 42, operator: true, totpEnabled: true });
  remote = new ClusterPairingService(remoteState, remoteAuth as unknown as AuthService, remoteUsers as unknown as UserRepository);
  local = new ClusterPairingService(localState, localAuth as unknown as AuthService, {} as UserRepository);
  vi.mocked(clusterRequest).mockImplementation(async (_url, endpoint, body) => {
    if (endpoint === '/api/cluster/pairing/challenge') return remote.challenge(body as Record<string, unknown>) as never;
    if (endpoint === '/api/cluster/pairing/authorize') return remote.authorize(body as Record<string, unknown>) as never;
    throw new Error('unexpected transport');
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
it('connects first, verifies the remote issuer with MFA, persists only peer trust and consumes once', async () => {
  const connection = await connect();
  expect(connection).toMatchObject({ origin: 'https://other.home.arpa', totpRequired: true });
  expect(remoteAuth.verifySensitiveAction).not.toHaveBeenCalled();
  expect((await remoteState.read()).role).toBe('standalone');
  const first = vi.mocked(clusterRequest).mock.calls[0];
  expect(JSON.stringify(first?.[2])).not.toMatch(/local-only|password|totpCode/);
  expect(first?.[4]).toBe(false);
  expect(await local.complete(completeBody(connection.pendingId), actor)).toMatchObject({ paired: true, id: connection.id });
  expect(remoteAuth.verifySensitiveAction).toHaveBeenCalledWith(42, 'remote-only', '123456');
  const admin = await localState.read();
  const member = await remoteState.read();
  expect(admin.peers).toHaveLength(1);
  expect(admin.peers[0]?.id).toBe(member.id);
  expect(admin.peers[0]?.secret).toBe(member.admin?.secret);
  expect(member.admin?.id).toBe(admin.id);
  expect(member.invite).toBeUndefined();
  expect(await fs.readFile(path.join(root, 'other/state/cluster.json'), 'utf8')).not.toMatch(
    /remote-only|local-only|password|totpCode|challenge|123456/,
  );
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('expired');
  await expect(remote.authorize(vi.mocked(clusterRequest).mock.calls[1]?.[2] as Record<string, unknown>)).rejects.toThrow('expired');
});
it('new codes cannot use legacy code-only accept', async () => {
  const current = await localState.read();
  await expect(
    remoteState.accept({ protocol: CLUSTER_PROTOCOL, code, adminId: current.id, adminName: 'Admin', clusterName: 'Group', secret: 'b'.repeat(64) }),
  ).rejects.toThrow('other server account');
  expect((await remoteState.read()).role).toBe('standalone');
});
it('checks local fresh approval before contacting the remote host', async () => {
  await expect(local.connect({ ...connectBody(), password: 'remote-only' }, actor)).rejects.toThrow('wrong local account');
  expect(clusterRequest).not.toHaveBeenCalled();
});
it.each(['wrong-password', 'missing-mfa', 'wrong-mfa'])('remote %s cannot commit or expose internals, and can retry safely', async (reason) => {
  const connection = await connect();
  const body = completeBody(connection.pendingId);
  if (reason === 'wrong-password') body.password = 'local-only';
  if (reason === 'missing-mfa') body.totpCode = '';
  if (reason === 'wrong-mfa') body.totpCode = '654321';
  await expect(local.complete(body, actor)).rejects.toThrow('could not authorize');
  expect((await localState.read()).peers).toEqual([]);
  expect((await remoteState.read()).role).toBe('standalone');
  await expect(local.complete(completeBody(connection.pendingId), actor)).resolves.toMatchObject({ paired: true });
});
it('limits attempts across challenges for the same invitation', async () => {
  const connection = await connect();
  for (let i = 0; i < 5; i++)
    await expect(local.complete({ pendingId: connection.pendingId, password: 'wrong' }, actor)).rejects.toThrow('could not authorize');
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toMatchObject({ status: 429 });
  await expect(connect()).rejects.toMatchObject({ status: 429 });
  expect(remoteAuth.verifySensitiveAction).toHaveBeenCalledTimes(5);
});
it.each(['session', 'user'])('rejects another %s before credential dispatch', async (boundary) => {
  const connection = await connect();
  const changed = { ...actor, ...(boundary === 'user' ? { userId: 2 } : { session: 'b'.repeat(64) }) };
  await expect(local.complete(completeBody(connection.pendingId), changed)).rejects.toThrow('expired');
  expect(clusterRequest).toHaveBeenCalledTimes(1);
});
it('expires pending authorization before dispatch', async () => {
  const connection = await connect();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(connection.expiresAt) + 1);
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('expired');
  expect(clusterRequest).toHaveBeenCalledTimes(1);
});
it('replaced invitation and revoked issuer both refuse remote commit', async () => {
  const connection = await connect();
  await remoteState.invite(42);
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('expired');
  code = (await remoteState.invite(42)).code;
  const next = await connect();
  remoteUsers.getUserDtoById.mockResolvedValue({ id: 42, operator: false, totpEnabled: true });
  await expect(local.complete(completeBody(next.pendingId), actor)).rejects.toThrow('could not authorize');
  expect((await remoteState.read()).role).toBe('standalone');
});
it('legacy unbound invitations require regeneration for account pairing', async () => {
  code = (await remoteState.invite()).code;
  await expect(connect()).rejects.toThrow('expired');
  expect(remoteAuth.verifySensitiveAction).not.toHaveBeenCalled();
});
it('changed local cluster blocks remote dispatch', async () => {
  const connection = await connect();
  await localState.create('Renamed group', 'Admin');
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('Cluster changed');
  expect(clusterRequest).toHaveBeenCalledTimes(1);
});
it('fences unknown remote outcomes without replaying a password request', async () => {
  const connection = await connect();
  vi.mocked(clusterRequest).mockRejectedValueOnce(new Error('connection lost after send'));
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('not confirmed');
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('not confirmed');
  expect(clusterRequest).toHaveBeenCalledTimes(2);
});
it('cannot concurrently authorize the same pending request', async () => {
  const connection = await connect();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(clusterRequest).mockImplementationOnce(async (_url, _endpoint, body) => {
    await hold;
    return remote.authorize(body as Record<string, unknown>) as never;
  });
  const first = local.complete(completeBody(connection.pendingId), actor);
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('not confirmed');
  release();
  await expect(first).resolves.toMatchObject({ paired: true });
});
it.each([
  { url: 'http://other.home.arpa' },
  { url: 'https://other.home.arpa/path' },
  { allowInsecureLan: true },
  { callbackUrl: 'https://unrelated.example' },
  { code: 'invalid' },
])('rejects unsupported connection details before transport: %j', async (change) => {
  await expect(local.connect({ ...connectBody(), ...change }, actor)).rejects.toThrow();
  expect(clusterRequest).not.toHaveBeenCalled();
});
it('rejects an unsupported remote protocol before asking for credentials', async () => {
  vi.mocked(clusterRequest).mockResolvedValueOnce({ protocol: 'old', id: 'invalid' });
  await expect(connect()).rejects.toThrow('Update both');
});
it('cannot persist a mismatched final request identity', async () => {
  const connection = await connect();
  vi.mocked(clusterRequest).mockResolvedValueOnce({ protocol: PAIRING_AUTH_PROTOCOL, id: connection.id, requestId: 'wrong', name: 'Other' });
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('not confirmed');
  expect((await localState.read()).peers).toEqual([]);
});
it('honors a remote account without MFA while still requiring its password', async () => {
  remoteUsers.getUserDtoById.mockResolvedValue({ id: 42, operator: true, totpEnabled: false });
  remoteAuth.verifySensitiveAction.mockImplementation(async (id, password, totp) => {
    if (id !== 42 || password !== 'remote-only' || totp !== undefined) throw new Error('denied');
    return { id, operator: true };
  });
  const connection = await connect();
  expect(connection.totpRequired).toBe(false);
  await expect(local.complete({ pendingId: connection.pendingId, password: 'remote-only' }, actor)).resolves.toMatchObject({ paired: true });
});
it('remote challenges are ephemeral and cannot survive service restart', async () => {
  const connection = await connect();
  remote = new ClusterPairingService(remoteState, remoteAuth as unknown as AuthService, remoteUsers as unknown as UserRepository);
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('expired');
  expect((await remoteState.read()).role).toBe('standalone');
});
it('a local membership change after remote commit remains visibly uncertain', async () => {
  const connection = await connect();
  vi.mocked(clusterRequest).mockImplementationOnce(async (_url, _endpoint, body) => {
    const accepted = await remote.authorize(body as Record<string, unknown>);
    await localState.create('Concurrent change', 'Admin');
    return accepted as never;
  });
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('not confirmed');
  expect((await remoteState.read()).role).toBe('member');
  expect((await localState.read()).peers).toEqual([]);
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('not confirmed');
});
it('prevents a changed target or certificate from being supplied at completion', async () => {
  const connection = await connect();
  await expect(local.complete({ ...completeBody(connection.pendingId), url: 'https://unrelated.example' }, actor)).rejects.toThrow(
    'only the requested',
  );
  await expect(local.complete({ ...completeBody(connection.pendingId), peerCertificatePem: 'changed' }, actor)).rejects.toThrow('only the requested');
  expect(clusterRequest).toHaveBeenCalledTimes(1);
});
it('issuing account must still be an operator before challenge metadata is disclosed', async () => {
  remoteUsers.getUserDtoById.mockResolvedValue({ id: 42, operator: false, totpEnabled: true });
  await expect(connect()).rejects.toThrow('expired');
  expect(remoteAuth.verifySensitiveAction).not.toHaveBeenCalled();
});
it('malformed remote inputs are refused without credential verification', async () => {
  await connect();
  const request = vi.mocked(clusterRequest).mock.calls[0]?.[2] as Record<string, unknown>;
  await expect(remote.challenge({ ...request, target: { origin: 'http://other.home.arpa' } })).rejects.toThrow('HTTPS');
  await expect(remote.challenge({ ...request, callbackUrl: 'https://unrelated.example' })).rejects.toThrow('only the requested');
  await expect(remote.authorize({ protocol: PAIRING_AUTH_PROTOCOL, challenge: 'invalid', password: 'remote-only' })).rejects.toThrow('expired');
  expect(remoteAuth.verifySensitiveAction).not.toHaveBeenCalled();
});
it('an empty admin can explicitly leave and then issue a secure joining code', async () => {
  await expect(localState.invite(1)).rejects.toThrow('already belongs');
  await localState.leave();
  const invitation = await localState.invite(1);
  expect(invitation.code).toMatch(/^[A-F0-9]{24}$/);
  expect((await localState.read()).invite).toMatchObject({ ownerId: 1, authVersion: 2 });
});

it('binds custom certificate approval to both phases and the stored exact host generation', async () => {
  const fixture = clusterTlsFixture();
  try {
    const sha256 = createHash('sha256').update(new X509Certificate(fixture.root).raw).digest('hex');
    const connection = await local.connect(
      { ...connectBody(), peerCertificatePem: fixture.root, peerCertificateSha256: sha256, confirmPeerCertificate: true },
      actor,
    );
    const first = vi.mocked(clusterRequest).mock.calls[0];
    expect(first?.[5]?.sha256).toBe(sha256);
    expect(JSON.stringify(first?.[2])).not.toContain('BEGIN CERTIFICATE');
    await local.complete(completeBody(connection.pendingId), actor);
    expect(vi.mocked(clusterRequest).mock.calls[1]?.[5]).toEqual(first?.[5]);
    expect((await localState.read()).peers[0]?.tls).toMatchObject({ memberId: connection.id, origin: connection.origin, sha256 });
  } finally {
    fixture.remove();
  }
});
it('changed remote host identity invalidates its pending authorization before commit', async () => {
  const connection = await connect();
  await remoteState.transaction((state) => {
    state.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  });
  await expect(local.complete(completeBody(connection.pendingId), actor)).rejects.toThrow('expired');
  expect((await remoteState.read()).role).toBe('standalone');
});

it('authenticated invitation issuance binds its exact actor and reports storage failures safely', async () => {
  const issuer = new ClusterService(
    ...([remoteState, ...Array.from({ length: 17 }, () => ({})), localAuth] as unknown as ConstructorParameters<typeof ClusterService>),
  );
  const save = vi.spyOn(remoteState, 'invite').mockRejectedValueOnce(Object.assign(new Error('private storage details'), { code: 'EACCES' }));
  await expect(issuer.invite({ password: 'local-only' }, 1)).rejects.toThrow('storage permissions');
  expect(save).toHaveBeenCalledWith(1);
  await issuer.invite({ password: 'local-only' }, 1);
  expect((await remoteState.read()).invite).toMatchObject({ ownerId: 1, authVersion: 2 });
});

it('account invitations cannot match the old verifier even when authorization fields are ignored', async () => {
  const invite = (await remoteState.read()).invite;
  const oldVerifier = (value: string) => createHash('sha256').update(value.toUpperCase().replace(/\s/g, '')).digest('hex');
  expect(invite?.hash).toBe(createHash('sha256').update(`${PAIRING_AUTH_PROTOCOL}\n${code}`).digest('hex'));
  expect(invite?.hash).not.toBe(oldVerifier(code));
  expect(invite?.hash).not.toBe(oldVerifier(`${PAIRING_AUTH_PROTOCOL}\n${code}`));
});
it('legacy plain-hash invites remain legacy only and regeneration enables account pairing', async () => {
  const legacy = await remoteState.invite();
  const storedLegacy = (await remoteState.read()).invite;
  expect(storedLegacy?.hash).toBe(createHash('sha256').update(legacy.code).digest('hex'));
  code = legacy.code;
  await expect(connect()).rejects.toThrow('expired');
  code = (await remoteState.invite(42)).code;
  expect((await remoteState.read()).invite?.hash).not.toBe(storedLegacy?.hash);
  const connection = await connect();
  await expect(local.complete(completeBody(connection.pendingId), actor)).resolves.toMatchObject({ paired: true });
});
it('a prior plain-hash account invite fails closed until regenerated', async () => {
  await remoteState.transaction((state) => {
    if (state.invite) state.invite.hash = createHash('sha256').update(code).digest('hex');
  });
  await expect(connect()).rejects.toThrow('expired');
  code = (await remoteState.invite(42)).code;
  const connection = await connect();
  await expect(local.complete(completeBody(connection.pendingId), actor)).resolves.toMatchObject({ paired: true });
});

it.each(['removed-operator', 'removed-account', 'expired-code', 'replaced-code', 'changed-role'])(
  'rechecks %s after authentication has started and before committing',
  async (boundary) => {
    const connection = await connect();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (value: { id: number; operator: boolean }) => void;
    const verifying = new Promise<{ id: number; operator: boolean }>((resolve) => {
      release = resolve;
    });
    remoteAuth.verifySensitiveAction.mockImplementationOnce(async () => {
      entered();
      return verifying;
    });
    const completing = local.complete(completeBody(connection.pendingId), actor);
    const rejected = expect(completing).rejects.toThrow(
      boundary === 'removed-operator' || boundary === 'removed-account' ? 'could not authorize' : 'expired',
    );
    await started;
    if (boundary === 'removed-operator') remoteUsers.getUserDtoById.mockResolvedValue({ id: 42, operator: false, totpEnabled: true });
    if (boundary === 'removed-account') remoteUsers.getUserDtoById.mockResolvedValue(undefined);
    if (boundary === 'expired-code') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(connection.expiresAt) + 1);
    if (boundary === 'replaced-code') await remoteState.invite(43);
    if (boundary === 'changed-role') await remoteState.create('Other group', 'Other admin');
    release({ id: 42, operator: true });
    await rejected;
    expect((await remoteState.read()).role).toBe(boundary === 'changed-role' ? 'admin' : 'standalone');
    expect((await localState.read()).peers).toEqual([]);
  },
);
it('only one concurrent remote completion can consume the exact invitation', async () => {
  await connect();
  const firstBody = vi.mocked(clusterRequest).mock.calls[0]?.[2] as Record<string, unknown>;
  const challenge = await remote.challenge(firstBody);
  const auth = { protocol: PAIRING_AUTH_PROTOCOL, challenge: challenge.challenge, password: 'remote-only', totpCode: '123456' };
  const outcomes = await Promise.allSettled([remote.authorize(auth), remote.authorize(auth)]);
  expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
  expect((await remoteState.read()).role).toBe('member');
  expect((await remoteState.read()).invite).toBeUndefined();
});

it('discarding account metadata cannot turn its separated hash into a legacy invitation', async () => {
  await remoteState.transaction((state) => {
    if (state.invite) {
      delete state.invite.ownerId;
      delete state.invite.authVersion;
    }
  });
  const admin = await localState.read();
  await expect(
    remoteState.accept({ protocol: CLUSTER_PROTOCOL, code, adminId: admin.id, adminName: 'Admin', clusterName: 'Group', secret: 'b'.repeat(64) }),
  ).rejects.toThrow('invalid, expired or already used');
  expect((await remoteState.read()).role).toBe('standalone');
});
