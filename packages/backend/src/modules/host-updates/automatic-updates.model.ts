import { type } from 'arktype';
import { BadRequestException } from '@nestjs/common';
import { validateAppUrn } from '@/common/helpers/app-helpers';

const time = type('string').narrow((value) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value));
const timezone = type('string > 0 & string <= 100').narrow((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
});
export const automaticUpdateSettingsSchema = type({
  orbis: type({ enabled: 'boolean', mode: "'idle' | 'scheduled'" }).onUndeclaredKey('reject'),
  schedule: type({ time, timezone }).onUndeclaredKey('reject'),
}).onUndeclaredKey('reject');
export const appUpdateRuleSchema = type({ mode: "'disabled' | 'global' | 'custom'", 'time?': time })
  .onUndeclaredKey('reject')
  .narrow((rule) => (rule.mode === 'custom' ? Boolean(rule.time) : rule.time === undefined));
export type AutomaticUpdateSettings = typeof automaticUpdateSettingsSchema.infer;
export type AppUpdateRule = typeof appUpdateRuleSchema.infer;
const attempt = type({
  slot: 'string > 0 & string <= 180',
  state: "'checking' | 'planning' | 'applying' | 'accepted' | 'complete' | 'failed' | 'deferred' | 'no-update' | 'interrupted'",
  at: 'number.integer >= 0',
  message: 'string <= 300',
  'targetTag?': 'string <= 80',
  'targetVersion?': 'number.integer >= 0',
  'jobId?': 'string <= 120',
}).onUndeclaredKey('reject');
export type AutomaticUpdateAttempt = typeof attempt.infer;
const validKeys = (entries: Record<string, unknown>) =>
  Object.keys(entries).length <= 256 &&
  Object.keys(entries).every((key) => {
    try {
      return key.length <= 180 && Boolean(validateAppUrn(key));
    } catch {
      return false;
    }
  });
export const automaticUpdateStateSchema = type({
  version: '1',
  revision: 'number.integer >= 0',
  settings: automaticUpdateSettingsSchema,
  rules: type({ '[string]': appUpdateRuleSchema }).narrow(validKeys),
  apps: type({ '[string]': attempt }).narrow(validKeys),
  orbis: attempt.or('null'),
  pauseReason: 'string <= 300 | null',
}).onUndeclaredKey('reject');
export type AutomaticUpdateState = typeof automaticUpdateStateSchema.infer;

export function parseAutomaticSettings(raw: unknown): AutomaticUpdateSettings {
  const value = automaticUpdateSettingsSchema(raw);
  if (value instanceof type.errors) throw new BadRequestException('Choose valid automatic update settings, daily time and timezone.');
  return value;
}
export function parseAppUpdateRule(raw: unknown): AppUpdateRule {
  const value = appUpdateRuleSchema(raw);
  if (value instanceof type.errors) throw new BadRequestException('Choose disabled, the global schedule, or a valid custom daily time.');
  return value;
}
export function dailyUpdateSlot(schedule: AutomaticUpdateSettings['schedule'], now: number, idle = false) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: schedule.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (name: string) => parts.find((part) => part.type === name)?.value ?? '';
  const day = `${value('year')}-${value('month')}-${value('day')}`;
  return { key: `${day}/${idle ? 'idle' : schedule.time}/${schedule.timezone}`, due: idle || `${value('hour')}:${value('minute')}` >= schedule.time };
}
