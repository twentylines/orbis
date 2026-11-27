import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { installedOrbisBuildOptions } from '@/desktop/orbis-release';
import { type SentinelStatus, sentinelStatusOptions } from '@/modules/updates/sentinel-status';
import { About } from './about';

const installed = { osName: 'Ubuntu 24.04.4 LTS', osVersion: '24.04', dockerVersion: '29.2.1' };
const sentinel: SentinelStatus = {
  available: true,
  installedVersion: '0.8.5',
  availableVersion: '0.9.0',
  state: 'healthy',
};

function render({
  software,
  status,
  failure = false,
}: {
  software?: { osName: string | null; osVersion: string | null; dockerVersion: string | null };
  status?: SentinelStatus;
  failure?: boolean;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: false }, version: { current: '4.10.1' } });
  client.setQueryData(installedOrbisBuildOptions().queryKey, {
    version: 'v0.1.2',
    commit: null,
    imageDigest: null,
    runtipiCompatibility: '4.10.1',
  });
  const sentinelKey = sentinelStatusOptions(true).queryKey;
  const softwareKey = ['orbis-installed-software'];
  if (status) client.setQueryData(sentinelKey, status);
  if (software) client.setQueryData(softwareKey, software);
  if (failure)
    for (const queryKey of [softwareKey, sentinelKey])
      client
        .getQueryCache()
        .build(client, { queryKey })
        .setState({ status: 'error', error: new Error('Private source diagnostic') });

  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppContextProvider>
        <About />
      </AppContextProvider>
    </QueryClientProvider>,
  );
  client.clear();
  return markup;
}

test('About reports installed Sentinel, OS and Docker alongside the Orbis version and compatibility base', () => {
  const markup = render({ software: installed, status: sentinel });
  expect(markup).toContain('<h3 id="about-software-title">Installed software</h3>');
  expect(markup).toContain('<dt>Orbis</dt><dd>0.1.2</dd>');
  expect(markup).toContain('<dt>Compatibility base</dt><dd>4.10.1</dd>');
  expect(markup).toContain('<dt>Sentinel</dt><dd>0.8.5</dd>');
  expect(markup).not.toContain('0.9.0');
  expect(markup).toContain('<dt>Operating system</dt><dd>Ubuntu 24.04.4 LTS</dd>');
  expect(markup).toContain('<dt>Docker</dt><dd>29.2.1</dd>');
});

test('About includes a separately reported OS version and identifies the Docker Desktop host', () => {
  expect(render({ software: { ...installed, osName: 'Debian GNU/Linux', osVersion: '13' } })).toContain(
    '<dt>Operating system</dt><dd>Debian GNU/Linux 13</dd>',
  );
  expect(render({ software: { ...installed, osName: 'Docker Desktop', osVersion: '12' } })).toContain(
    '<dt>Operating system</dt><dd>Docker Desktop (Docker host OS 12)</dd>',
  );
});

test('About distinguishes pending, partial and unavailable software facts', () => {
  const loading = render();
  const failure = render({ software: installed, status: sentinel, failure: true });
  for (const field of ['Sentinel', 'Operating system', 'Docker']) {
    expect(loading).toContain(`<dt>${field}</dt><dd>Reading…</dd>`);
    expect(failure).toContain(`<dt>${field}</dt><dd>Not reported</dd>`);
  }
  expect(failure).not.toContain('Private source diagnostic');
  const partial = render({
    software: { osName: null, osVersion: null, dockerVersion: '29.2.1' },
    status: { ...sentinel, installedVersion: null },
  });
  expect(partial).toContain('<dt>Sentinel</dt><dd>Not reported</dd>');
  expect(partial).toContain('<dt>Operating system</dt><dd>Not reported</dd>');
  expect(partial).toContain('<dt>Docker</dt><dd>29.2.1</dd>');
  expect(partial).not.toContain('0.9.0');
});
