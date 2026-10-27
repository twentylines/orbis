export type TimeFormat = '12h' | '24h';
export type TimePeriod = 'AM' | 'PM';
export type TimeFields = { hour: string; minute: string; period: TimePeriod };
export type TimePart = 'hour' | 'minute';
export type TimeFieldState = { fields: TimeFields; format: TimeFormat; touched: boolean; committed: string | null };

const pad = (value: number) => String(value).padStart(2, '0');
const canonical = (hour: number, minute: number) => (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? `${pad(hour)}:${pad(minute)}` : null);

export function parseTimeText(input: string): string | null {
  if (input.length > 16) return null;
  const value = input.trim();
  const period = /^(\d{1,2})(?::?(\d{2}))? *(am|pm)$/i.exec(value);
  if (period) {
    const hour = Number(period[1]);
    if (hour < 1 || hour > 12) return null;
    return canonical((hour % 12) + (period[3]?.toLowerCase() === 'pm' ? 12 : 0), Number(period[2] ?? '0'));
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (clock) return canonical(Number(clock[1]), Number(clock[2]));
  return /^\d{4}$/.test(value) ? canonical(Number(value.slice(0, 2)), Number(value.slice(2))) : null;
}

export const validTime = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) && parseTimeText(value) === value;

export function timeFields(time: string, format: TimeFormat): TimeFields {
  if (!validTime(time)) throw new Error('Choose a valid time.');
  const hour = Number(time.slice(0, 2));
  return { hour: pad(format === '12h' ? hour % 12 || 12 : hour), minute: time.slice(3), period: hour >= 12 ? 'PM' : 'AM' };
}

export function readTimeFields(fields: TimeFields, format: TimeFormat): string | null {
  const hourText = fields.hour.trim();
  const minuteText = fields.minute.trim();
  if (!/^\d{1,2}$/.test(hourText) || !/^\d{1,2}$/.test(minuteText) || !['AM', 'PM'].includes(fields.period)) return null;
  const hour = Number(hourText);
  if (format === '12h' && (hour < 1 || hour > 12)) return null;
  return canonical(format === '12h' ? (hour % 12) + (fields.period === 'PM' ? 12 : 0) : hour, Number(minuteText));
}

export function editTimeFields(fields: TimeFields, part: TimePart, input: string, format: TimeFormat): TimeFields {
  const complete = parseTimeText(input);
  return complete ? timeFields(complete, format) : { ...fields, [part]: input };
}

export function timeFieldError(format: TimeFormat) {
  return `Enter an hour from ${format === '12h' ? '1 to 12' : '00 to 23'} and minutes from 00 to 59. You can also enter 1500 or 3:00 PM.`;
}

export function createTimeField(value: string | null, format: TimeFormat): TimeFieldState {
  return {
    fields: validTime(value) ? timeFields(value, format) : { hour: value ?? '', minute: '', period: 'AM' },
    format,
    touched: false,
    committed: validTime(value) ? value : null,
  };
}
export function editTimeField(state: TimeFieldState, part: TimePart, input: string): TimeFieldState {
  return {
    ...state,
    fields: editTimeFields(state.fields, part, input, state.format),
    touched: false,
    committed: parseTimeText(input) ?? state.committed,
  };
}
export function finishTimeField(state: TimeFieldState): TimeFieldState {
  const time = readTimeFields(state.fields, state.format);
  return { ...state, touched: true, ...(time ? { fields: timeFields(time, state.format), committed: time } : {}) };
}
export function changeTimeFormat(state: TimeFieldState, format: TimeFormat): TimeFieldState {
  const time = readTimeFields(state.fields, state.format);
  return time ? { ...state, format, fields: timeFields(time, format), committed: time } : { ...state, touched: true };
}
