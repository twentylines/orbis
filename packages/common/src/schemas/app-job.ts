import { type } from 'arktype';
import { arkAppUrn } from '../types/app-urn.js';
import { taskPhaseSchema, taskStatusSchema } from './task-history.js';

export const appJobSchema = type({
  requestId: 'string.uuid',
  appUrn: arkAppUrn,
  command: "'backup' | 'update'",
  status: taskStatusSchema,
  phase: taskPhaseSchema.optional(),
  cancellable: 'boolean',
  startedAt: 'number.integer >= 0',
  updatedAt: 'number.integer >= 0',
  message: 'string',
});
export const appJobResponseSchema = type({ job: appJobSchema.or('null') });
export type AppJob = typeof appJobSchema.infer;
