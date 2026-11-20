import { expect, test } from 'bun:test';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { QueryClientProvider } from '@tanstack/react-query';
import { appContextOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { createAppQueryClient } from '@/lib/query-client';
import type { AppInfo } from '@/types/app.types';
import { AppCatalogueDetails } from '../components/store-discover/app-catalogue-details';
import { InstallForm } from '../components/install-form/install-form';
import { catalogueGallery, catalogueInstallAllowed, catalogueInstallDefaults } from './catalogue-compatibility';

const compatibility = { supported: true, reasons: [], requires_auth: true };

test('catalogue compatibility cannot override unavailable or deprecated platform status', () => {
  expect(catalogueInstallAllowed({ available: true, deprecated: false })).toBe(true);
  for (const app of [
    { available: false, deprecated: false, compatibility },
    { available: true, deprecated: true, compatibility },
    { available: true, deprecated: false, compatibility: { ...compatibility, supported: false } },
  ])
    expect(catalogueInstallAllowed(app)).toBe(false);
});

test('apps requiring central authentication always start with sign-in and a protected route, preserving unrelated form drafts', () => {
  const draft = { enableAuth: false, openPort: true, exposedLocal: false, exposed: false, CUSTOM: 'keep' };
  expect(catalogueInstallDefaults({ compatibility }, draft)).toEqual({ ...draft, enableAuth: true, openPort: false, exposedLocal: true });
  expect(draft.openPort).toBe(true);
  expect(catalogueInstallDefaults({ compatibility }, { exposed: true, exposedLocal: false })).toMatchObject({
    enableAuth: true,
    openPort: false,
    exposedLocal: false,
  });
  expect(catalogueInstallDefaults({}, draft)).toBe(draft);
});

test('gallery includes only actual HTTPS assets, rejects credential-bearing URLs, deduplicates and bounds remote image loads', () => {
  expect(
    catalogueGallery({
      gallery: [
        'http://example.test/a.png',
        'javascript:alert(1)',
        'https://u:p@example.test/a.png',
        'https://example.test/a.png',
        'https://example.test/a.png',
      ],
    }),
  ).toEqual(['https://example.test/a.png']);
  expect(catalogueGallery({ gallery: Array.from({ length: 20 }, (_, index) => `https://example.test/${index}.png`) })).toHaveLength(8);
});

test('unsupported metadata remains readable with exact reasons and genuine gallery assets', () => {
  const html = renderToStaticMarkup(
    createElement(AppCatalogueDetails, {
      info: {
        name: 'Actual app',
        catalog_format: 'umbrel',
        compatibility: { ...compatibility, supported: false, reasons: ['Requires an unsupported host device.'] },
        gallery: ['https://example.test/actual.png'],
        release_notes: 'A real upstream release note.',
      },
    }),
  );
  expect(html).toContain('Not supported on Orbis yet');
  expect(html).toContain('Requires an unsupported host device.');
  expect(html).toContain('https://example.test/actual.png');
  expect(html).toContain('A real upstream release note.');
  expect(html).not.toContain('<button');
});

test('central-auth install forms render locked authentication and direct-port switches with a usable local route', () => {
  const client = createAppQueryClient();
  client.setQueryData<unknown>(appContextOptions().queryKey, {
    userSettings: { guestDashboard: false, localDomain: 'home.arpa', internalIp: '127.0.0.1', domain: 'example.test', maxBackups: 2 },
  });
  const i18n = createInstance();
  void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: {} } } });
  const info = {
    id: 'central',
    urn: 'central:umbrel',
    compatibility,
    dynamic_config: true,
    exposable: true,
    force_expose: false,
    port: 8080,
  } as unknown as AppInfo;
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          AppContextProvider as ComponentType<{ children?: ReactNode }>,
          {},
          createElement(InstallForm, { info, formId: 'central-auth', onSubmit: () => undefined }),
        ),
      ),
    ),
  );
  const switches = [...html.matchAll(/<button\b[^>]+role="switch"[^>]*>/g)].map(([tag]) => tag);
  const switchFor = (label: string) =>
    switches.find((tag) => {
      const labelId = tag.match(/aria-labelledby="([^"]+)"/)?.[1];
      const labelMarkup = labelId ? html.slice(html.indexOf(`id="${labelId}"`)).split('</span>')[0] : '';
      return labelMarkup?.includes(label);
    });
  expect(switchFor('APP_INSTALL_FORM_OPEN_PORT')).toMatch(/aria-checked="false".*disabled=""|disabled="".*aria-checked="false"/);
  expect(switchFor('APP_INSTALL_FORM_ENABLE_AUTH')).toMatch(/aria-checked="true".*disabled=""|disabled="".*aria-checked="true"/);
  expect(switchFor('APP_INSTALL_FORM_EXPOSE_LOCAL')).toContain('aria-checked="true"');
  expect(html).toContain('value="central-umbrel"');
  expect(html).toContain('Direct port access is disabled.');
  client.clear();
});
