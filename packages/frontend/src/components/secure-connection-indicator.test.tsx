import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { SecureConnectionIndicator } from './secure-connection-indicator';
import { SecureAccessSetup } from '@/modules/settings/components/secure-access/secure-access';
import { hasHttpsConnection, httpsSetupVisible } from '@/desktop/secure-access';
import { SettingsWorkspace } from '@/modules/settings/pages/settings-workspace';
import { settingsSections, type SettingsSection } from '@/modules/settings/helpers/settings-catalogue';

function renderGuide({ protocol = 'http:', secureContext = false, hostname = 'orbis.home.arpa', operator = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator }, userSettings: { localDomain: hostname, sslPort: 8443 } });
  try {
    return renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <AppContextProvider>
            <SecureAccessSetup protocol={protocol} secureContext={secureContext} />
          </AppContextProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  } finally {
    client.clear();
  }
}
test('HTTP including trusted localhost never receives an HTTPS lock; setup section is HTTP-only', () => {
  for (const protocol of ['http:', '', 'file:', 'javascript:']) {
    expect(hasHttpsConnection(protocol, true)).toBe(false);
    expect(renderToStaticMarkup(<SecureConnectionIndicator protocol={protocol} secureContext />)).toBe('');
    expect(httpsSetupVisible(protocol)).toBe(protocol === 'http:');
  }
  expect(renderToStaticMarkup(<SecureConnectionIndicator protocol="https:" secureContext={false} />)).toBe('');
  const secure = renderToStaticMarkup(<SecureConnectionIndicator protocol="https:" secureContext compact />);
  expect(secure).toContain('aria-label="HTTPS connection"');
  expect(secure).not.toContain('trusted');
});
test('private setup reuses only public certificate download and explicit manual device trust, never offers HTTP opening', () => {
  const html = renderGuide();
  expect(html).toContain('https://orbis.home.arpa:8443');
  expect(html).toContain('Trust on this device');
  expect(html).toContain('Orbis does not change device trust');
  expect(html).toContain('Download certificate');
  expect(html).toContain('href="https://orbis.home.arpa:8443/login?');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).not.toContain('Cloudflare');
  expect(html).not.toContain('http://orbis');
  expect(html).not.toContain('<form');
});
test('invalid/missing hostname cannot offer a certificate or HTTPS address and nonoperators cannot edit it', () => {
  for (const hostname of ['', '192.168.1.20', 'https://external.example', 'user@external.example']) {
    const html = renderGuide({ hostname, operator: false });
    expect(html).toContain('Ask an operator');
    expect(html).toContain('disabled');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('Set hostname');
    expect(html).not.toContain('href="https://');
  }
});
test('HTTPS setup body becomes only the compact secure connection status', () => {
  const html = renderGuide({ protocol: 'https:', secureContext: true });
  expect(html).toContain('HTTPS connection');
  expect(html).not.toContain('Download certificate');
  expect(html).not.toContain('Trust on this device');
});

test('actual Settings navigation exposes HTTPS only on HTTP and renders its dedicated retained panel', () => {
  const panels = Object.fromEntries(
    settingsSections.map(({ id }) => [id, <input key={id} aria-label={`Draft ${id}`} defaultValue="retained" />]),
  ) as Record<SettingsSection, React.ReactNode>;
  const render = (http: boolean, current: SettingsSection = 'general') =>
    renderToStaticMarkup(
      <SettingsWorkspace current={current} access={{ operator: true, http }} onSection={() => {}} onSetting={() => {}} panels={panels} />,
    );
  expect(render(true)).toContain('>HTTPS</strong>');
  expect(render(false)).not.toContain('>HTTPS</strong>');
  expect(render(true, 'https')).toContain('aria-label="Draft https"');
  expect(render(true, 'https')).not.toContain('aria-label="Draft general"');
});
