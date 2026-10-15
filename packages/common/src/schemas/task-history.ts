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
  action: taskActionSchema,
  status: taskStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.or('null'),
  finishedAt: timestamp.or('null'),
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
