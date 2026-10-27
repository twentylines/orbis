import { describe, expect, it } from 'bun:test';
import { preserveResourceRanking } from './resource-ranking';

describe('resource ranking during interaction', () => {
  it('keeps targets in place while displaying the newest readings', () => {
    const refreshed = [
      { id: 'b', cpu: 90 },
      { id: 'a', cpu: 10 },
    ];
    expect(preserveResourceRanking(refreshed, ['a', 'b'])).toEqual([
      { id: 'a', cpu: 10 },
      { id: 'b', cpu: 90 },
    ]);
    expect(refreshed.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('removes vanished containers and appends new ones in their current ranking', () => {
    const refreshed = [
      { id: 'd', cpu: 90 },
      { id: 'b', cpu: 50 },
      { id: 'c', cpu: 20 },
    ];
    expect(preserveResourceRanking(refreshed, ['a', 'b']).map((item) => item.id)).toEqual(['b', 'd', 'c']);
  });

  it('resumes the current metric order when interaction ends', () => {
    const refreshed = [
      { id: 'b', cpu: 90 },
      { id: 'a', cpu: 10 },
    ];
    expect(preserveResourceRanking(refreshed, null)).toBe(refreshed);
    expect(preserveResourceRanking([], ['a', 'b'])).toEqual([]);
  });
});
