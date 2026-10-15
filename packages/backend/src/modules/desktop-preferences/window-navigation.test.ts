import { describe, expect, it } from 'vitest';
import { shouldRevalidateToolRoute, windowSearch } from '../../../../frontend/src/desktop/window-navigation';

describe('tool window navigation', () => {
  const args = (before: string, after: string, extra = {}) =>
    ({
      currentUrl: new URL(before, 'http://localhost'),
      nextUrl: new URL(after, 'http://localhost'),
      defaultShouldRevalidate: true,
      ...extra,
    }) as Parameters<typeof shouldRevalidateToolRoute>[0];

  it('keeps editor loader data when only visibility changes, including browser history', () => {
    const open = '/apps/test/media/edit?tab=files&bust=42';
    const minimized = '/apps/test/media/edit?tab=files&bust=42&orbisWindow=minimized';
    expect(shouldRevalidateToolRoute(args(open, minimized))).toBe(false);
    expect(shouldRevalidateToolRoute(args(minimized, open))).toBe(false);
  });
  it('still validates actual route/query changes, explicit reloads and submitted actions', () => {
    expect(shouldRevalidateToolRoute(args('/apps/test/media/edit', '/apps/test/dns/edit'))).toBe(true);
    expect(shouldRevalidateToolRoute(args('/monitor?range=1h', '/monitor?range=7d&orbisWindow=minimized'))).toBe(true);
    expect(shouldRevalidateToolRoute(args('/apps/test/media/edit', '/apps/test/media/edit'))).toBe(true);
    expect(shouldRevalidateToolRoute(args('/apps/test/media/edit', '/apps/test/media/edit?orbisWindow=minimized', { formMethod: 'POST' }))).toBe(
      true,
    );
    expect(shouldRevalidateToolRoute(args('/apps', '/apps', { defaultShouldRevalidate: false }))).toBe(false);
  });
  it('preserves every unrelated query value and replaces the reserved flag exactly once', () => {
    const query = '?tab=user-config&filter=a%26b&filter=two&bust=42';
    const minimized = windowSearch(query, true);
    expect(windowSearch(minimized, true)).toBe(minimized);
    expect(windowSearch(minimized, false)).toBe(query);
    expect(new URLSearchParams(minimized).getAll('orbisWindow')).toEqual(['minimized']);
    expect(windowSearch('', false)).toBe('');
  });
});
