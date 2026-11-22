import { type } from 'arktype';
import { arkAppUrn } from '@runtipi/common/types';

const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const migrationIds = type('string')
  .narrow((value) => /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value))
  .array()
  .atMostLength(300);
export const existingBaselineBindingSchema = type({
  schema: "'orbis.existing-app-baseline.v1'",
  requestId: uuid,
  stageId: uuid,
  appUrn: arkAppUrn,
  appId: 'number.integer > 0 & number <= 2147483647',
  appCreatedAt: '0 <= number.integer <= 2147483647',
  version: '0 <= number.integer <= 2147483647',
  requestInputSha256: hash,
  authoritySha256: hash,
  metadataSha256: hash,
  storageSha256: hash,
  configurationSha256: hash,
  migrationIds,
  originalContainers: type({
    id: hash,
    imageId: type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value)),
    service: type('string').narrow((value) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)),
    configSha256: hash,
    mountsSha256: hash,
    startedAt: 'string > 0 & string <= 128',
    running: 'boolean',
    paused: 'boolean',
    restarting: 'boolean',
  })
    .onUndeclaredKey('reject')
    .array()
    .atLeastLength(1)
    .atMostLength(256),
})
  .onUndeclaredKey('reject')
  .narrow(
    (value) =>
      new Set(value.migrationIds).size === value.migrationIds.length &&
      JSON.stringify(value.migrationIds) === JSON.stringify([...value.migrationIds].sort()) &&
      new Set(value.originalContainers.map(({ id }) => id)).size === value.originalContainers.length &&
      JSON.stringify(value.originalContainers.map(({ id }) => id)) === JSON.stringify(value.originalContainers.map(({ id }) => id).sort()),
  );
export type ExistingBaselineBinding = typeof existingBaselineBindingSchema.infer;
export const existingBaselineStateSchema = type({ phase: "'intent' | 'confirmed'", binding: existingBaselineBindingSchema }).onUndeclaredKey(
  'reject',
);
export type ExistingBaselineState = typeof existingBaselineStateSchema.infer;
export const existingBaselineFailure = () =>
  new Error('The installed app migration starting point could not be verified. Its existing data was kept.');
