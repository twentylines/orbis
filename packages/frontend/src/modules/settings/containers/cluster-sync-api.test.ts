import { expect, test } from 'bun:test';
import {
  readClusterSync,
  runClusterSync,
  saveClusterSync,
  saveReceiving,
  syncEndpoint,
  type ClusterSyncHost,
  type ClusterSyncSnapshot,
} from './cluster-sync-api';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const host: ClusterSyncHost = {
  id,
  name: 'Receiving server',
  available: true,
  accepted: ['customisation'],
  revisions: { customisation: 'a'.repeat(64) },
  receipts: {},
  plan: {
    hostId: id,
    revision: 3,
    categories: ['customisation'],
    automatic: true,
    status: 'synced',
    lastAttemptAt: null,
    results: [],
    usesYourAccount: true,
    trustCurrent: true,
  },
};
const snapshot: ClusterSyncSnapshot = {
  version: 1,
  role: 'admin',
  receiving: { revision: 0, categories: [], usesYourAccount: false, configured: false },
  hosts: [host],
  source: { orbis: { enabled: false, mode: 'idle' }, appCount: 2, time: '03:00' },
};
async function withFetch(response: Response, run: (calls: { url: unknown; init?: RequestInit }[]) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: { url: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = Object.assign(
    async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return response.clone();
    },
    { preconnect: original.preconnect },
  );
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}
test('reads validated saved choices using owner-session privacy and no redirects or caching', async () => {
  await withFetch(Response.json(snapshot), async (calls) => {
    expect(await readClusterSync()).toEqual(snapshot);
    expect(calls[0]).toMatchObject({
      url: '/api/cluster/settings-sync',
      init: { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' },
    });
  });
});
test('saves receiving consent with the current consent revision and explicit categories only', async () => {
  await withFetch(Response.json({ saved: true }), async (calls) => {
    await saveReceiving(2, ['customisation', 'schedules']);
    expect(calls[0]?.url).toBe('/api/cluster/settings-sync/receiving');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ revision: 2, categories: ['customisation', 'schedules'] });
  });
});
test('persists a host-specific keep-in-sync rule with exact reviewed revisions', async () => {
  await withFetch(Response.json({ saved: true }), async (calls) => {
    await saveClusterSync(host, ['customisation'], true);
    expect(calls[0]?.url).toBe(`/api/cluster/settings-sync/plans/${id}`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      revision: 3,
      categories: ['customisation'],
      automatic: true,
      expected: host.revisions,
    });
    expect(String(calls[0]?.init?.body)).not.toContain('secret');
  });
});
test('manual sync binds the current source account, pairing generation and target baseline', async () => {
  const plan = host.plan;
  if (!plan) throw new Error('Expected a configured host plan');
  await withFetch(Response.json({ hostId: id, status: 'synced', results: [] }), async (calls) => {
    await runClusterSync(host);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ revision: 3, expected: host.revisions });
    await expect(runClusterSync({ ...host, plan: { ...plan, trustCurrent: false } })).rejects.toThrow('using your account');
    await expect(runClusterSync({ ...host, plan: { ...plan, usesYourAccount: false } })).rejects.toThrow('using your account');
    expect(calls).toHaveLength(1);
  });
});
test('unselecting a host saves no categories and no automatic rule', async () => {
  await withFetch(Response.json({ saved: true }), async (calls) => {
    await saveClusterSync(host, [], false);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ categories: [], automatic: false });
  });
});
test('arbitrary hosts, peer endpoints, queries and traversal are rejected locally', () => {
  for (const path of [
    'https://other.example',
    '//other.example',
    '/peer',
    '/plans/../../settings',
    `/plans/${id}?secret=value`,
    `/plans/${id}/run/extra`,
  ])
    expect(() => syncEndpoint(path)).toThrow('paired server');
});
test('unsupported, secret-bearing and duplicate-category status is rejected before UI use', async () => {
  for (const bad of [
    { ...snapshot, version: 2 },
    { ...snapshot, secret: 'private-value' },
    { ...snapshot, hosts: [{ ...host, secret: 'private-value' }] },
    { ...snapshot, receiving: { ...snapshot.receiving, categories: ['customisation', 'customisation'] } },
  ])
    await withFetch(Response.json(bad), async () => {
      await expect(readClusterSync()).rejects.toThrow('could not be verified');
    });
});
test('stale, unavailable and upstream errors use fixed actionable messages without echoing peer data', async () => {
  for (const status of [401, 403, 404, 409, 429, 503])
    await withFetch(Response.json({ message: 'private-peer-config-value' }, { status }), async () => {
      try {
        await readClusterSync();
        throw new Error('Expected failure');
      } catch (error) {
        expect((error as Error).message).not.toContain('private-peer');
      }
    });
});
