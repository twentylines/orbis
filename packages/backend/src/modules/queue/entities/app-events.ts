import { Injectable } from '@nestjs/common';
import { arkAppUrn } from '@runtipi/common/types';
import { type } from 'arktype';
import { Queue } from '../queue.entity';

const localSubdomainSchema = type('string').narrow((v, ctx) => (/^[a-zA-Z0-9-]{1,63}$/.test(v) ? true : ctx.mustBe('a valid subdomain')));

const queueAppFormSchema = type({
  port: type('1023 < number < 65536').optional(),
  exposed: 'boolean?',
  exposedLocal: 'boolean?',
  openPort: type('boolean | undefined').optional(),
  domain: 'string | undefined?',
  isVisibleOnGuestDashboard: 'boolean?',
  enableAuth: 'boolean?',
  localSubdomain: localSubdomainSchema.optional(),
  skipEnv: type('boolean | undefined').optional(),
  skipPull: type('boolean | undefined').optional(),
  skipRun: type('boolean | undefined').optional(),
  '[string]': 'unknown',
});

const commonAppCommandSchema = type({
  command: type("'start' | 'stop' | 'install' | 'reset' | 'restart' | 'backup'"),
  appUrn: arkAppUrn,
  form: queueAppFormSchema,
  requestId: 'string.uuid',
  jobVersion: type.unit(1).optional(),
});

const appSettingsCommandSchema = type({
  command: type.unit('generate_env'),
  appUrn: arkAppUrn,
  form: queueAppFormSchema,
  requestId: 'string.uuid',
  settingsBinding: '/^[a-f0-9]{64}$/?',
});

const uninstallAppCommandSchema = type({
  command: type.unit('uninstall'),
  appUrn: arkAppUrn,
  form: queueAppFormSchema,
  requestId: 'string.uuid',
  removeBackups: 'boolean?',
});

const restoreAppCommandSchema = type({
  command: type.unit('restore'),
  appUrn: arkAppUrn,
  filename: 'string',
  form: queueAppFormSchema,
  requestId: 'string.uuid',
});

const updateAppCommandSchema = type({
  command: type.unit('update'),
  appUrn: arkAppUrn,
  form: queueAppFormSchema,
  performBackup: type('boolean').default(true),
  requestId: 'string.uuid',
  jobVersion: type.unit(1).optional(),
});

export const appEventSchema = type.or(
  commonAppCommandSchema,
  appSettingsCommandSchema,
  uninstallAppCommandSchema,
  restoreAppCommandSchema,
  updateAppCommandSchema,
);
export type AppEvent = typeof appEventSchema.infer;

export const appEventResultSchema = type({
  success: 'boolean',
  message: 'string',
  statePreserved: 'boolean?',
  operationBlocked: 'boolean?',
  alreadyCompleted: 'boolean?',
  cancelled: 'boolean?',
  updateStatus: type("'running' | 'stopped'").optional(),
  appStopped: 'boolean?',
});

export type AppEventFormInput = typeof queueAppFormSchema.inferIn;
export type AppEventForm = typeof queueAppFormSchema.infer;

@Injectable()
export class AppEventsQueue extends Queue<typeof appEventSchema, typeof appEventResultSchema> {}
