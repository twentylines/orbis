import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { SentinelStatus } from './sentinel-status';
import { SentinelStatusError, type SentinelStatus as Status, sentinelStatusOptions } from '../sentinel-status';

const healthy: Status = { available: true, installedVersion: '0.1.0-dev.11', availableVersion: null, state: 'healthy' };

function render({ value, error, active = true }: { value?: Status; error?: Error; active?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const options = sentinelStatusOptions(active);
  if (value) client.setQueryData(options.queryKey, value);
  if (error) client.getQueryCache().build(client, { queryKey: options.queryKey }).setState({ status: 'error', error });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SentinelStatus active={active} />
    </QueryClientProvider>,
  );
  client.clear();
  return markup;
}

test('shows the independently reported version and service status in a labelled definition list', () => {
  const markup = render({ value: healthy });
  expect(markup).toContain('>Sentinel</h4>');
  expect(markup).toContain('aria-label="Sentinel status"');
  expect(markup).toContain('<dd>0.1.0-dev.11</dd>');
  expect(markup).toContain('<output>Running</output>');
  expect(markup).not.toContain('<button');
  expect(markup).not.toContain('Available version');
  expect(markup).not.toContain('Up to date');
});

test('missing observations remain unknown rather than claiming the service is absent or healthy', () => {
  const markup = render({ value: { available: false, installedVersion: null, availableVersion: null, state: 'unknown' } });
  expect(markup).toContain('<dd>Not reported</dd>');
  expect(markup).toContain('<output>Status unavailable</output>');
  expect(markup).not.toContain('Not installed');
  expect(markup).not.toContain('Running');
});

test('failed refreshes replace cached health with an explicit error and hide private diagnostics', () => {
  const markup = render({ value: healthy, error: new Error('/private/runtime/diagnostic') });
  expect(markup).toContain('role="alert">Sentinel status could not be read.');
  expect(markup).toContain('<output>Status unavailable</output>');
  expect(markup).not.toContain('Running');
  expect(markup).not.toContain('0.1.0-dev.11');
  expect(markup).not.toContain('/private');
  expect(render({ error: new SentinelStatusError(401) })).toContain('Sign in again to read Sentinel status.');
});

test('loading and inactive states retain the status labels without a manual refresh control', () => {
  const markup = render({ active: false });
  expect(markup).toContain('<dd>Reading…</dd>');
  expect(markup).toContain('<output>Checking…</output>');
  expect(markup).not.toContain('<button');
});

test('an available version is shown only when it was actually reported', () => {
  const markup = render({ value: { ...healthy, availableVersion: '0.2.0-beta.1' } });
  expect(markup).toContain('<dt>Available version</dt>');
  expect(markup).toContain('<dd>0.2.0-beta.1</dd>');
  expect(markup).not.toContain('Install update');
});
