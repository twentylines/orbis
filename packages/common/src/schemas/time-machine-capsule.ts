import { type } from 'arktype';
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
export const capsuleJobSchema = type({
  '+': 'reject',
  id: uuid,
  capsuleId: uuid.or('null'),
  kind: "'export' | 'import'",
  status: "'running' | 'ready' | 'awaiting-upload' | 'uploaded' | 'verifying' | 'verified' | 'failed' | 'cancelled'",
  createdAt: 'number.integer > 0',
  completedBytes: 'number.integer >= 0',
  totalBytes: 'number.integer >= 0 | null',
  bytes: 'number.integer >= 0',
  sha256: type('string')
    .narrow((value) => /^[a-f0-9]{64}$/.test(value))
    .or('null'),
  restoreSupported: 'false',
});
export type CapsuleJob = typeof capsuleJobSchema.infer;
export const capsuleListSchema = type({ '+': 'reject', jobs: capsuleJobSchema.array().atMostLength(16) });
