import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MotionPreferences } from '@/desktop/motion-preferences';
import { StoreViewTransition } from './store-view-transition';

const view = (active: 'discover' | 'apps') =>
  renderToStaticMarkup(
    <MotionPreferences reduced>
      <StoreViewTransition
        active={active}
        discover={<input defaultValue="retained discovery draft" />}
        apps={<button type="button">Retained app results</button>}
      />
    </MotionPreferences>,
  );

test('both Store views remain mounted while only the selected view is available to keyboard and assistive technology', () => {
  const html = view('apps');
  expect(html).toContain('retained discovery draft');
  expect(html).toContain('Retained app results');
  expect(html.match(/<div[^>]*data-store-view-panel="discover"[^>]*>/)?.[0]).toContain('inert=""');
  expect(html.match(/<div[^>]*data-store-view-panel="discover"[^>]*>/)?.[0]).toContain('aria-hidden="true"');
  expect(html.match(/<div[^>]*data-store-view-panel="apps"[^>]*>/)?.[0]).not.toContain('inert=');
});

test('selecting Discover reverses the inactive panel and local reduced motion removes positional displacement', () => {
  const html = view('discover');
  expect(html.match(/<div[^>]*data-store-view-panel="apps"[^>]*>/)?.[0]).toContain('inert=""');
  expect(html.match(/<div[^>]*data-store-view-panel="discover"[^>]*>/)?.[0]).not.toContain('aria-hidden=');
  expect(html).not.toContain('translateY');
});

test('the Theme packs facet retains app controls and drafts while exposing only its selected panel', () => {
  const html = renderToStaticMarkup(
    <MotionPreferences reduced>
      <StoreViewTransition
        active="themes"
        discover={<input defaultValue="discovery draft" />}
        apps={<button type="button">Existing app action</button>}
        themes={<button type="button">Install theme</button>}
      />
    </MotionPreferences>,
  );
  expect(html).toContain('discovery draft');
  expect(html).toContain('Existing app action');
  expect(html).toContain('Install theme');
  for (const panel of ['discover', 'apps'])
    expect(html.match(new RegExp(`<div[^>]*data-store-view-panel="${panel}"[^>]*>`))?.[0]).toContain('inert=""');
  expect(html.match(/<div[^>]*data-store-view-panel="themes"[^>]*>/)?.[0]).not.toContain('inert=');
});
