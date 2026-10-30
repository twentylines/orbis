import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { orbisPublishedReleasesOptions } from '@/desktop/orbis-release';
import { OrbisDowngrade } from './orbis-downgrade';

function renderDowngrade({ enabled = true, failed = false, active = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
  const options = orbisPublishedReleasesOptions('nightly');
  if (failed) {
    client
      .getQueryCache()
      .build(client, { queryKey: options.queryKey })
      .setState({ status: 'error', error: new Error('Private diagnostic must not render') });
  } else {
    client.setQueryData(options.queryKey, {
      complete: true,
      releases: [
        {
          tag: 'v0.1.0-beta.125',
          imageManifestUrl: 'https://example.test/manifest.json',
          publishedAt: null,
          body: '',
          url: 'https://example.test/release',
        },
      ],
    });
  }
  let requests = 0;
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppContextProvider>
        <OrbisDowngrade
          installed="v0.1.0-beta.126"
          channel="nightly"
          active={active}
          enabled={enabled}
          request={async () => {
            requests += 1;
            throw new Error('Rendering must not dispatch a host operation');
          }}
        />
      </AppContextProvider>
    </QueryClientProvider>,
  );
  client.clear();
  return { markup, requests };
}

test('downgrade is a permanent labelled section with the existing explicit plan action', () => {
  const { markup, requests } = renderDowngrade();
  expect(markup).toContain('<section class="desktop-downgrade" aria-label="Downgrade">');
  expect(markup).toContain('<h3>Downgrade</h3>');
  expect(markup).not.toContain('<details');
  expect(markup).not.toContain('<summary');
  expect(markup).toContain('>Downgrade</button>');
  expect(markup).toContain('A downgrade removes newer features and security fixes.');
  expect(markup).not.toContain('Force downgrade');
  expect(requests).toBe(0);
});

test('unhealthy hosts retain the idle safeguard and cannot start a downgrade', () => {
  const { markup, requests } = renderDowngrade({ enabled: false });
  expect(markup).toContain('The server must be healthy and idle to downgrade.');
  expect(markup).not.toContain('>Downgrade</button>');
  expect(requests).toBe(0);
});

test('release failure exposes an explicit Retry without raw diagnostics or disclosure instructions', () => {
  const { markup, requests } = renderDowngrade({ failed: true });
  expect(markup).toContain('role="alert">Previous releases could not be loaded.');
  expect(markup).toContain('>Retry</button>');
  expect(markup).not.toContain('Close and reopen');
  expect(markup).not.toContain('Private diagnostic');
  expect(requests).toBe(0);
  expect(renderDowngrade({ failed: true, active: false }).markup).toMatch(/<button[^>]*disabled=""[^>]*>Retry<\/button>/);
});
