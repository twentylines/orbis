import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { installedOrbisBuildOptions } from '@/desktop/orbis-release';
import { WindowVisibilityContext } from '@/desktop/window-visibility';
import {
  type SentinelRecoveryAccess,
  type SentinelStatus,
  sentinelRecoveryAccessOptions,
  sentinelStatusOptions,
  SentinelStatusError,
} from '@/modules/updates/sentinel-status';
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
  operator = false,
  access,
  accessError,
  visible = true,
}: {
  software?: { osName: string | null; osVersion: string | null; dockerVersion: string | null };
  status?: SentinelStatus;
  failure?: boolean;
  operator?: boolean;
  access?: SentinelRecoveryAccess;
  accessError?: Error;
  visible?: boolean;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator }, version: { current: '4.10.1' } });
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
  const recoveryKey = sentinelRecoveryAccessOptions(visible).queryKey;
  if (access) client.setQueryData(recoveryKey, access);
  if (accessError) client.getQueryCache().build(client, { queryKey: recoveryKey }).setState({ status: 'error', error: accessError });
  if (failure)
    for (const queryKey of [softwareKey, sentinelKey])
      client
        .getQueryCache()
        .build(client, { queryKey })
        .setState({ status: 'error', error: new Error('Private source diagnostic') });

  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppContextProvider>
        <WindowVisibilityContext.Provider value={visible}>
          <About />
        </WindowVisibilityContext.Provider>
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

const portalUrl = 'https://independent.example:8443/sentinel/recovery/';

test('shows the staged operator the next human step without claiming emergency key confirmation', () => {
  const access = { state: 'configured', portalUrl, unitState: 'active', enrollment: 'key-prepared' } as const;
  const operator = render({ operator: true, access });
  expect(operator).toContain('Emergency key prepared.');
  expect(operator).toContain('confirm the saved file');
  expect(operator).not.toContain('Host recorded a key acknowledgment.');
  expect(render({ access })).not.toContain('Emergency key prepared.');
});

test('places recovery below Reset Orbis and links directly to the independent portal', () => {
  for (const unitState of ['active', 'inactive', 'unknown'] as const) {
    const markup = render({ operator: true, access: { state: 'configured', portalUrl, unitState } });
    const reset = markup.indexOf('>Reset Orbis</h3>');
    expect(reset).toBeGreaterThan(0);
    expect(markup.indexOf('>Recovery</h3>')).toBeGreaterThan(reset);
    expect(markup).toMatch(
      /<a[^>]*href="https:\/\/independent\.example:8443\/sentinel\/recovery\/"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Open Sentinel<\/a>/,
    );
    expect(markup).toContain(unitState === 'unknown' ? 'Recovery service status unknown.' : `Recovery service ${unitState}.`);
    expect(markup).toContain('Open the portal to check sign-in availability.');
    expect(markup).not.toContain('Pause Orbis');
  }
});

test('healthy Sentinel and stale access after authentication failure cannot fabricate recovery access', () => {
  const missing = render({ status: sentinel, access: { state: 'missing', portalUrl: null, unitState: null } });
  expect(missing).toContain('Recovery portal setup required.');
  expect(missing).not.toContain('Open Sentinel');
  const stale = render({
    status: sentinel,
    operator: true,
    access: { state: 'configured', portalUrl, unitState: 'active', enrollment: 'activated' },
    accessError: new SentinelStatusError(401),
  });
  expect(stale).toContain('Sign in again to check recovery access.');
  expect(stale).not.toContain(portalUrl);
  expect(stale).not.toContain('Recovery service active.');
  expect(stale).not.toContain('Pause Orbis');
  const unknownEnrollment = render({ operator: true, access: { state: 'configured', portalUrl, unitState: 'active' } });
  expect(unknownEnrollment).toContain('Enrollment progress could not be verified.');
  expect(unknownEnrollment).not.toContain('Pause Orbis');
  const unavailable = render({ status: sentinel, access: { state: 'unavailable', portalUrl: null, unitState: null } });
  expect(unavailable).toContain('Recovery access could not be verified.');
  expect(unavailable).not.toContain('Open Sentinel');
});

test('recovery entry is offered only to an active, activated operator and cannot run from a hidden section', () => {
  const access = { state: 'configured', portalUrl, unitState: 'active', enrollment: 'activated' } as const;
  const operator = render({ operator: true, access });
  expect(operator).not.toContain('test sign-in while Orbis is still available');
  expect(operator).toMatch(/<button[^>]*aria-disabled="false"[^>]*><svg[\s\S]*?<\/svg>Pause Orbis<\/button>/);
  expect(render({ access })).not.toContain('Pause Orbis');
  expect(render({ operator: true, access: { ...access, unitState: 'inactive' } })).not.toContain('Pause Orbis');
  expect(render({ operator: true, access: { ...access, enrollment: 'operator-staged' } })).not.toContain('Pause Orbis');
  expect(render({ operator: true, access, visible: false })).toMatch(/<button[^>]*\sdisabled=""[^>]*><svg[\s\S]*?<\/svg>Pause Orbis<\/button>/);
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
