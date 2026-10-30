import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { SecureConnectionIndicator } from './secure-connection-indicator';
import { SecureAccessSetup } from '@/modules/settings/components/secure-access/secure-access';
import { hasHttpsConnection, httpsSetupVisible } from '@/desktop/secure-access';
import { PasskeySettings } from '@/modules/settings/components/passkey-settings/passkey-settings';
import { passkeyListOptions, type PasskeyList } from '@/modules/auth/passkeys/passkey-api';
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

function renderPasskeys({
  protocol = 'http:',
  secureContext = false,
  available = false,
  credentials = [],
}: {
  protocol?: string;
  secureContext?: boolean;
  available?: boolean;
  credentials?: PasskeyList['credentials'];
} = {}) {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol, hostname: 'orbis.home.arpa' },
      isSecureContext: secureContext,
      PublicKeyCredential: class {},
    },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {} } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData([...passkeyListOptions().queryKey, true], {
    available,
    reason: available ? undefined : 'Passkeys require a trusted HTTPS origin or localhost.',
    credentials,
    policy: { requireTotpAfterPasskey: false, totpEnabled: true },
  } satisfies PasskeyList);
  try {
    return renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <PasskeySettings totpEnabled />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  } finally {
    client.clear();
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}

test('insecure HTTP passkeys offer one shared HTTPS action without repeated empty or disabled controls', () => {
  const html = renderPasskeys();
  expect(html.match(/Set up HTTPS/g)?.length).toBe(1);
  expect(html).toMatch(/<a[^>]*class="[^"]*btn[^>]*href="\/settings\?tab=https"/);
  expect(html).not.toContain('Add passkey');
  expect(html).not.toContain('No passkeys added yet');
  expect(html).not.toContain('Passkeys require a trusted HTTPS');
  expect(html).not.toContain('Require an account code');
});

test('HTTP retains existing credential management and policy without offering a disabled Add action', () => {
  const html = renderPasskeys({ credentials: [{ id: 'fixture', name: 'Security key', createdAt: 1000, lastUsedAt: null }] });
  expect(html).toContain('Security key');
  expect(html).toContain('Remove Security key');
  expect(html).toContain('Require an account code');
  expect(html).not.toContain('Add passkey');
});

test('available HTTPS and trusted HTTP contexts retain the real Add passkey action and verification policy', () => {
  for (const protocol of ['https:', 'http:']) {
    const html = renderPasskeys({ protocol, secureContext: true, available: true });
    expect(html).toContain('Add passkey');
    expect(html).toContain('Require an account code');
    expect(html).not.toContain('Set up HTTPS');
  }
});

test('HTTPS benefits state security and host-dependent discovery without promising unsupported features', () => {
  const html = renderGuide();
  for (const benefit of [
    'Encrypt sign-in details',
    'passkeys',
    'Pair trusted private servers',
    'Nearby discovery also needs supported host networking',
  ])
    expect(html).toContain(benefit);
});

test('unavailable HTTPS retains its actionable availability explanation', () => {
  const html = renderPasskeys({ protocol: 'https:', secureContext: true, available: false });
  expect(html).toContain('Add passkey');
  expect(html).toContain('Passkeys require a trusted HTTPS origin or localhost.');
  expect(html).not.toContain('Set up HTTPS');
});
