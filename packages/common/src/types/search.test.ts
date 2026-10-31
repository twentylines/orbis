import { expect, test } from 'bun:test';
import { createSearchMatcher } from './search';

test('punctuation, accents, fragments and single edits find app names', () => {
  for (const query of ['pihole', 'pi hole', 'pi.hole', 'pihol', 'pihloe', 'piholr']) expect(createSearchMatcher(query)('Pi-hole')).toBeGreaterThan(0);
  expect(createSearchMatcher('cafe')('Café')).toBeGreaterThan(0);
  expect(createSearchMatcher('jellyf')('Jellyfin')).toBeGreaterThan(0);
  expect(createSearchMatcher('jelyfin')('Jellyfin')).toBeGreaterThan(0);
  expect(createSearchMatcher('backup sched')('Backup schedule')).toBeGreaterThan(0);
});
test('exact, joined, prefix and literal matches outrank corrections', () => {
  const match = createSearchMatcher('pihole');
  const scores = ['pihole', 'Pi-hole', 'Pihole tools', 'My pihole', 'Pihloe'].map((name) => match(name));
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
  expect(new Set(scores).size).toBe(5);
});
test('short terms are literal, all terms must match, and untrusted long input is bounded', () => {
  expect(createSearchMatcher('cat')('Car')).toBe(0);
  expect(createSearchMatcher('pi')('Pi-hole')).toBeGreaterThan(0);
  expect(createSearchMatcher('jelly reactor')('Jellyfin media server')).toBe(0);
  expect(createSearchMatcher('x'.repeat(100000))('Pi-hole', 'y'.repeat(100000))).toBe(0);
  expect(createSearchMatcher('')('Pi-hole')).toBeGreaterThan(0);
});
