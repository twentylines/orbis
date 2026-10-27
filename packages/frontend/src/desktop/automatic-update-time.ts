import type { AutomaticUpdateSettings } from './automatic-updates-api';

export type UpdateTimeFormat = '12h' | '24h';
export type UpdateTimePeriod = 'AM' | 'PM';
export type UpdateTimeFields = { hour: string; minute: string; period: UpdateTimePeriod };
export type UpdateTimeField = 'hour' | 'minute';

const pad = (value: number) => String(value).padStart(2, '0');
const canonical = (hour: number, minute: number) => (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? `${pad(hour)}:${pad(minute)}` : null);

export function parseWholeUpdateTime(input: string): string | null {
  if (input.length > 16) return null;
  const value = input.trim();
  const period = /^(\d{1,2})(?::?(\d{2}))? *(am|pm)$/i.exec(value);
  if (period) {
    const hour = Number(period[1]);
    const minute = Number(period[2] ?? '0');
    if (hour < 1 || hour > 12) return null;
    return canonical((hour % 12) + (period[3]?.toLowerCase() === 'pm' ? 12 : 0), minute);
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (clock) return canonical(Number(clock[1]), Number(clock[2]));
  if (/^\d{4}$/.test(value)) return canonical(Number(value.slice(0, 2)), Number(value.slice(2)));
  return null;
}

export function updateTimeFields(time: string, format: UpdateTimeFormat): UpdateTimeFields {
  if (!/^\d{2}:\d{2}$/.test(time) || parseWholeUpdateTime(time) !== time) throw new Error('Choose a valid daily update time.');
  const hour = Number(time.slice(0, 2));
  return { hour: format === '12h' ? pad(hour % 12 || 12) : pad(hour), minute: time.slice(3), period: hour >= 12 ? 'PM' : 'AM' };
}

export function readUpdateTime(fields: UpdateTimeFields, format: UpdateTimeFormat): string | null {
  const hourText = fields.hour.trim();
  const minuteText = fields.minute.trim();
  if (!/^\d{1,2}$/.test(hourText) || !/^\d{1,2}$/.test(minuteText) || !['AM', 'PM'].includes(fields.period)) return null;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (format === '12h') {
    if (hour < 1 || hour > 12) return null;
    return canonical((hour % 12) + (fields.period === 'PM' ? 12 : 0), minute);
  }
  return canonical(hour, minute);
}

export function editUpdateTime(fields: UpdateTimeFields, field: UpdateTimeField, input: string, format: UpdateTimeFormat): UpdateTimeFields {
  const complete = parseWholeUpdateTime(input);
  return complete ? updateTimeFields(complete, format) : { ...fields, [field]: input };
}

export function applyAutomaticUpdateTime(
  settings: AutomaticUpdateSettings,
  fields: UpdateTimeFields,
  format: UpdateTimeFormat,
): AutomaticUpdateSettings | null {
  const time = readUpdateTime(fields, format);
  return time ? { ...settings, schedule: { ...settings.schedule, time } } : null;
}

export function updateTimeError(format: UpdateTimeFormat) {
  return `Enter an hour from ${format === '12h' ? '1 to 12' : '00 to 23'} and minutes from 00 to 59. You can also enter 1500 or 3:00 PM.`;
}
