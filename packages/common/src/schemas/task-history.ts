import { type } from 'arktype';
import { arkAppUrn } from '../types/app-urn.js';

export const taskActionSchema = type.enumerated(
  'start',
  'stop',
  'install',
  'uninstall',
  'reset',
  'restart',
  'generate_env',
  'backup',
  'restore',
  'update',
);
export const taskStatusSchema = type.enumerated('queued', 'running', 'succeeded', 'failed', 'interrupted', 'unconfirmed');
const timestamp = type('string').narrow((value) => Number.isFinite(Date.parse(value)));

export const taskRecordSchema = type({
  id: 'string.uuid',
  appUrn: arkAppUrn,
  displayName: type('string').moreThanLength(0).lessThanLength(512).optional(),
  action: taskActionSchema,
  status: taskStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.or('null'),
  finishedAt: timestamp.or('null'),
  attentionRevision: type('number.integer >= 0 & number <= 2147483647').optional(),
});

export const taskHistorySchema = type({
  tasks: taskRecordSchema.array().narrow((tasks) => tasks.length <= 300),
  storage: type.enumerated('persistent', 'unavailable'),
  sampledAt: timestamp,
  retentionDays: '30',
  limit: '300',
});

export type TaskRecord = typeof taskRecordSchema.infer;
export type TaskAction = typeof taskActionSchema.infer;
export type TaskHistory = typeof taskHistorySchema.infer;

export const taskAttentionKey = (task: TaskRecord) =>
  ['failed', 'interrupted', 'unconfirmed'].includes(task.status) ? `${task.id}:${task.status}:${task.attentionRevision ?? 0}` : null;
export const taskAttentionKeysSchema = type('string')
  .narrow((key) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:(failed|interrupted|unconfirmed):(?:0|[1-9]\d{0,9})$/i.test(key))
  .array()
  .atMostLength(4096)
  .narrow((keys) => new Set(keys).size === keys.length);
export const taskAttentionLedgerSchema = type({ version: '1', keys: taskAttentionKeysSchema }).onUndeclaredKey('reject');
