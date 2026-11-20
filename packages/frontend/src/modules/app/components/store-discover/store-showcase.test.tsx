import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import type { AppInfoSimple } from '@/types/app.types';
import { StorePreviewContext, type StorePreview } from '../../pages/store-preview-context';
import { StoreShowcase, storeSpotlights } from './store-showcase';

const app = (id: string, categories: AppInfoSimple['categories'] = ['utilities'], patch: Partial<AppInfoSimple> = {}): AppInfoSimple => ({
  id,
  urn: `${id}:catalogue`,
  name: id,
  short_desc: `Actual description for ${id}`,
  categories,
  available: true,
  deprecated: false,
  created_at: 0,
  supported_architectures: ['amd64'],
  ...patch,
});

describe('truthful Store discovery', () => {
  test('uses only returned available entries and exact repositories, with no invented identities', () => {
    const apps = [
      app('blocked', ['featured'], { available: false }),
      app('old', ['media'], { deprecated: true }),
      app('real', ['data']),
      app('foreign', ['media'], { urn: 'foreign:other' }),
    ];
    expect(storeSpotlights(apps, 'catalogue').map((item) => item.urn)).toEqual(['real:catalogue']);
    expect(storeSpotlights([], 'catalogue')).toEqual([]);
  });
  test('samples category variety without presenting the same software from several repositories twice', () => {
    const apps = [app('files', ['data']), app('files', ['data'], { urn: 'files:other' }), app('player', ['media']), app('tools'), app('fourth')];
    const result = storeSpotlights(apps);
    expect(result.map((item) => item.id)).toEqual(['player', 'files', 'tools']);
    expect(apps.map((item) => item.id)).toEqual(['files', 'files', 'player', 'tools', 'fourth']);
  });
  test('split preview hides the showcase for ordinary app selections and retains only the chosen spotlight for a spotlight selection', () => {
    const i18n = createInstance();
    void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: {} } } });
    const preview: StorePreview = {
      closePath: '/app-store',
      split: true,
      selectedUrn: 'files:catalogue',
      onCardMount: () => {},
      onDetailsMount: () => {},
      previewId: 'store-app-preview',
      close: () => {},
      nextHistory: () => ({}),
    };
    const render = (value: StorePreview) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(
            MemoryRouter,
            { initialEntries: ['/app-store/catalogue/files?view=apps'] },
            createElement(
              StorePreviewContext.Provider,
              { value },
              createElement(StoreShowcase, {
                apps: [app('files', ['data']), app('player', ['media']), app('tools')],
                installedApps: new Set<string>(),
                pendingApps: new Set<string>(),
                onBrowse: () => {},
              }),
            ),
          ),
        ),
      );
    expect(render(preview)).toBe('');
    const html = render({ ...preview, suggestion: { kind: 'spotlight', urn: 'files:catalogue' } });
    expect(html).toContain('data-spotlight-count="1"');
    expect(html).toContain('/app-store/catalogue/files?view=apps');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toMatch(/player|tools|Explore app categories/);
    expect(render({ ...preview, split: false })).toContain('data-spotlight-count="3"');
  });
  test('uses real app descriptions/icons and preserved app-preview URLs, with explicit pending and installed states', () => {
    const i18n = createInstance();
    void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: {} } } });
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          MemoryRouter,
          { initialEntries: ['/app-store?store=catalogue&view=apps'] },
          createElement(StoreShowcase, {
            apps: [app('files', ['data']), app('player', ['media']), app('tools')],
            installedApps: new Set(['files:catalogue']),
            pendingApps: new Set(['player:catalogue']),
            onBrowse: () => undefined,
          }),
        ),
      ),
    );
    expect(html).toContain('/app-store/catalogue/files?store=catalogue&amp;view=apps');
    expect(html).toContain('/api/marketplace/apps/files%3Acatalogue/image');
    expect(html).toContain('Actual description for files');
    expect(html).toContain('Installation pending');
    expect(html).toContain('View installed app');
    expect(html.match(/class="orbis-store-spotlight(?: |")/g)).toHaveLength(3);
    expect(html).not.toMatch(/Most popular|Trending|Downloads|rating|screenshot/i);
    expect(html.match(/<button/g)).toHaveLength(6);
  });
  test('primary artwork uses a genuine supplied gallery asset with a real icon overlay and no extra catalogue lookup', () => {
    const i18n = createInstance();
    void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: {} } } });
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          MemoryRouter,
          {},
          createElement(StoreShowcase, {
            apps: [app('real', ['featured'], { gallery: ['https://gallery.example.test/actual-app.png'] })],
            installedApps: new Set<string>(),
            pendingApps: new Set<string>(),
            onBrowse: () => undefined,
          }),
        ),
      ),
    );
    expect(html).toContain('src="https://gallery.example.test/actual-app.png"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('/api/marketplace/apps/real%3Acatalogue/image');
    expect(html).toContain('data-gallery="true"');
  });
  test('empty and incompatible-only catalogues do not render fabricated discovery panels', () => {
    const i18n = createInstance();
    void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: {} } } });
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          MemoryRouter,
          {},
          createElement(StoreShowcase, {
            apps: [app('blocked', ['featured'], { available: false })],
            installedApps: new Set<string>(),
            pendingApps: new Set<string>(),
            onBrowse: () => undefined,
          }),
        ),
      ),
    );
    expect(html).toBe('');
  });
});
