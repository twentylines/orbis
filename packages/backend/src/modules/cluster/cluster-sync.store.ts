import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { type } from 'arktype';
import { ConfigurationService } from '@/core/config/configuration.service';
import { syncCategoryList, syncCategorySchema, syncId, syncRevision, syncRevisionsSchema } from './cluster-sync.schema';

export const syncResultSchema = type({
  '+': 'reject',
  category: syncCategorySchema,
  status: "'applied' | 'unchanged' | 'conflict' | 'refused' | 'failed' | 'unsupported'",
  'revision?': syncRevision,
  skippedApps: 'number.integer >= 0 & number <= 256',
});
export const syncPlanSchema = type({
  '+': 'reject',
  hostId: syncId,
  sourceUserId: 'number.integer > 0 | null',
  trustRevision: syncRevision.or('null'),
  revision: 'number.integer >= 0',
  categories: syncCategoryList,
  automatic: 'boolean',
  expected: syncRevisionsSchema,
  source: syncRevisionsSchema,
  status: "'idle' | 'synced' | 'conflict' | 'partial' | 'unavailable' | 'disabled'",
  lastAttemptAt: 'number >= 0 | null',
  results: syncResultSchema.array().atMostLength(4),
}).narrow((plan) => (plan.sourceUserId === null) === (plan.trustRevision === null) && (plan.sourceUserId !== null || !plan.automatic));
const receipt = type({ '+': 'reject', sourceId: syncId, sourceRevision: syncRevision, at: 'number > 0' });
const stored = type({
  '+': 'reject',
  version: '1',
  hostId: syncId,
  revision: 'number.integer >= 0',
  receiving: {
    '+': 'reject',
    revision: 'number.integer >= 0',
    userId: 'number.integer > 0 | null',
    categories: syncCategoryList,
    trustRevision: syncRevision.or('null'),
  },
  plans: syncPlanSchema.array().atMostLength(12),
  receipts: { '+': 'reject', 'customisation?': receipt, 'orbis-updates?': receipt, 'app-updates?': receipt, 'schedules?': receipt },
});
export type SyncPlan = typeof syncPlanSchema.infer;
export type SyncStoreState = typeof stored.infer;

const restoreSyncFailure = () => new ConflictException('Destination settings sync needs review before restoring. No server data has been changed.');

export function restoreDestinationSyncSettings(input: Uint8Array | undefined, expectedHostId: string | undefined): Uint8Array | undefined {
  if (input === undefined) return undefined;
  try {
    if (!(input instanceof Uint8Array) || input.byteLength > 128 * 1024 || !syncId.allows(expectedHostId)) throw restoreSyncFailure();
    const parsed = stored(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)));
    if (parsed instanceof type.errors || parsed.hostId !== expectedHostId) throw restoreSyncFailure();
    const nextRevision = (revision: number) => {
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER - 1) throw restoreSyncFailure();
      return revision + 1;
    };
    if (
      new Set(parsed.plans.map((plan) => plan.hostId)).size !== parsed.plans.length ||
      parsed.plans.some((plan) => plan.hostId === expectedHostId) ||
      (parsed.receiving.userId !== null && !Number.isSafeInteger(parsed.receiving.userId)) ||
      Object.values(parsed.receipts).some((receipt) => receipt && !Number.isSafeInteger(receipt.at))
    )
      throw restoreSyncFailure();
    const state: SyncStoreState = {
      ...parsed,
      revision: nextRevision(parsed.revision),
      receiving: { revision: nextRevision(parsed.receiving.revision), userId: null, categories: [], trustRevision: null },
      plans: parsed.plans.map((plan) => {
        if (
          (plan.sourceUserId !== null && !Number.isSafeInteger(plan.sourceUserId)) ||
          (plan.lastAttemptAt !== null && (!Number.isSafeInteger(plan.lastAttemptAt) || plan.lastAttemptAt < 0))
        )
          throw restoreSyncFailure();
        return {
          ...plan,
          sourceUserId: null,
          trustRevision: null,
          revision: nextRevision(plan.revision),
          automatic: false,
          expected: {},
          source: {},
          status: 'disabled',
          lastAttemptAt: null,
          results: [],
        };
      }),
      receipts: {},
    };
    const validated = stored(state);
    if (validated instanceof type.errors) throw restoreSyncFailure();
    const output = Buffer.from(`${JSON.stringify(validated)}\n`);
    if (output.byteLength > 128 * 1024) throw restoreSyncFailure();
    return output;
  } catch {
    throw restoreSyncFailure();
  }
}

@Injectable()
export class ClusterSyncStore {
  private queue: Promise<unknown> = Promise.resolve();
  private cached?: SyncStoreState;
  constructor(private readonly config: ConfigurationService) {}
  private directory() {
    return path.join(this.config.get('directories').dataDir, 'state', 'cluster-sync');
  }
  private async load(hostId: string): Promise<SyncStoreState> {
    const file = path.join(this.directory(), 'settings.json');
    try {
      const parent = await fs.lstat(this.directory());
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077 || (process.getuid && parent.uid !== process.getuid()))
        throw new Error('Unsafe sync directory');
      const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 128 * 1024 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
          throw new Error('Unsafe sync state');
        const result = stored(JSON.parse(await handle.readFile('utf8')));
        if (result instanceof type.errors || result.hostId !== hostId) throw new Error('Invalid sync state');
        return result;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          version: 1,
          hostId,
          revision: 0,
          receiving: { revision: 0, userId: null, categories: [], trustRevision: null },
          plans: [],
          receipts: {},
        };
      throw new ConflictException('Settings sync storage needs local operator review. No settings were sent.');
    }
  }
  transaction<T>(hostId: string, operation: (state: SyncStoreState) => Promise<T> | T): Promise<T> {
    const pending = this.queue
      .catch(() => undefined)
      .then(async () => {
        const current = this.cached ?? (await this.load(hostId));
        if (current.hostId !== hostId) throw new ConflictException('Server identity changed. Review local settings sync configuration.');
        const state = structuredClone(current);
        const result = await operation(state);
        if (JSON.stringify(state) === JSON.stringify(current)) {
          this.cached = current;
          return result;
        }
        const validated = stored(state);
        if (validated instanceof type.errors) throw new ConflictException('Settings sync state could not be saved safely.');
        await fs.mkdir(this.directory(), { recursive: true, mode: 0o700 });
        const directory = await fs.lstat(this.directory());
        if (
          !directory.isDirectory() ||
          directory.isSymbolicLink() ||
          directory.mode & 0o077 ||
          (process.getuid && directory.uid !== process.getuid())
        )
          throw new ConflictException('Settings sync storage needs local operator review.');
        const temporary = path.join(this.directory(), `.${randomUUID()}.tmp`);
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(`${JSON.stringify(state)}\n`);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fs.rename(temporary, path.join(this.directory(), 'settings.json'));
          const parent = await fs.open(this.directory(), 'r');
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } finally {
          await fs.rm(temporary, { force: true });
        }
        this.cached = structuredClone(state);
        return result;
      });
    this.queue = pending;
    return pending;
  }
  read(hostId: string) {
    return this.transaction(hostId, (state) => structuredClone(state));
  }
}
