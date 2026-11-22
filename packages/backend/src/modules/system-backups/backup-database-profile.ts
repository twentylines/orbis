import { BackupDatabaseRecordError } from './backup-database-records';

export const backupDatabaseProfileQuery = `SELECT
  pg_catalog.to_regclass('public.app_migration') IS NOT NULL AS has_ledger,
  (SELECT count(*)::integer FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.app')
    AND attname='migrations_baselined' AND NOT attisdropped) AS baseline_columns,
  (SELECT count(*)::integer FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.app')
    AND attname='migrations_baselined' AND NOT attisdropped AND attnum>0 AND attnotnull AND atttypid='pg_catalog.bool'::pg_catalog.regtype) AS boolean_baseline,
  (SELECT count(*)::integer FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('public.app_migration')
    AND contype='f' AND confrelid=pg_catalog.to_regclass('public.app') AND confdeltype='c' AND convalidated
    AND conkey=ARRAY[1::smallint]
    AND confkey=ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.app') AND attname='id')]) AS ledger_cascade,
  (SELECT count(*)::integer FROM pg_catalog.pg_constraint WHERE conrelid=pg_catalog.to_regclass('public.app_migration')
    AND contype='p' AND conkey=ARRAY[1::smallint,2::smallint] AND convalidated AND NOT condeferrable
    AND (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid=conrelid AND attnum>0 AND NOT attisdropped)=2
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=conrelid AND attnum=1 AND attname='app_id'
      AND atttypid='pg_catalog.int4'::pg_catalog.regtype AND attnotnull)
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=conrelid AND attnum=2 AND attname='migration_id'
      AND atttypid='pg_catalog.varchar'::pg_catalog.regtype AND atttypmod=132 AND attnotnull)) AS ledger_key`;

export function readBackupDatabaseProfile(value: unknown): 1 | 2 {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (row.has_ledger === false && row.baseline_columns === 0 && row.boolean_baseline === 0 && row.ledger_cascade === 0 && row.ledger_key === 0)
      return 1;
    if (row.has_ledger === true && row.baseline_columns === 1 && row.boolean_baseline === 1 && row.ledger_cascade === 1 && row.ledger_key === 1)
      return 2;
  }
  throw new BackupDatabaseRecordError('schema');
}
