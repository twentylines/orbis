import fs from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type } from 'arktype';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { ClusterSyncController } from './cluster-sync.controller';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { DesktopPreferencesService, DEFAULT_DESKTOP_PREFERENCES } from '../desktop-preferences/desktop-preferences.service';
import { AutomaticUpdatesService } from '../host-updates/automatic-updates.service';
import { ClusterStateService } from './cluster-state.service';
import { ClusterSyncService } from './cluster-sync.service';
import { ClusterSyncStore, restoreDestinationSyncSettings } from './cluster-sync.store';
import { customisationSchema, projectCustomisation, syncHash, syncPeerSchema, type SyncCategory } from './cluster-sync.schema';
import { clusterRequest, CLUSTER_PROTOCOL, signedHeaders } from './cluster-transport';

vi.mock('./cluster-transport', async (original) => ({ ...(await original<typeof import('./cluster-transport')>()), clusterRequest: vi.fn() }));
let root: string;
let source: ClusterSyncService;
let target: ClusterSyncService;
let sourceState: ClusterStateService;
let targetState: ClusterStateService;
let sourcePrefs: DesktopPreferencesService;
let targetPrefs: DesktopPreferencesService;
let sourceUpdates: AutomaticUpdatesService;
let targetUpdates: AutomaticUpdatesService;
let sourceStore: ClusterSyncStore;
let targetStore: ClusterSyncStore;
let sourceConfig: ConfigurationService;
let targetConfig: ConfigurationService;
let sourceId: string;
let targetId: string;
const pairingSecret = '1'.repeat(64);
const categories: SyncCategory[] = ['customisation', 'orbis-updates', 'app-updates', 'schedules'];
const users = { getUserDtoById: vi.fn(async (id: number) => ({ id, operator: id === 1 || id === 2 })) };
const logger = { warn: vi.fn() };
const lifecycle = { updateApp: vi.fn() };
const host = { apply: vi.fn(), plan: vi.fn(), packageApply: vi.fn(), packageRefresh: vi.fn() };
const sourceApps = { getApps: vi.fn(), getAppByUrn: vi.fn() };
const targetApps = { getApps: vi.fn(), getAppByUrn: vi.fn() };
function config(directory: string, timezone: string): ConfigurationService {
  return {
    get: (key: string) =>
      key === 'directories'
        ? { dataDir: directory }
        : key === 'userSettings'
          ? { localDomain: 'fixture.local', timeZone: timezone }
          : key === 'demoMode'
            ? false
            : undefined,
  } as unknown as ConfigurationService;
}
function updates(configuration: ConfigurationService, apps: typeof targetApps) {
  return new AutomaticUpdatesService(
    ...([configuration, host, {}, {}, apps, {}, lifecycle, logger, {}] as unknown as ConstructorParameters<typeof AutomaticUpdatesService>),
  );
}
function service(
  state: ClusterStateService,
  store: ClusterSyncStore,
  preferences: DesktopPreferencesService,
  automatic: AutomaticUpdatesService,
  configuration: ConfigurationService,
) {
  return new ClusterSyncService(
    ...([state, store, preferences, automatic, users, configuration, logger] as unknown as ConstructorParameters<typeof ClusterSyncService>),
  );
}
beforeEach(async () => {
  vi.clearAllMocks();
  users.getUserDtoById.mockImplementation(async (id: number) => ({ id, operator: id === 1 || id === 2 }));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-cluster-sync-'));
  sourceConfig = config(path.join(root, 'source'), 'UTC');
  targetConfig = config(path.join(root, 'target'), 'Asia/Singapore');
  sourceState = new ClusterStateService(sourceConfig);
  targetState = new ClusterStateService(targetConfig);
  await sourceState.create('Fixture cluster', 'Original identity');
  sourceId = (await sourceState.read()).id;
  targetId = (await targetState.read()).id;
  const invite = await targetState.invite();
  await targetState.accept({
    protocol: CLUSTER_PROTOCOL,
    code: invite.code,
    adminId: sourceId,
    adminName: 'Original identity',
    clusterName: 'Fixture cluster',
    secret: pairingSecret,
  });
  await sourceState.transaction((state) => {
    state.peers.push({ id: targetId, name: 'Receiving host', url: 'https://192.168.40.20', secret: pairingSecret, insecureLan: false });
  });
  sourcePrefs = new DesktopPreferencesService(sourceConfig);
  targetPrefs = new DesktopPreferencesService(targetConfig);
  await sourcePrefs.write(1, {
    ...DEFAULT_DESKTOP_PREFERENCES,
    serverName: 'Private source identity',
    preset: 'forest',
    appearance: { accent: '#123456', wallpaperImage: 'a'.repeat(64), dockPins: ['source-only:store'] },
  });
  await targetPrefs.write(2, {
    ...DEFAULT_DESKTOP_PREFERENCES,
    serverName: 'Preserved target identity',
    appearance: { wallpaperImage: 'b'.repeat(64), dockPins: ['target-only:store'] },
  });
  await targetPrefs.write(1, { ...DEFAULT_DESKTOP_PREFERENCES, serverName: 'Other local account', preset: 'blush' });
  sourceApps.getApps.mockResolvedValue([
    { appName: 'shared', appStoreSlug: 'store', config: { PASSWORD: 'private-app-config-sentinel' } },
    { appName: 'absent', appStoreSlug: 'store' },
    { appName: 'local', appStoreSlug: '_user' },
  ]);
  targetApps.getApps.mockResolvedValue([
    { appName: 'shared', appStoreSlug: 'store' },
    { appName: 'shared', appStoreSlug: 'different-store' },
  ]);
  sourceApps.getAppByUrn.mockResolvedValue({});
  targetApps.getAppByUrn.mockResolvedValue({});
  sourceUpdates = updates(sourceConfig, sourceApps);
  targetUpdates = updates(targetConfig, targetApps);
  sourceStore = new ClusterSyncStore(sourceConfig);
  targetStore = new ClusterSyncStore(targetConfig);
  source = service(sourceState, sourceStore, sourcePrefs, sourceUpdates, sourceConfig);
  target = service(targetState, targetStore, targetPrefs, targetUpdates, targetConfig);
  vi.mocked(clusterRequest).mockImplementation(async (_origin, _endpoint, body, headers) => target.peer(headers ?? {}, body));
});
afterEach(async () => {
  await source?.onModuleDestroy();
  await target?.onModuleDestroy();
  sourceUpdates?.onModuleDestroy();
  targetUpdates?.onModuleDestroy();
  await fs.rm(root, { recursive: true, force: true });
});
async function optIn(selected: SyncCategory[] = categories, automatic = false) {
  await target.receiving(2, { revision: 0, categories: selected });
  const status = await source.status(1);
  const remote = status.hosts[0];
  if (!remote) throw new Error('Expected the paired host');
  await source.savePlan(1, targetId, { revision: 0, categories: selected, automatic, expected: remote.revisions });
  return remote.revisions;
}
async function run(expected: Record<string, string>) {
  return source.run(1, targetId, { revision: 1, expected });
}

it('pairing never opts in, exports account secrets or applies settings implicitly', async () => {
  const before = await targetPrefs.read(2);
  const status = await source.status(1);
  expect(status.hosts[0]?.accepted).toEqual([]);
  await source.tick();
  expect(await targetPrefs.read(2)).toEqual(before);
  expect(JSON.stringify(status)).not.toContain(pairingSecret);
  expect(JSON.stringify(vi.mocked(clusterRequest).mock.calls)).not.toContain('private-app-config-sentinel');
  await expect(source.savePlan(1, targetId, { revision: 0, categories: ['customisation'], automatic: true, expected: {} })).rejects.toThrow(
    'Receiving choices',
  );
});
it('persists selected customisation for the bound receiving account while retaining host identity, private wallpaper and pins', async () => {
  const expected = await optIn(['customisation']);
  const membershipBefore = await targetState.describe();
  const otherAccount = await targetPrefs.read(1);
  expect((await run(expected)).status).toBe('synced');
  const reloaded = await new DesktopPreferencesService(targetConfig).read(2);
  expect(reloaded).toMatchObject({
    preset: 'forest',
    serverName: 'Preserved target identity',
    appearance: { accent: '#123456', wallpaperImage: 'b'.repeat(64), dockPins: ['target-only:store'] },
  });
  expect(await targetPrefs.read(1)).toEqual(otherAccount);
  expect(await targetState.describe()).toEqual(membershipBefore);
  const payload = JSON.stringify(
    vi
      .mocked(clusterRequest)
      .mock.calls.filter((call) => (call[2] as { action?: string }).action === 'apply')
      .map((call) => call[2]),
  );
  for (const excluded of [
    'serverName',
    'wallpaperImage',
    'dockPins',
    'password',
    'passkey',
    'Private source identity',
    'private-app-config-sentinel',
  ])
    expect(payload).not.toContain(excluded);
  expect((await new ClusterSyncStore(sourceConfig).read(sourceId)).plans[0]?.categories).toEqual(['customisation']);
});
it('syncs Orbis policy without changing daily time or target timezone and never invokes an update operation', async () => {
  await sourceUpdates.update({ orbis: { enabled: true, mode: 'idle' }, schedule: { time: '06:15', timezone: 'UTC' } });
  await targetUpdates.update({ orbis: { enabled: false, mode: 'scheduled' }, schedule: { time: '23:45', timezone: 'Asia/Singapore' } });
  const expected = await optIn(['orbis-updates']);
  expect((await run(expected)).status).toBe('synced');
  expect((await targetUpdates.read()).settings).toEqual({
    orbis: { enabled: true, mode: 'idle' },
    schedule: { time: '23:45', timezone: 'Asia/Singapore' },
  });
  expect(lifecycle.updateApp).not.toHaveBeenCalled();
  expect(host.apply).not.toHaveBeenCalled();
  expect(host.packageApply).not.toHaveBeenCalled();
});
it('matches exact app-store URNs and retains local custom timing when schedules are not selected', async () => {
  await sourceUpdates.updateApp('shared:store', { mode: 'global' });
  await targetUpdates.updateApp('shared:store', { mode: 'custom', time: '22:15' });
  await targetUpdates.updateApp('shared:different-store', { mode: 'custom', time: '17:30' });
  const expected = await optIn(['app-updates']);
  expect((await run(expected)).status).toBe('synced');
  expect((await targetUpdates.readApp('shared:store')).rule).toEqual({ mode: 'custom', time: '22:15' });
  expect((await targetUpdates.readApp('shared:different-store')).rule).toEqual({ mode: 'custom', time: '17:30' });
  expect(lifecycle.updateApp).not.toHaveBeenCalled();
});
it('copies selected timing without enabling disabled apps, copying timezone or installing missing apps', async () => {
  await sourceUpdates.update({ orbis: { enabled: false, mode: 'scheduled' }, schedule: { time: '06:15', timezone: 'UTC' } });
  await sourceUpdates.updateApp('shared:store', { mode: 'custom', time: '07:30' });
  const expected = await optIn(['schedules']);
  expect((await run(expected)).status).toBe('synced');
  expect((await targetUpdates.read()).settings.schedule).toEqual({ time: '06:15', timezone: 'Asia/Singapore' });
  expect((await targetUpdates.readApp('shared:store')).rule).toEqual({ mode: 'disabled' });
  expect(lifecycle.updateApp).not.toHaveBeenCalled();
});
it('applies combined app policy and custom timing in one queued write after validating both baselines', async () => {
  await sourceUpdates.updateApp('shared:store', { mode: 'custom', time: '07:30' });
  const expected = await optIn(['app-updates', 'schedules']);
  expect((await run(expected)).status).toBe('synced');
  expect((await targetUpdates.readApp('shared:store')).rule).toEqual({ mode: 'custom', time: '07:30' });
});
it('rejects stale target revisions, then permits explicit reviewed retry using fresh revisions', async () => {
  const expected = await optIn(['customisation']);
  await targetPrefs.write(2, { ...(await targetPrefs.read(2)), preset: 'ocean' });
  expect((await run(expected)).status).toBe('conflict');
  expect((await targetPrefs.read(2)).preset).toBe('ocean');
  const fresh = (await source.status(1)).hosts[0]?.revisions;
  expect((await run(fresh ?? {})).status).toBe('synced');
  expect((await targetPrefs.read(2)).preset).toBe('forest');
});
it('stops automatic sync at local conflicts and sends only changed opted-in source categories', async () => {
  await optIn(['customisation'], true);
  await source.tick();
  expect((await targetPrefs.read(2)).preset).toBe('forest');
  const count = vi.mocked(clusterRequest).mock.calls.filter((call) => (call[2] as { action?: string }).action === 'apply').length;
  await source.tick();
  expect(vi.mocked(clusterRequest).mock.calls.filter((call) => (call[2] as { action?: string }).action === 'apply')).toHaveLength(count);
  await targetPrefs.write(2, { ...(await targetPrefs.read(2)), preset: 'ocean' });
  await sourcePrefs.write(1, { ...(await sourcePrefs.read(1)), preset: 'stone' });
  await source.tick();
  expect((await targetPrefs.read(2)).preset).toBe('ocean');
  expect((await sourceStore.read(sourceId)).plans[0]?.status).toBe('conflict');
});
it('reports unavailable peers without claiming success or leaking upstream errors and can disable offline sync', async () => {
  await optIn(['customisation'], true);
  vi.mocked(clusterRequest).mockRejectedValue(new Error('private-upstream-message'));
  const result = await run({ customisation: 'a'.repeat(64) });
  expect(result.status).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('private-upstream');
  await source.savePlan(1, targetId, { revision: 1, categories: [], automatic: false, expected: {} });
  expect((await sourceStore.read(sourceId)).plans[0]?.automatic).toBe(false);
});
it('binds signed requests to paired source/target identities, prevents replay and refuses non-member/user authority', async () => {
  await target.receiving(2, { revision: 0, categories: ['customisation'] });
  const body = { version: 1, action: 'status', sourceId, targetId };
  await expect(target.peer({}, body)).rejects.toThrow('signature');
  const headers = signedHeaders(sourceId, pairingSecret, JSON.stringify(body));
  await target.peer(headers, body);
  await expect(target.peer(headers, body)).rejects.toThrow('already been used');
  const wrongTarget = { ...body, targetId: sourceId };
  await expect(target.peer(signedHeaders(sourceId, pairingSecret, JSON.stringify(wrongTarget)), wrongTarget)).rejects.toThrow('exact host');
  await expect(source.receiving(1, { revision: 0, categories: ['customisation'] })).rejects.toThrow('member');
  await expect(source.status(3)).rejects.toThrow('operator');
});
it('rejects unsafe or unsupported payload fields and stale receiving consent without modifying settings', async () => {
  const safe = projectCustomisation(await sourcePrefs.read(1));
  expect(customisationSchema({ ...safe, serverName: 'overwrite-host' })).toBeInstanceOf(type.errors);
  expect(customisationSchema({ ...safe, appearance: { wallpaperImage: 'a'.repeat(64) } })).toBeInstanceOf(type.errors);
  expect(syncPeerSchema({ version: 2, action: 'status', sourceId, targetId })).toBeInstanceOf(type.errors);
  await target.receiving(2, { revision: 0, categories: ['customisation'] });
  await expect(target.receiving(1, { revision: 0, categories: ['customisation'] })).rejects.toThrow('choices changed');
  const reloaded = await new ClusterSyncStore(targetConfig).read(targetId);
  expect(reloaded.receiving.userId).toBe(2);
  expect((await fs.stat(path.join(root, 'target', 'state', 'cluster-sync', 'settings.json'))).mode & 0o777).toBe(0o600);
});

it('requires new receiving consent and primary choices after leaving and pairing again', async () => {
  await optIn(['customisation'], true);
  await targetState.leave();
  const invite = await targetState.invite();
  const rotated = '2'.repeat(64);
  await targetState.accept({
    protocol: CLUSTER_PROTOCOL,
    code: invite.code,
    adminId: sourceId,
    adminName: 'Admin',
    clusterName: 'Fixture cluster',
    secret: rotated,
  });
  await sourceState.transaction((state) => {
    const peer = state.peers.find((item) => item.id === targetId);
    if (peer) peer.secret = rotated;
  });
  await source.tick();
  const status = await source.status(1);
  expect(status.hosts[0]?.accepted).toEqual([]);
  expect(status.hosts[0]?.plan?.trustCurrent).toBe(false);
  expect((await targetPrefs.read(2)).preset).toBe('frost');
});
it('catches a concurrent local desktop write inside the per-user comparison queue', async () => {
  const before = await targetPrefs.read(2);
  const first = targetPrefs.write(2, { ...before, preset: 'ocean' });
  const second = targetPrefs.updateSelected(2, (current) => {
    if (syncHash(projectCustomisation(current)) !== syncHash(projectCustomisation(before))) throw new Error('local conflict');
    return { ...current, preset: 'forest' };
  });
  await first;
  await expect(second).rejects.toThrow('local conflict');
  expect((await targetPrefs.read(2)).preset).toBe('ocean');
});

it('discloses partial results without overwriting a conflicting category', async () => {
  await sourceUpdates.update({ orbis: { enabled: true, mode: 'idle' }, schedule: { time: '06:15', timezone: 'UTC' } });
  const expected = await optIn(['customisation', 'orbis-updates']);
  await targetPrefs.write(2, { ...(await targetPrefs.read(2)), preset: 'ocean' });
  const result = await run(expected);
  expect(result.status).toBe('partial');
  expect(result.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ category: 'customisation', status: 'conflict' }),
      expect.objectContaining({ category: 'orbis-updates', status: 'applied' }),
    ]),
  );
  expect((await targetPrefs.read(2)).preset).toBe('ocean');
  expect((await targetUpdates.read()).settings.orbis.enabled).toBe(true);
});

it('checks all selected policy revisions atomically before writing any update policy', async () => {
  const before = await targetUpdates.clusterSnapshot();
  await targetUpdates.update({ orbis: { enabled: false, mode: 'idle' }, schedule: { time: '22:45', timezone: 'Asia/Singapore' } });
  await expect(
    targetUpdates.applyClusterSettings(
      { 'orbis-updates': { enabled: true, mode: 'idle' }, schedules: { time: '06:15', apps: [] } },
      { 'orbis-updates': syncHash(before['orbis-updates']), schedules: syncHash(before.schedules) },
    ),
  ).rejects.toThrow('changed locally');
  expect((await targetUpdates.read()).settings).toEqual({
    orbis: { enabled: false, mode: 'idle' },
    schedule: { time: '22:45', timezone: 'Asia/Singapore' },
  });
});

it('persists actual same-origin UI API choices and restores them after reload while enforcing operator sessions', async () => {
  await optIn(['customisation']);
  const module = await Test.createTestingModule({
    controllers: [ClusterSyncController],
    providers: [
      AuthGuard,
      HostUpdatesGuard,
      { provide: ClusterSyncService, useValue: source },
      { provide: LoggerService, useValue: { debug: vi.fn() } },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.use((req: Request, _response: Response, next: NextFunction) => {
    const role = req.headers['x-fixture-role'];
    if (typeof role === 'string') {
      req.user = { id: 1, operator: role !== 'viewer' } as Request['user'];
      req.authMethod = role === 'cli' ? 'cli' : 'session';
    }
    next();
  });
  await app.listen(0, '127.0.0.1');
  try {
    const api = () => request(app.getHttpServer());
    const base = '/api/cluster/settings-sync';
    const origin = await app.getUrl();
    await api().get(base).expect(401);
    await api().get(base).set('x-fixture-role', 'viewer').expect(403);
    await api().get(base).set('x-fixture-role', 'cli').expect(403);
    const read = await api().get(base).set('x-fixture-role', 'operator').expect(200);
    expect(read.headers['cache-control']).toBe('no-store');
    const expected = read.body.hosts[0].revisions;
    await api()
      .put(`${base}/plans/${targetId}`)
      .set('x-fixture-role', 'operator')
      .send({ revision: 1, categories: ['customisation'], automatic: true, expected })
      .expect(403);
    await api()
      .put(`${base}/plans/${targetId}`)
      .set('Origin', origin)
      .set('x-fixture-role', 'operator')
      .send({ revision: 1, categories: ['customisation'], automatic: true, expected })
      .expect(200);
    const saved = (await new ClusterSyncStore(sourceConfig).read(sourceId)).plans[0];
    expect(saved).toMatchObject({ categories: ['customisation'], automatic: true, revision: 2, sourceUserId: 1 });
    const reloaded = await api().get(base).set('x-fixture-role', 'operator').expect(200);
    expect(reloaded.body.hosts[0].plan).toMatchObject({ categories: ['customisation'], automatic: true, revision: 2, usesYourAccount: true });
    expect(reloaded.body.hosts[0].plan).not.toHaveProperty('sourceUserId');
    await api()
      .post(`${base}/plans/${targetId}/run`)
      .set('Origin', origin)
      .set('x-fixture-role', 'operator')
      .send({ revision: 2, expected: reloaded.body.hosts[0].revisions })
      .expect(201);
    expect((await new DesktopPreferencesService(targetConfig).read(2)).preset).toBe('forest');
  } finally {
    await app.close();
  }
});

it('preserves untouched raw unknown fields, numeric literals and nested extensions while changing only selected supported values', async () => {
  const file = path.join(root, 'target', 'state', 'desktop', '2.json');
  const unknown = '"futureLocal": { "large":900719925474099312345, "literal":1.000, "escaped":"\\u0061" }';
  const nested = '"futureAppearance": { "local":[ 1,  2 ], "escaped":"\\u003c" }';
  const workspace =
    '"workspace":{"order":["applications","activity","storage","attention"],"hidden":[],"wide":[],"privateExtension":{"exact":1e+12}}';
  const raw = `{\n "serverName":"Unchanged local host", "preset":"frost", "mode":"light", "density":"comfortable", ${unknown}, ${workspace}, "appearance":{"accent":null,${nested},"wallpaperImage":"${'b'.repeat(64)}"}\n}\n`;
  await fs.writeFile(file, raw, { mode: 0o600 });
  const expected = await optIn(['customisation']);
  expect((await run(expected)).status).toBe('synced');
  const after = await fs.readFile(file, 'utf8');
  expect(after).toContain(unknown);
  expect(after).toContain(nested);
  expect(after).toContain(workspace);
  expect(after).toContain('"serverName":"Unchanged local host"');
  expect((await targetPrefs.read(2)).preset).toBe('forest');
  const payload = JSON.stringify(vi.mocked(clusterRequest).mock.calls.map((call) => call[2]));
  expect(payload).not.toContain('futureLocal');
  expect(payload).not.toContain('futureAppearance');
  expect(payload).not.toContain('privateExtension');
});

it('never substitutes default customisation when the primary uses an unsupported schema', async () => {
  const file = path.join(root, 'source', 'state', 'desktop', '1.json');
  const raw = JSON.stringify({ ...DEFAULT_DESKTOP_PREFERENCES, mode: 'future-primary-display', privateExtension: 'local-only-sentinel' });
  await fs.writeFile(file, raw, { mode: 0o600 });
  await sourceUpdates.update({ orbis: { enabled: true, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } });
  const expected = await optIn(['customisation', 'orbis-updates']);
  const result = await run(expected);
  expect(result.status).toBe('partial');
  expect(result.results).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'customisation', status: 'unsupported' })]));
  const payload = JSON.stringify(
    vi
      .mocked(clusterRequest)
      .mock.calls.filter((call) => (call[2] as { action?: string }).action === 'apply')
      .map((call) => call[2]),
  );
  expect(payload).not.toContain('customisation');
  expect(payload).not.toContain('local-only-sentinel');
  expect((await targetPrefs.read(2)).preset).toBe('frost');
  expect(await fs.readFile(file, 'utf8')).toBe(raw);
});

it.each([{ version: 2 }, { schemaVersion: 99 }, { mode: 'future-display-mode' }, { appearance: { dockPlacement: 'above' } }])(
  'fails unsupported local customisation closed without writing raw bytes while other categories report their results: %j',
  async (unsupported) => {
    await sourceUpdates.update({ orbis: { enabled: true, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } });
    const file = path.join(root, 'target', 'state', 'desktop', '2.json');
    const raw = `${JSON.stringify({ ...DEFAULT_DESKTOP_PREFERENCES, serverName: 'Local identity', ...unsupported }, null, 3)}\n`;
    await fs.writeFile(file, raw, { mode: 0o600 });
    const expected = await optIn(['customisation', 'orbis-updates']);
    const result = await run(expected);
    expect(result.status).toBe('partial');
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'customisation', status: 'unsupported' }),
        expect.objectContaining({ category: 'orbis-updates', status: 'applied' }),
      ]),
    );
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
    expect((await targetUpdates.read()).settings.orbis.enabled).toBe(true);
  },
);

async function restoreSyncFile(key: 'source' | 'target', hostId: string) {
  const file = path.join(root, key, 'state', 'cluster-sync', 'settings.json');
  const transformed = restoreDestinationSyncSettings(await fs.readFile(file), hostId);
  if (!transformed) throw Error('Missing restored destination sync state');
  await fs.writeFile(file, transformed, { mode: 0o600 });
  return JSON.parse(Buffer.from(transformed).toString());
}

it('preserves absent destination sync state without creating source plans or a new identity', () => {
  expect(restoreDestinationSyncSettings(undefined, undefined)).toBeUndefined();
  expect(restoreDestinationSyncSettings(undefined, sourceId)).toBeUndefined();
});
it('retains each destination plan intent while clearing all old account and trust grants', async () => {
  await optIn(categories, true);
  const previous = await sourceStore.read(sourceId);
  previous.revision = 8;
  previous.receiving = { revision: 4, userId: 1, categories, trustRevision: 'a'.repeat(64) };
  previous.receipts = { customisation: { sourceId: targetId, sourceRevision: 'b'.repeat(64), at: 100 } };
  const template = previous.plans[0];
  if (!template) throw Error('Missing destination plan');
  previous.plans = (['idle', 'synced', 'conflict', 'partial', 'unavailable', 'disabled'] as const).map((status, index) => ({
    ...template,
    hostId: randomUUID(),
    status,
    revision: index,
    categories: index === 5 ? [] : categories.slice(0, (index % 4) + 1),
    lastAttemptAt: 100,
    source: { customisation: 'c'.repeat(64) },
    results: [{ category: 'customisation', status: 'applied', skippedApps: 0 }],
  }));
  const bytes = Buffer.from(JSON.stringify(previous));
  const snapshot = Buffer.from(bytes);
  const transformed = restoreDestinationSyncSettings(bytes, sourceId);
  expect(bytes).toEqual(snapshot);
  expect(transformed).toEqual(restoreDestinationSyncSettings(snapshot, sourceId));
  if (!transformed) throw Error('Missing transformed state');
  const next = JSON.parse(Buffer.from(transformed).toString());
  expect(next).toMatchObject({
    version: 1,
    hostId: sourceId,
    revision: 9,
    receiving: { revision: 5, userId: null, categories: [], trustRevision: null },
    receipts: {},
  });
  for (const [index, plan] of next.plans.entries()) {
    expect(plan).toMatchObject({
      hostId: previous.plans[index]?.hostId,
      categories: previous.plans[index]?.categories,
      sourceUserId: null,
      trustRevision: null,
      revision: index + 1,
      automatic: false,
      expected: {},
      source: {},
      status: 'disabled',
      lastAttemptAt: null,
      results: [],
    });
  }
});
it.each([
  'host',
  'version',
  'unknown-field',
  'unknown-plan',
  'unknown-receiving',
  'unknown-category',
  'duplicate-peer',
  'self-peer',
  'global-overflow',
  'plan-overflow',
  'reapproval-overflow',
  'receiving-overflow',
  'unsafe-account',
  'half-grant',
  'automatic-null-grant',
  'invalid-json',
  'oversized',
] as const)('refuses unsafe destination sync state before restore: %s', async (kind) => {
  await optIn(['customisation'], true);
  const raw = await sourceStore.read(sourceId);
  const plans: Record<string, unknown>[] = raw.plans.map((plan) => ({ ...plan }));
  const receiving: Record<string, unknown> = { ...raw.receiving };
  const input: Record<string, unknown> = { ...raw, plans, receiving };
  const plan = plans[0];
  if (!plan) throw Error('Missing destination plan');
  if (kind === 'host') input.hostId = randomUUID();
  if (kind === 'version') input.version = 2;
  if (kind === 'unknown-field') input.future = true;
  if (kind === 'unknown-plan') plan.future = true;
  if (kind === 'unknown-receiving') receiving.future = true;
  if (kind === 'unknown-category') plan.categories = ['future'];
  if (kind === 'duplicate-peer') plans.push(structuredClone(plan));
  if (kind === 'self-peer') plan.hostId = sourceId;
  if (kind === 'global-overflow') input.revision = Number.MAX_SAFE_INTEGER;
  if (kind === 'plan-overflow') plan.revision = Number.MAX_SAFE_INTEGER;
  if (kind === 'reapproval-overflow') plan.revision = Number.MAX_SAFE_INTEGER - 1;
  if (kind === 'receiving-overflow') receiving.revision = Number.MAX_SAFE_INTEGER;
  if (kind === 'unsafe-account') plan.sourceUserId = Number.MAX_SAFE_INTEGER + 1;
  if (kind === 'half-grant') plan.sourceUserId = null;
  if (kind === 'automatic-null-grant') {
    plan.sourceUserId = null;
    plan.trustRevision = null;
  }
  const bytes = kind === 'invalid-json' ? Buffer.from('{') : kind === 'oversized' ? Buffer.alloc(128 * 1024 + 1) : Buffer.from(JSON.stringify(input));
  expect(() => restoreDestinationSyncSettings(bytes, sourceId)).toThrow('Destination settings sync needs review');
});
it('refuses present sync state when destination membership is absent or invalid', async () => {
  await optIn(['customisation']);
  const bytes = Buffer.from(JSON.stringify(await sourceStore.read(sourceId)));
  for (const hostId of [undefined, '', 'not-a-host']) expect(() => restoreDestinationSyncSettings(bytes, hostId)).toThrow('needs review');
});
it('requires explicit saving after restore even when the new operator has the same numeric account id', async () => {
  const oldExpected = await optIn(['customisation'], true);
  const restored = await restoreSyncFile('source', sourceId);
  sourceStore = new ClusterSyncStore(sourceConfig);
  source = service(sourceState, sourceStore, sourcePrefs, sourceUpdates, sourceConfig);
  vi.mocked(clusterRequest).mockClear();
  await source.tick();
  await expect(source.run(1, targetId, { revision: restored.plans[0].revision, expected: oldExpected })).rejects.toThrow('Save and review');
  expect(clusterRequest).not.toHaveBeenCalled();
  const status = await source.status(1);
  expect(status.hosts[0]?.plan).toMatchObject({ usesYourAccount: false, trustCurrent: false, automatic: false, categories: ['customisation'] });
  await expect(source.savePlan(1, targetId, { revision: 1, categories: ['customisation'], automatic: false, expected: {} })).rejects.toThrow(
    'changed',
  );
  const remote = status.hosts[0];
  if (!remote) throw Error('Missing paired host status');
  const expected = remote.revisions;
  await source.savePlan(1, targetId, { revision: restored.plans[0].revision, categories: ['customisation'], automatic: true, expected });
  const approved = (await sourceStore.read(sourceId)).plans[0];
  if (!approved) throw Error('Missing approved plan');
  expect(approved.sourceUserId).toBe(1);
  expect(approved.trustRevision).toMatch(/^[a-f0-9]{64}$/);
  expect((await source.run(1, targetId, { revision: approved.revision, expected })).status).toBe('synced');
  expect((await targetPrefs.read(2)).preset).toBe('forest');
});
it('clears receiving consent until the restored operator explicitly chooses an account and categories', async () => {
  const expected = await optIn(['customisation']);
  const restored = await restoreSyncFile('target', targetId);
  targetStore = new ClusterSyncStore(targetConfig);
  target = service(targetState, targetStore, targetPrefs, targetUpdates, targetConfig);
  const before = await targetPrefs.read(2);
  expect((await target.status(2)).receiving).toMatchObject({ configured: false, usesYourAccount: false, categories: [] });
  const body = {
    version: 1,
    action: 'apply',
    sourceId,
    targetId,
    changes: [
      {
        category: 'customisation',
        expectedRevision: expected.customisation,
        sourceRevision: syncHash(projectCustomisation(await sourcePrefs.read(1))),
        value: projectCustomisation(await sourcePrefs.read(1)),
      },
    ],
  };
  await expect(target.peer(signedHeaders(sourceId, pairingSecret, JSON.stringify(body)), body)).rejects.toThrow('Enable receiving');
  expect(await targetPrefs.read(2)).toEqual(before);
  await expect(target.receiving(1, { revision: 1, categories: ['customisation'] })).rejects.toThrow('changed');
  await target.receiving(1, { revision: restored.receiving.revision, categories: ['customisation'] });
  expect((await targetStore.read(targetId)).receiving).toMatchObject({ userId: 1, categories: ['customisation'], trustRevision: expect.any(String) });
});
