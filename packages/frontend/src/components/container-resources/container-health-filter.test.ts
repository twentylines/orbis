import { expect, test } from 'bun:test';
import { containerHealthFilter, withContainerHealthFilter } from './container-health-filter';

test('All clears an attention deep link while preserving the selected server, history and other filters', () => {
  const original = new URLSearchParams('health=attention&section=usage&server=remote&range=24h');
  const next = withContainerHealthFilter(original, 'all');
  expect(next.has('health')).toBe(false);
  expect(containerHealthFilter(next.get('health'))).toBe('all');
  expect(next.get('section')).toBe('usage');
  expect(next.get('server')).toBe('remote');
  expect(next.get('range')).toBe('24h');
  expect(original.get('health')).toBe('attention');
});

test('each supported status roundtrips through the URL and unknown links fall back to the complete list', () => {
  for (const value of ['attention', 'running', 'stopped'] as const) {
    expect(containerHealthFilter(withContainerHealthFilter(new URLSearchParams(), value).get('health'))).toBe(value);
  }
  for (const value of [null, '', 'constructor', 'unknown']) expect(containerHealthFilter(value)).toBe('all');
});
