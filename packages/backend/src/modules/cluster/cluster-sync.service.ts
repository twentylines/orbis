import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { type } from 'arktype';
import { enterBackupMutation } from '@/common/backup-maintenance';
import { installationMode } from '@/common/installation-mode';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DesktopPreferencesService, DEFAULT_DESKTOP_PREFERENCES } from '../desktop-preferences/desktop-preferences.service';
import { UnsupportedDesktopPreferencesError } from '../desktop-preferences/desktop-preferences-sync';
import { AutomaticUpdatesService } from '../host-updates/automatic-updates.service';
import { UserRepository } from '../user/user.repository';
import { ClusterStateService, type ClusterState, type ClusterPeer } from './cluster-state.service';
import { clusterRequest, signedHeaders } from './cluster-transport';
import { pairedClusterCertificate } from './cluster-certificate';
import { ClusterSyncStore, syncResultSchema, type SyncPlan, type SyncStoreState } from './cluster-sync.store';
import {
  parseSync,
  projectCustomisation,
  syncCategoryList,
  syncHash,
  syncId,
  syncPeerSchema,
  syncRevision,
  syncRevisionsSchema,
  type SyncCategory,
  type SyncChange,
  type SyncValues,
} from './cluster-sync.schema';

const receivingBody = type({ '+': 'reject', revision: 'number.integer >= 0', categories: syncCategoryList });
const planBody = type({
  '+': 'reject',
  revision: 'number.integer >= 0',
  categories: syncCategoryList,
  automatic: 'boolean',
  expected: syncRevisionsSchema,
});
const runBody = type({ '+': 'reject', revision: 'number.integer >= 0', expected: syncRevisionsSchema });
const peerStatusSchema = type({
  '+': 'reject',
  version: '1',
  hostId: syncId,
  accepted: syncCategoryList,
  revisions: syncRevisionsSchema,
  receipts: {
    '+': 'reject',
    'customisation?': { sourceRevision: syncRevision, at: 'number > 0' },
    'orbis-updates?': { sourceRevision: syncRevision, at: 'number > 0' },
    'app-updates?': { sourceRevision: syncRevision, at: 'number > 0' },
    'schedules?': { sourceRevision: syncRevision, at: 'number > 0' },
  },
});
const appliedSchema = type({ '+': 'reject', version: '1', hostId: syncId, results: syncResultSchema.array().atMostLength(4) });
type Revisions = Partial<Record<SyncCategory, string>>;

@Injectable()
export class ClusterSyncService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private readonly active = new Set<string>();
  private stopped = false;
  constructor(
    private readonly membership: ClusterStateService,
    private readonly store: ClusterSyncStore,
    private readonly preferences: DesktopPreferencesService,
    private readonly automatic: AutomaticUpdatesService,
    private readonly users: UserRepository,
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 60_000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pending;
  }
  private async operator(userId: number) {
    if ((await this.users.getUserDtoById(userId))?.operator !== true)
      throw new ForbiddenException('Choose an active local operator account for settings sync.');
  }
  private assertAvailable() {
    if (this.stopped || this.config.get('demoMode') || installationMode().phase !== 'normal')
      throw new ConflictException('Settings sync is unavailable while this server is changing.');
  }
  private async values(userId: number): Promise<SyncValues & { customisationUnsupported: boolean }> {
    await this.operator(userId);
    let unsupported = false;
    const [preferences, automatic] = await Promise.all([
      this.preferences.readSelected(userId).catch((error) => {
        if (!(error instanceof UnsupportedDesktopPreferencesError)) throw error;
        unsupported = true;
        return DEFAULT_DESKTOP_PREFERENCES;
      }),
      this.automatic.clusterSnapshot(),
    ]);
    return { customisation: projectCustomisation(preferences), ...automatic, customisationUnsupported: unsupported };
  }
  private token(cluster: ClusterState, stored: SyncStoreState, category: SyncCategory, value: unknown) {
    return syncHash({
      version: 1,
      hostId: cluster.id,
      adminId: cluster.admin?.id,
      account: stored.receiving.userId,
      consent: stored.receiving.revision,
      category,
      value,
    });
  }
  private receivingTrust(cluster: ClusterState) {
    return cluster.admin ? syncHash({ sourceId: cluster.admin.id, targetId: cluster.id, secret: cluster.admin.secret }) : null;
  }
  private publicPlan(plan: SyncPlan, userId: number, cluster: ClusterState, peer: ClusterPeer, revisions?: Revisions, values?: SyncValues) {
    const { sourceUserId, source: _source, expected: _expected, trustRevision, ...publicValue } = plan;
    const trustCurrent = trustRevision === syncHash({ sourceId: cluster.id, targetId: peer.id, secret: peer.secret });
    const status =
      !trustCurrent || (revisions && plan.categories.some((category) => plan.expected[category] !== revisions[category]))
        ? 'conflict'
        : values && sourceUserId === userId && plan.categories.some((category) => plan.source[category] !== syncHash(values[category]))
          ? 'idle'
          : plan.status;
    return {
      ...publicValue,
      usesYourAccount: sourceUserId === userId,
      status,
      trustCurrent,
    };
  }
  private send<T>(cluster: ClusterState, peer: ClusterPeer, body: object): Promise<T> {
    return clusterRequest<T>(
      peer.url,
      '/api/cluster/settings-sync/peer',
      body,
      signedHeaders(cluster.id, peer.secret, JSON.stringify(body)),
      peer.insecureLan,
      pairedClusterCertificate(cluster.id, peer),
    );
  }
  private async remoteStatus(cluster: ClusterState, peer: ClusterPeer) {
    const result = parseSync(
      peerStatusSchema,
      await this.send(cluster, peer, { version: 1, action: 'status', sourceId: cluster.id, targetId: peer.id }),
    );
    if (result.hostId !== peer.id) throw new ConflictException('The paired server identity changed.');
    return result;
  }
  async status(userId: number) {
    await this.operator(userId);
    const cluster = await this.membership.read();
    const stored = await this.store.read(cluster.id);
    const receiving = {
      revision: stored.receiving.revision,
      categories: stored.receiving.trustRevision === this.receivingTrust(cluster) ? stored.receiving.categories : [],
      usesYourAccount: stored.receiving.userId === userId,
      configured: stored.receiving.userId !== null && stored.receiving.trustRevision === this.receivingTrust(cluster),
    };
    if (cluster.role !== 'admin') return { version: 1, role: cluster.role, receiving, hosts: [], source: null };
    const values = await this.values(userId);
    const hosts = await Promise.all(
      cluster.peers.map(async (peer) => {
        const plan = stored.plans.find((item) => item.hostId === peer.id);
        try {
          const remote = await this.remoteStatus(cluster, peer);
          return {
            id: peer.id,
            name: peer.name,
            available: true,
            accepted: remote.accepted,
            revisions: remote.revisions,
            receipts: remote.receipts,
            plan: plan ? this.publicPlan(plan, userId, cluster, peer, remote.revisions, values) : null,
          };
        } catch {
          return {
            id: peer.id,
            name: peer.name,
            available: false,
            accepted: [],
            revisions: {},
            receipts: {},
            plan: plan ? this.publicPlan(plan, userId, cluster, peer) : null,
          };
        }
      }),
    );
    return {
      version: 1,
      role: cluster.role,
      receiving,
      hosts,
      source: { orbis: values['orbis-updates'], appCount: values['app-updates'].length, time: values.schedules.time },
    };
  }
  async receiving(userId: number, raw: unknown) {
    this.assertAvailable();
    await this.operator(userId);
    const body = parseSync(receivingBody, raw);
    return this.membership.transaction(async (cluster) => {
      if (cluster.role !== 'member') throw new ForbiddenException('Receiving settings is available only on a paired member server.');
      return this.store.transaction(cluster.id, (stored) => {
        if (stored.receiving.revision !== body.revision) throw new ConflictException('Receiving choices changed. Refresh before saving.');
        stored.receiving = {
          revision: stored.receiving.revision + 1,
          userId: body.categories.length ? userId : null,
          categories: body.categories,
          trustRevision: body.categories.length ? this.receivingTrust(cluster) : null,
        };
        stored.receipts = {};
        stored.revision++;
        return { saved: true };
      });
    });
  }
  async savePlan(userId: number, hostId: string, raw: unknown) {
    this.assertAvailable();
    await this.operator(userId);
    parseSync(syncId, hostId);
    const body = parseSync(planBody, raw);
    const cluster = await this.membership.read();
    if (cluster.role !== 'admin') throw new ForbiddenException('Only the primary admin can sync settings to paired hosts.');
    const peer = cluster.peers.find((item) => item.id === hostId);
    if (!peer) throw new NotFoundException('Paired server not found.');
    if (body.automatic && body.categories.length) {
      const remote = await this.remoteStatus(cluster, peer);
      for (const category of body.categories)
        if (!remote.accepted.includes(category) || !body.expected[category] || body.expected[category] !== remote.revisions[category])
          throw new ConflictException('Receiving choices or target settings changed. Refresh and review this host.');
    }
    await this.store.transaction(cluster.id, (stored) => {
      const previous = stored.plans.find((item) => item.hostId === hostId);
      if ((previous?.revision ?? 0) !== body.revision) throw new ConflictException('Sync choices changed. Refresh before saving.');
      const plan: SyncPlan = {
        hostId,
        sourceUserId: userId,
        trustRevision: syncHash({ sourceId: cluster.id, targetId: peer.id, secret: peer.secret }),
        revision: body.revision + 1,
        categories: body.categories,
        automatic: body.automatic && body.categories.length > 0,
        expected: Object.fromEntries(
          body.categories.filter((category) => body.expected[category]).map((category) => [category, body.expected[category]]),
        ),
        source: {},
        status: body.categories.length ? 'idle' : 'disabled',
        lastAttemptAt: null,
        results: [],
      };
      stored.plans = [...stored.plans.filter((item) => item.hostId !== hostId && cluster.peers.some((peer) => peer.id === item.hostId)), plan];
      stored.revision++;
    });
    return { saved: true };
  }
  async run(userId: number, hostId: string, raw: unknown) {
    this.assertAvailable();
    await this.operator(userId);
    const body = parseSync(runBody, raw);
    const cluster = await this.membership.read();
    if (cluster.role !== 'admin') throw new ForbiddenException('Only the primary admin can sync settings.');
    const stored = await this.store.read(cluster.id);
    const plan = stored.plans.find((item) => item.hostId === hostId);
    if (!plan || plan.revision !== body.revision || plan.sourceUserId !== userId)
      throw new ConflictException('Save and review sync choices using your account before continuing.');
    return this.syncHost(cluster, plan, body.expected);
  }
  private async syncHost(cluster: ClusterState, plan: SyncPlan, rebase?: Revisions) {
    if (this.active.has(plan.hostId)) throw new ConflictException('This host is already syncing settings.');
    this.active.add(plan.hostId);
    let outcome: SyncPlan['status'] = 'unavailable';
    let results: (typeof syncResultSchema.infer)[] = [];
    const nextExpected = { ...plan.expected };
    const nextSource = { ...plan.source };
    try {
      this.assertAvailable();
      if (plan.sourceUserId === null) throw new ConflictException('Save and review sync choices using your account before continuing.');
      const peer = cluster.peers.find((item) => item.id === plan.hostId);
      if (cluster.role !== 'admin' || !peer) throw new ForbiddenException('This host is no longer paired to this admin.');
      if (plan.trustRevision !== syncHash({ sourceId: cluster.id, targetId: peer.id, secret: peer.secret }))
        throw new ConflictException('Pairing changed. Save sync choices again.');
      const [remote, values] = await Promise.all([this.remoteStatus(cluster, peer), this.values(plan.sourceUserId)]);
      const changes: SyncChange[] = [];
      for (const category of plan.categories) {
        if (category === 'customisation' && values.customisationUnsupported) {
          results.push({ category, status: 'unsupported', skippedApps: 0 });
          continue;
        }
        const expected = (rebase ?? plan.expected)[category];
        const sourceRevision = syncHash(values[category]);
        if (!remote.accepted.includes(category)) {
          results.push({ category, status: 'refused', skippedApps: 0 });
          continue;
        }
        if (!expected || expected !== remote.revisions[category]) {
          results.push({ category, status: 'conflict', skippedApps: 0 });
          continue;
        }
        nextExpected[category] = expected;
        if (plan.source[category] === sourceRevision && rebase === undefined) {
          results.push({ category, status: 'unchanged', revision: expected, skippedApps: 0 });
          continue;
        }
        changes.push({ category, expectedRevision: expected, sourceRevision, value: values[category] } as SyncChange);
      }
      if (changes.length) {
        const applied = parseSync(
          appliedSchema,
          await this.send(cluster, peer, { version: 1, action: 'apply', sourceId: cluster.id, targetId: peer.id, changes }),
        );
        if (
          applied.hostId !== peer.id ||
          applied.results.length !== changes.length ||
          changes.some((change) => applied.results.filter((result) => result.category === change.category).length !== 1)
        )
          throw new BadRequestException('The peer returned an invalid sync receipt.');
        results = [...results, ...applied.results];
        for (const result of applied.results)
          if (result.status === 'applied' && result.revision) {
            nextExpected[result.category] = result.revision;
            nextSource[result.category] = syncHash(values[result.category]);
          }
      }
      outcome = results.every((item) => ['applied', 'unchanged'].includes(item.status))
        ? 'synced'
        : results.some((item) => ['applied', 'unchanged'].includes(item.status))
          ? 'partial'
          : 'conflict';
    } catch {
      outcome = 'unavailable';
    }
    try {
      await this.store.transaction(cluster.id, (stored) => {
        const current = stored.plans.find((item) => item.hostId === plan.hostId);
        if (!current || current.revision !== plan.revision) return;
        current.status = outcome;
        current.results = results;
        current.lastAttemptAt = Date.now();
        current.expected = nextExpected;
        current.source = nextSource;
      });
      return { hostId: plan.hostId, status: outcome, results };
    } finally {
      this.active.delete(plan.hostId);
    }
  }
  async peer(headers: Record<string, unknown>, raw: unknown) {
    this.assertAvailable();
    if (!raw || typeof raw !== 'object' || (JSON.stringify(raw)?.length ?? 0) > 128 * 1024)
      throw new BadRequestException('The sync payload exceeded its limit.');
    await this.membership.authorize(headers, raw as object);
    const body = parseSync(syncPeerSchema, raw);
    return this.membership.transaction(async (cluster) => {
      if (cluster.role !== 'member' || cluster.id !== body.targetId || cluster.admin?.id !== body.sourceId)
        throw new ForbiddenException('Settings sync is bound to the paired admin and this exact host.');
      return this.store.transaction(cluster.id, async (stored) => {
        const userId = stored.receiving.userId;
        if (!userId || stored.receiving.trustRevision !== this.receivingTrust(cluster)) {
          if (body.action === 'apply') throw new ForbiddenException('Enable receiving categories on this host first.');
          return { version: 1, hostId: cluster.id, accepted: [], revisions: {}, receipts: {} };
        }
        const values = await this.values(userId);
        const revisions = Object.fromEntries(
          stored.receiving.categories.map((category) => [category, this.token(cluster, stored, category, values[category])]),
        );
        if (body.action === 'status')
          return {
            version: 1,
            hostId: cluster.id,
            accepted: stored.receiving.categories,
            revisions,
            receipts: Object.fromEntries(
              Object.entries(stored.receipts).map(([category, item]) => [category, { sourceRevision: item?.sourceRevision, at: item?.at }]),
            ),
          };
        const results: (typeof syncResultSchema.infer)[] = [];
        const accepted = body.changes.filter((change) => {
          if (change.category === 'customisation' && values.customisationUnsupported) {
            results.push({ category: change.category, status: 'unsupported', skippedApps: 0 });
            return false;
          }
          if (!stored.receiving.categories.includes(change.category)) {
            results.push({ category: change.category, status: 'refused', skippedApps: 0 });
            return false;
          }
          if (change.expectedRevision !== revisions[change.category] || change.sourceRevision !== syncHash(change.value)) {
            results.push({ category: change.category, status: 'conflict', skippedApps: 0 });
            return false;
          }
          return true;
        });
        const customisation = accepted.find((change) => change.category === 'customisation');
        if (customisation?.category === 'customisation') {
          try {
            const expected = syncHash(values.customisation);
            const changed = await this.preferences.updateSelected(userId, (current) => {
              if (syncHash(projectCustomisation(current)) !== expected) throw new ConflictException('Customisation changed locally.');
              return { ...current, ...customisation.value, appearance: { ...current.appearance, ...customisation.value.appearance } };
            });
            values.customisation = projectCustomisation(changed);
            results.push({
              category: 'customisation',
              status: 'applied',
              revision: this.token(cluster, stored, 'customisation', values.customisation),
              skippedApps: 0,
            });
          } catch (error) {
            results.push({
              category: 'customisation',
              status:
                error instanceof UnsupportedDesktopPreferencesError ? 'unsupported' : error instanceof ConflictException ? 'conflict' : 'failed',
              skippedApps: 0,
            });
          }
        }
        const updateChanges = accepted.filter((change) => change.category !== 'customisation');
        if (updateChanges.length) {
          try {
            const changed = await this.automatic.applyClusterSettings(
              Object.fromEntries(updateChanges.map((change) => [change.category, change.value])),
              Object.fromEntries(updateChanges.map((change) => [change.category, syncHash(values[change.category])])),
            );
            for (const change of updateChanges)
              results.push({
                category: change.category,
                status: 'applied',
                revision: this.token(cluster, stored, change.category, changed.values[change.category]),
                skippedApps: changed.skippedApps,
              });
          } catch (error) {
            for (const change of updateChanges)
              results.push({ category: change.category, status: error instanceof ConflictException ? 'conflict' : 'failed', skippedApps: 0 });
          }
        }
        for (const result of results)
          if (result.status === 'applied') {
            const change = body.changes.find((change) => change.category === result.category);
            if (change) stored.receipts[result.category] = { sourceId: body.sourceId, sourceRevision: change.sourceRevision, at: Date.now() };
          }
        return { version: 1, hostId: cluster.id, results };
      });
    });
  }
  tick() {
    if (this.pending || this.stopped) return this.pending ?? Promise.resolve();
    const release = enterBackupMutation();
    if (!release) return Promise.resolve();
    this.pending = (async () => {
      this.assertAvailable();
      const cluster = await this.membership.read();
      if (cluster.role !== 'admin') return;
      const stored = await this.store.read(cluster.id);
      for (const plan of stored.plans)
        if (
          plan.automatic &&
          plan.categories.length &&
          cluster.peers.some((peer) => peer.id === plan.hostId) &&
          !this.active.has(plan.hostId) &&
          !this.stopped
        )
          await this.syncHost(cluster, plan);
    })()
      .catch(() => this.logger.warn('Cluster settings sync needs operator review. No unconfirmed action will be replayed.'))
      .finally(() => {
        release();
        this.pending = undefined;
      });
    return this.pending;
  }
}
