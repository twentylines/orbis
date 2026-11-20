import { describe, expect, test } from 'bun:test';
import type { AppInfo, AppInfoSimple } from '@/types/app.types';
import { storeView } from './store-curation';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '@/lib/query-client';
import { appContextOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { InstallForm } from '../install-form/install-form';
import { StoreTile } from '../store-tile/store-tile';
import { StoreCatalogue } from '../../pages/store-catalogue';

const app = (id: string, store = 'official', overrides: Partial<AppInfoSimple> = {}): AppInfoSimple => ({
  id,
  urn: `${id}:${store}`,
  name: id,
  available: true,
  deprecated: false,
  categories: ['media'],
  created_at: 0,
  short_desc: '',
  supported_architectures: ['amd64'],
  ...overrides,
});

test('mounted app forms give repeated field names distinct controls and matching labels', () => {
  const client = createAppQueryClient();
  client.setQueryData<unknown>(appContextOptions().queryKey, {
    userSettings: { guestDashboard: false, localDomain: 'home.arpa', internalIp: '127.0.0.1', domain: 'example.test', maxBackups: 2 },
  });
  const i18n = createInstance();
  void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: {} } } });
  const forms = ['first', 'second'].map((id) =>
    createElement(InstallForm, {
      key: id,
      formId: `install-${id}`,
      onSubmit: () => undefined,
      info: { ...app(id), dynamic_config: true, exposable: true, force_expose: false, port: 8096 } as AppInfo,
      initialValues: { exposedLocal: true, exposed: true, domain: 'app.example.test', localSubdomain: 'app', port: '8096' },
      formFields: [
        { type: 'text', env_variable: 'SHARED_VALUE', label: 'Shared setting', required: false },
        { type: 'password', env_variable: 'SHARED_PASSWORD', label: 'Shared password', required: false },
      ],
    }),
  );
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(I18nextProvider, { i18n }, createElement(AppContextProvider as ComponentType<{ children?: ReactNode }>, null, forms)),
    ),
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const label of html.matchAll(/\sfor="([^"]+)"/g)) expect(ids.filter((id) => id === label[1])).toHaveLength(1);
  for (const name of ['port', 'maxBackups', 'SHARED_VALUE', 'SHARED_PASSWORD']) {
    const fields = [...html.matchAll(/<input\b[^>]+>/g)].filter(([tag]) => tag.includes(`name="${name}"`));
    expect(fields).toHaveLength(2);
    expect(new Set(fields.map(([tag]) => tag.match(/\sid="([^"]+)"/)?.[1])).size).toBe(2);
  }
  client.clear();
});

describe('catalogue-first Store presentation', () => {
  test('catalogue rows retain their supplied order and exact app links', () => {
    const items = Array.from({ length: 12 }, (_, index) => app(`product-${index}`));
    const i18n = createInstance();
    void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: { APP_CATEGORY_MEDIA: 'Media' } } } });
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          MemoryRouter,
          {},
          createElement(StoreCatalogue, {
            apps: items,
            lastElementRef: () => undefined,
          }),
        ),
      ),
    );
    const links = Array.from(html.matchAll(/href="\/app-store\/official\/(product-[0-9]+)"/g), ([, id]) => id);
    expect(links).toEqual(items.map((item) => item.id));
  });

  test('catalogue, legacy discovery and unknown URLs choose Apps, and explicit Themes stays available', () => {
    for (const value of [undefined, null, '', 'apps', 'discover', 'collections', 'unknown']) expect(storeView(value)).toBe('apps');
    expect(storeView('themes')).toBe('themes');
  });

  test('product cards keep exact repository and preview history, real descriptions and availability without nested install buttons', () => {
    const item = app('jellyfin', 'community', { name: 'Jellyfin', short_desc: 'A personal media server.', available: false });
    const i18n = createInstance();
    void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: { APP_CATEGORY_MEDIA: 'Media' } } } });
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          MemoryRouter,
          { initialEntries: ['/app-store?view=apps&store=community'] },
          createElement(StoreTile, { app: item, isLoading: false }),
        ),
      ),
    );
    expect(html).toContain('/app-store/community/jellyfin?view=apps&amp;store=community');
    expect(html).toContain('/api/marketplace/apps/jellyfin%3Acommunity/image');
    expect(html).toContain('width="72"');
    expect(html.match(/loading="lazy"/g)?.length).toBe(1);
    expect([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1])).toEqual([
      '/api/marketplace/apps/jellyfin%3Acommunity/image',
      '/api/marketplace/apps/jellyfin%3Acommunity/image',
    ]);
    expect(html).toContain('Unavailable');
    expect(html).toContain('Preview');
    expect(html).toContain('A personal media server.');
    expect(html).toContain('aria-describedby=');
    expect(html).not.toContain('<button');
  });
});

describe('Store card installation controls', () => {
  const renderCard = (props: Partial<Parameters<typeof StoreTile>[0]>) => {
    const i18n = createInstance();
    void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: { APP_CATEGORY_MEDIA: 'Media' } } } });
    return renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          MemoryRouter,
          {},
          createElement(StoreTile, {
            app: app('jellyfin', 'community', { name: 'Jellyfin' }),
            isLoading: false,
            quickInstall: true,
            onInstall: () => undefined,
            ...props,
          }),
        ),
      ),
    );
  };
  test('installed apps show their state and never offer another installation', () => {
    const html = renderCard({ installed: true });
    expect(html).toContain('Installed');
    expect(html).not.toContain('>Preview ');
    expect(html).not.toContain('aria-label="Install Jellyfin"');
  });
  test('pending operations are not presented as a completed installation or offered twice', () => {
    const html = renderCard({ pending: true });
    expect(html).toContain('Pending');
    expect(html).not.toContain('>Installed ');
    expect(html).not.toContain('aria-label="Install Jellyfin"');
  });
  test('the installation action is a button separate from the app preview link', () => {
    const html = renderCard({});
    const link = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/)?.[0];
    expect(link).toContain('/app-store/community/jellyfin');
    expect(link).not.toContain('<button');
    expect(html).toContain('aria-label="Install Jellyfin"');
    expect(html.indexOf('aria-label="Install Jellyfin"')).toBeGreaterThan(html.indexOf('</a>'));
  });
});
