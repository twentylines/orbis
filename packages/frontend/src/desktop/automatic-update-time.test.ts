import { describe, expect, test } from 'bun:test';
import { normaliseDesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import {
  applyAutomaticUpdateTime,
  editUpdateTime,
  parseWholeUpdateTime,
  readUpdateTime,
  updateTimeFields,
  type UpdateTimeFormat,
} from './automatic-update-time';

describe('editable automatic update time', () => {
  test.each([
    ['1500', '15:00'],
    ['0900', '09:00'],
    ['0000', '00:00'],
    ['1200', '12:00'],
    ['2359', '23:59'],
    ['15:00', '15:00'],
    ['9:00', '09:00'],
    ['12am', '00:00'],
    ['12pm', '12:00'],
    ['12:00 AM', '00:00'],
    ['12:00 PM', '12:00'],
    ['3:00 pm', '15:00'],
    ['0300pm', '15:00'],
    [' 0900 ', '09:00'],
  ])('parses a complete clock value %s as %s', (input, expected) => {
    expect(parseWholeUpdateTime(input)).toBe(expected);
  });

  test.each([
    '',
    '150',
    '2400',
    '2500',
    '1260',
    '2360',
    '9999',
    '15:60',
    '24:00',
    '15pm',
    '00am',
    '13:00pm',
    '12:60am',
    '12:0am',
    '-1:00',
    '3.00pm',
    '9e2',
    '０９００',
    '0900\n1200',
    '00001500',
    '9'.repeat(17),
  ])('rejects malformed or out-of-range complete value %s', (input) => expect(parseWholeUpdateTime(input)).toBeNull());

  test.each(['12h', '24h'] as const)('keeps sequential typing intact until all four digits arrive in %s mode', (format) => {
    for (const field of ['hour', 'minute'] as const) {
      let fields = updateTimeFields('09:42', format);
      for (const input of ['1', '15', '150']) {
        fields = editUpdateTime(fields, field, input, format);
        expect(fields[field]).toBe(input);
        expect(fields[field === 'hour' ? 'minute' : 'hour']).toBe(field === 'hour' ? '42' : '09');
      }
      fields = editUpdateTime(fields, field, '1500', format);
      expect(fields).toEqual({ hour: format === '12h' ? '03' : '15', minute: '00', period: 'PM' });
      expect(readUpdateTime(fields, format)).toBe('15:00');
    }
  });

  test.each(['12h', '24h'] as const)('supports pasting complete times into either field in %s mode', (format) => {
    for (const field of ['hour', 'minute'] as const) {
      expect(editUpdateTime(updateTimeFields('15:37', format), field, '0900', format)).toEqual({ hour: '09', minute: '00', period: 'AM' });
      expect(readUpdateTime(editUpdateTime(updateTimeFields('15:37', format), field, '12am', format), format)).toBe('00:00');
      expect(readUpdateTime(editUpdateTime(updateTimeFields('15:37', format), field, '12pm', format), format)).toBe('12:00');
    }
  });

  test('preserves partial and invalid text instead of silently restoring a previously valid time', () => {
    const original = updateTimeFields('15:00', '12h');
    for (const input of ['', '0', '13', '150', '2400', '12:99', 'not a time']) {
      const fields = editUpdateTime(original, 'hour', input, '12h');
      expect(fields.hour).toBe(input);
      expect(readUpdateTime(fields, '12h')).toBeNull();
    }
    expect(original).toEqual({ hour: '03', minute: '00', period: 'PM' });
  });

  test('normalizes single digits on commit and handles midnight/noon and AM/PM changes', () => {
    expect(readUpdateTime({ hour: '3', minute: '7', period: 'PM' }, '12h')).toBe('15:07');
    expect(updateTimeFields('15:07', '12h')).toEqual({ hour: '03', minute: '07', period: 'PM' });
    expect(readUpdateTime({ hour: '12', minute: '00', period: 'AM' }, '12h')).toBe('00:00');
    expect(readUpdateTime({ hour: '12', minute: '00', period: 'PM' }, '12h')).toBe('12:00');
    expect(readUpdateTime({ hour: '0', minute: '7', period: 'PM' }, '24h')).toBe('00:07');
    expect(readUpdateTime({ hour: '24', minute: '00', period: 'AM' }, '24h')).toBeNull();
  });

  test('switches display format without changing any of the 1440 canonical daily times', () => {
    for (let minute = 0; minute < 1440; minute++) {
      const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      for (const format of ['12h', '24h'] as const) expect(readUpdateTime(updateTimeFields(time, format), format)).toBe(time);
    }
  });

  test.each(['12h', '24h'] as UpdateTimeFormat[])('preserves disabled update state and server timezone when applying %s fields', (format) => {
    const settings = { orbis: { enabled: false, mode: 'scheduled' as const }, schedule: { time: '09:00', timezone: 'Asia/Singapore' } };
    const fields = editUpdateTime(updateTimeFields(settings.schedule.time, format), 'hour', '1500', format);
    expect(applyAutomaticUpdateTime(settings, fields, format)).toEqual({ ...settings, schedule: { time: '15:00', timezone: 'Asia/Singapore' } });
    expect(settings.schedule.time).toBe('09:00');
    expect(settings.orbis.enabled).toBe(false);
    expect(applyAutomaticUpdateTime(settings, { ...fields, minute: '99' }, format)).toBeNull();
  });

  test('gives existing account appearances the requested 12-hour default and preserves either saved format', () => {
    expect(normaliseDesktopAppearance().timeFormat).toBe('12h');
    expect(normaliseDesktopAppearance({ textScale: 150 }).timeFormat).toBe('12h');
    expect(normaliseDesktopAppearance({ timeFormat: '24h' }).timeFormat).toBe('24h');
    expect(normaliseDesktopAppearance({ timeFormat: '12h' }).timeFormat).toBe('12h');
  });
});
