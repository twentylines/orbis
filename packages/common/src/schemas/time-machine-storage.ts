import { type } from 'arktype';

const bytes = '0 <= number.integer <= 9007199254740991';
export const timeMachineStorageSchema = type({
  version: '1',
  totalBytes: '0 < number.integer <= 9007199254740991',
  usedBytes: bytes,
  availableBytes: bytes,
  retainedBytes: bytes,
  retainedLimitBytes: bytes,
})
  .onUndeclaredKey('reject')
  .narrow((value) => value.usedBytes <= value.totalBytes && value.availableBytes <= value.totalBytes - value.usedBytes);

export type TimeMachineStorage = typeof timeMachineStorageSchema.infer;
