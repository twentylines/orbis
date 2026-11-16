import { sql } from 'drizzle-orm';
import type { Database } from '@/core/database/database.module';
import { link, user } from '@/core/database/drizzle/schema';
import { assertBackupMaintenanceLease, type BackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { assertResetExportAccess, resetExportPlanSha256, type ResetExportPlan, type SettingsExportAccess } from './settings-export-authorization';

export class ResetSafetyDatabaseCohortError extends Error {
  constructor(readonly code: 'busy' | 'cohort') {
    super(
      code === 'busy'
        ? 'Account data is changing. Try preparing the reset backup again.'
        : 'The reset account list changed. Confirm this reset again.',
    );
  }
}

type Options = {
  database: Pick<Database, 'transaction'>;
  plan: ResetExportPlan;
  access: SettingsExportAccess;
  lease: BackupMaintenanceLease;
  signal: AbortSignal;
};

/** Holds account and link writers through archive preparation; it grants no journal or erasure authority. */
export async function withResetSafetyDatabaseCohort<T>(options: Options, work: () => Promise<T>): Promise<T> {
  const { database, access, lease, signal } = options;
  const plan = structuredClone(options.plan);
  resetExportPlanSha256(plan);
  const expected = [...plan.users].sort((a, b) => a - b);
  const guard = async () => {
    signal.throwIfAborted();
    assertBackupMaintenanceLease(lease);
    await assertResetExportAccess(access, plan);
    signal.throwIfAborted();
    assertBackupMaintenanceLease(lease);
  };
  await guard();
  return database.transaction(
    async (tx) => {
      await guard();
      try {
        await tx.execute(sql`LOCK TABLE ${user}, ${link} IN SHARE MODE NOWAIT`);
      } catch (error) {
        const failure = error as { code?: unknown; cause?: { code?: unknown } } | null;
        if (failure?.code === '55P03' || failure?.cause?.code === '55P03') throw new ResetSafetyDatabaseCohortError('busy');
        throw error;
      }
      await guard();
      const cohort = await tx.select({ id: user.id }).from(user).orderBy(user.id).limit(257);
      if (JSON.stringify(cohort.map((account) => account.id)) !== JSON.stringify(expected)) throw new ResetSafetyDatabaseCohortError('cohort');
      await guard();
      // Await settlement even after cancellation so background preparation cannot outlive its database fence.
      const result = await work();
      await guard();
      return result;
    },
    { isolationLevel: 'read committed', accessMode: 'read write' },
  );
}
