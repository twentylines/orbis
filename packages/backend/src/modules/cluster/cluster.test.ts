import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { ClusterStateService } from './cluster-state.service';
import { clusterOrigin, CLUSTER_PROTOCOL, privateAddress, signedHeaders } from './cluster-transport';

describe('cluster pairing and authority', () => {
  let root: string;
  let config: ConfigurationService;
  let state: ClusterStateService;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-cluster-'));
    config = { get: (key: string) => (key === 'directories' ? { dataDir: root } : { localDomain: 'test.local' }) } as unknown as ConfigurationService;
    state = new ClusterStateService(config);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const acceptance = (code: string) => ({
    protocol: CLUSTER_PROTOCOL,
    code,
    adminId: '9adb06f2-0745-4d08-83cc-409a599fef41',
    adminName: 'Admin',
    clusterName: 'Home',
    secret: '1'.repeat(64),
  });

  it('persists identity, keeps secrets private, and never returns them in the public view', async () => {
    const first = await state.describe();
    const again = await new ClusterStateService(config).describe();
    expect(again.localId).toBe(first.localId);
    const invitation = await state.invite();
    const file = path.join(root, 'state', 'cluster.json');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(file, 'utf8')).not.toContain(invitation.code);
    await state.accept(acceptance(invitation.code));
    expect(JSON.stringify(await state.describe())).not.toContain('1'.repeat(64));
  });

  it('consumes a code once, atomically across simultaneous accept requests', async () => {
    const invite = await state.invite();
    const results = await Promise.allSettled([state.accept(acceptance(invite.code)), state.accept(acceptance(invite.code))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(new ClusterStateService(config).accept(acceptance(invite.code))).rejects.toThrow('Pairing code');
    await expect(state.create('Another')).rejects.toThrow('Leave this cluster');
    await expect(state.invite()).rejects.toThrow('already belongs');
  });

  it('rejects expired or replaced codes and malformed names without changing membership', async () => {
    const old = await state.invite();
    const current = await state.invite();
    await expect(state.accept(acceptance(old.code))).rejects.toThrow('Pairing code');
    await expect(state.accept({ ...acceptance(current.code), clusterName: '\n' })).rejects.toThrow('name');
    await state.transaction((value) => {
      if (value.invite) value.invite.expiresAt = Date.now() - 1;
    });
    await expect(state.accept(acceptance(current.code))).rejects.toThrow('Pairing code');
    expect((await state.describe()).role).toBe('standalone');
  });

  it('requires the selected admin signature and binds it to the complete command body', async () => {
    const invite = await state.invite();
    const pair = acceptance(invite.code);
    await state.accept(pair);
    const body = { action: 'command', command: 'update-apps', payload: {} };
    const headers = signedHeaders(pair.adminId, pair.secret, JSON.stringify(body));
    await expect(state.authorize(headers, { ...body, command: 'apply-orbis' })).rejects.toThrow('signature');
    await expect(state.authorize({ ...headers, 'x-orbis-server': 'another' }, body)).rejects.toThrow('signature');
    await expect(state.authorize(signedHeaders(pair.adminId, pair.secret, JSON.stringify(body), String(Date.now() - 61_000)), body)).rejects.toThrow(
      'signature',
    );
    expect(await state.authorize(headers, body)).toBe(true);
    await expect(state.authorize(headers, body)).rejects.toThrow('already been used');
    await expect(new ClusterStateService(config).authorize(headers, body)).rejects.toThrow('already been used');
    await state.leave();
    await expect(state.authorize(signedHeaders(pair.adminId, pair.secret, JSON.stringify(body)), body)).rejects.toThrow('signature');
  });

  it('keeps admin authority separate from member authority and refuses an orphaning cluster delete', async () => {
    await state.create('Home', 'Hades');
    await state.transaction((value) => {
      value.peers.push({ id: 'child', name: 'Atlas', secret: '2'.repeat(64), url: 'https://192.168.1.2', insecureLan: false });
    });
    await expect(state.leave()).rejects.toThrow('Remove paired servers');
    const publicState = await state.describe();
    expect(publicState.servers[0]?.role).toBe('admin');
    expect(JSON.stringify(publicState)).not.toContain('2'.repeat(64));
    await expect(state.authorize({}, {})).rejects.toThrow('signature');
  });
});

describe('cluster network target restrictions', () => {
  it.each(['10.0.0.2', '172.16.0.2', '172.31.255.1', '192.168.0.10', '100.64.0.1', '100.127.255.254', 'fd12::2'])(
    'permits private LAN or VPN address %s',
    (address) => expect(privateAddress(address)).toBe(true),
  );
  it.each([
    '127.0.0.1',
    '169.254.169.254',
    '8.8.8.8',
    '100.128.0.1',
    '172.32.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.0.10',
    'fe80::1',
    '0.0.0.0',
    'example.org',
  ])('refuses non-private or ambiguous target %s', (address) => expect(privateAddress(address)).toBe(false));
  it('requires deliberate LAN HTTP consent and rejects URL credentials, queries, fragments and paths', () => {
    expect(clusterOrigin('http://192.168.0.2', true).origin).toBe('http://192.168.0.2');
    expect(() => clusterOrigin('http://192.168.0.2')).toThrow('HTTPS');
    for (const url of [
      'https://user:pass@192.168.0.2',
      'https://192.168.0.2/api',
      'https://192.168.0.2?token=x',
      'https://192.168.0.2#x',
      'file:///tmp/x',
    ]) {
      expect(() => clusterOrigin(url)).toThrow();
    }
  });
});
