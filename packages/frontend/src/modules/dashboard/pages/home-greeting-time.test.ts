import { expect, test } from 'bun:test';
import { greetingForHour } from './home-greeting-time';

test.each([
  [0, 'Good evening'],
  [4, 'Good evening'],
  [5, 'Good morning'],
  [11, 'Good morning'],
  [12, 'Good afternoon'],
  [17, 'Good afternoon'],
  [18, 'Good evening'],
  [23, 'Good evening'],
] as const)('local hour %i uses %s', (hour, message) => {
  expect(greetingForHour(hour)).toBe(message);
});
