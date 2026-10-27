import { expect, test } from 'bun:test';
import { changeTimeFormat, createTimeField, editTimeField, finishTimeField, readTimeFields, validTime } from './time-field';

test('both fields retain intermediate text until a complete four-digit value arrives', () => {
  for (const part of ['hour', 'minute'] as const)
    for (const format of ['12h', '24h'] as const) {
      let state = createTimeField('09:37', format);
      for (const value of ['1', '15', '150']) {
        state = editTimeField(state, part, value);
        expect(state.fields[part]).toBe(value);
        expect(state.committed).toBe('09:37');
      }
      state = editTimeField(state, part, '1500');
      expect(readTimeFields(state.fields, format)).toBe('15:00');
      expect(state.committed).toBe('15:00');
    }
});

test('invalid edits remain invalid after blur and cannot be replaced by the last valid committed time', () => {
  let state = createTimeField('15:00', '12h');
  state = finishTimeField(editTimeField(state, 'minute', '99'));
  expect(state.fields.minute).toBe('99');
  expect(state.touched).toBe(true);
  expect(state.committed).toBe('15:00');
  expect(readTimeFields(state.fields, state.format)).toBeNull();
  const switched = changeTimeFormat(state, '24h');
  expect(switched.format).toBe('12h');
  expect(switched.fields.minute).toBe('99');
  expect(readTimeFields(switched.fields, switched.format)).toBeNull();
});

test('nullable caller values initialize visibly empty rather than displaying an old valid schedule', () => {
  const state = createTimeField(null, '12h');
  expect(state.fields).toEqual({ hour: '', minute: '', period: 'AM' });
  expect(readTimeFields(state.fields, state.format)).toBeNull();
  expect(finishTimeField(state).touched).toBe(true);
});

test('blur commits and pads valid single-digit parts, while format changes preserve canonical time', () => {
  let state = createTimeField('09:00', '12h');
  state = editTimeField(state, 'hour', '3');
  state = editTimeField(state, 'minute', '7');
  state = finishTimeField(state);
  expect(state.fields).toEqual({ hour: '03', minute: '07', period: 'AM' });
  expect(state.committed).toBe('03:07');
  const changed = changeTimeFormat({ ...state, fields: { ...state.fields, period: 'PM' } }, '24h');
  expect(changed.fields.hour).toBe('15');
  expect(changed.committed).toBe('15:07');
});

test('complete pasted AM/PM values work in either field without changing other state', () => {
  for (const part of ['hour', 'minute'] as const)
    for (const [value, expected] of [
      ['12am', '00:00'],
      ['12pm', '12:00'],
      ['0900', '09:00'],
    ] as const) {
      const state = editTimeField(createTimeField('17:42', '24h'), part, value);
      expect(readTimeFields(state.fields, state.format)).toBe(expected);
    }
});

test('only canonical 24-hour values may cross the API boundary', () => {
  for (const value of ['00:00', '09:00', '15:00', '23:59']) expect(validTime(value)).toBe(true);
  for (const value of [null, '', '1500', '3:00 PM', '24:00', '09:99', '9:00']) expect(validTime(value)).toBe(false);
});
