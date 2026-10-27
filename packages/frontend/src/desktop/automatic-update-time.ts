import type { AppUpdateRule, AutomaticUpdateSettings } from './automatic-updates-api';
import {
  validTime,
  readTimeFields,
  parseTimeText,
  timeFields,
  editTimeFields,
  timeFieldError,
  type TimeFields,
  type TimeFormat,
  type TimePeriod,
  type TimePart,
} from '@/components/ui/TimeField/time-field';
export const parseWholeUpdateTime = parseTimeText;
export const updateTimeFields = timeFields;
export const readUpdateTime = readTimeFields;
export const editUpdateTime = editTimeFields;
export const updateTimeError = timeFieldError;
export type UpdateTimeFormat = TimeFormat;
export type UpdateTimePeriod = TimePeriod;
export type UpdateTimeFields = TimeFields;
export type UpdateTimeField = TimePart;

export function applyAutomaticUpdateTime(
  settings: AutomaticUpdateSettings,
  fields: UpdateTimeFields,
  format: UpdateTimeFormat,
): AutomaticUpdateSettings | null {
  const time = readUpdateTime(fields, format);
  return time ? { ...settings, schedule: { ...settings.schedule, time } } : null;
}

export function appUpdateRuleForSave(rule: AppUpdateRule): AppUpdateRule | null {
  return rule.mode !== 'custom' || validTime(rule.time) ? rule : null;
}

export function appUpdateModeDraft(rule: AppUpdateRule, remembered: string | null | undefined, shared: string, mode: AppUpdateRule['mode']) {
  const time = remembered === undefined && rule.mode === 'custom' ? (validTime(rule.time) ? rule.time : null) : remembered;
  return {
    remembered: time,
    rule: mode === 'custom' ? { mode, time: time === undefined ? shared : (time ?? '') } : { mode },
  };
}

export function automaticUpdateSettingsForSave(settings: AutomaticUpdateSettings): AutomaticUpdateSettings | null {
  return validTime(settings.schedule.time) ? settings : null;
}
