import { type } from 'arktype';

export const appMigrationLedgerSchema = type({
  baselined: 'boolean',
  migrationIds: type('string')
    .narrow((value) => /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value))
    .array()
    .atMostLength(300)
    .narrow((ids) => new Set(ids).size === ids.length),
})
  .narrow((ledger) => ledger.baselined || ledger.migrationIds.length === 0)
  .onUndeclaredKey('reject');

export type AppMigrationLedger = typeof appMigrationLedgerSchema.infer;
