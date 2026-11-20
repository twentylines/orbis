import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MotionPreferences } from '@/desktop/motion-preferences';
import { StoreViewTransition } from './store-view-transition';

const view = (active: 'apps' | 'themes') =>
  renderToStaticMarkup(
    <MotionPreferences reduced>
      <StoreViewTransition
        active={active}
        apps={<button type="button">Retained app results</button>}
        themes={<input defaultValue="retained theme draft" />}
      />
    </MotionPreferences>,
  );

test('both Store views remain mounted while only the selected view is available to keyboard and assistive technology', () => {
  const html = view('apps');
  expect(html).toContain('retained theme draft');
  expect(html).toContain('Retained app results');
  expect(html.match(/<div[^>]*data-store-view-panel="themes"[^>]*>/)?.[0]).toContain('inert=""');
  expect(html.match(/<div[^>]*data-store-view-panel="themes"[^>]*>/)?.[0]).toContain('aria-hidden="true"');
  expect(html.match(/<div[^>]*data-store-view-panel="apps"[^>]*>/)?.[0]).not.toContain('inert=');
});

test('selecting Themes reverses the inactive panel and local reduced motion removes positional displacement', () => {
  const html = view('themes');
  expect(html.match(/<div[^>]*data-store-view-panel="apps"[^>]*>/)?.[0]).toContain('inert=""');
  expect(html.match(/<div[^>]*data-store-view-panel="themes"[^>]*>/)?.[0]).not.toContain('aria-hidden=');
  expect(html.match(/data-store-view-panel=/g)).toHaveLength(2);
  expect(html).not.toContain('translateY');
});
