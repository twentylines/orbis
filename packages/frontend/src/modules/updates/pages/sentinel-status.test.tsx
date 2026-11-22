import { expect, test } from 'bun:test';
import type { SentinelUpdateJob } from '@runtipi/common/schemas/sentinel-update-progress';
import { desktopActivityGroups } from '@/desktop/desktop-activity-state';
import { systemActivityRecords } from '@/desktop/system-task-activity';
import { taskCentreRecords } from '@/desktop/task-centre-model';
import { describeSentinelUpdate, sentinelUpdateProgressOptions, type SentinelUpdateView } from '../sentinel-update-progress';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { SentinelStatus } from './sentinel-status';
import {
  type SentinelRecoveryAccess,
  SentinelStatusError,
  type SentinelStatus as Status,
  sentinelRecoveryAccessOptions,
  sentinelStatusOptions,
} from '../sentinel-status';

const healthy: Status = { available: true, installedVersion: '0.1.0-dev.11', availableVersion: null, state: 'healthy' };

type RenderOptions = {
  value?: Status;
  error?: Error;
  active?: boolean;
  operator?: boolean;
  access?: SentinelRecoveryAccess;
  accessError?: Error;
};

function render({ value, error, active = true, operator = false, access, accessError }: RenderOptions = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const options = sentinelStatusOptions(active);
  if (value) client.setQueryData(options.queryKey, value);
  if (error) client.getQueryCache().build(client, { queryKey: options.queryKey }).setState({ status: 'error', error });
  const accessOptions = sentinelRecoveryAccessOptions(active);
  if (access) client.setQueryData(accessOptions.queryKey, access);
  if (accessError) client.getQueryCache().build(client, { queryKey: accessOptions.queryKey }).setState({ status: 'error', error: accessError });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SentinelStatus active={active} operator={operator} />
    </QueryClientProvider>,
  );
  client.clear();
  return markup;
}

function renderProgress(updateProgress: SentinelUpdateView, operator = true) {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SentinelStatus active operator={operator} updateProgress={updateProgress} />
    </QueryClientProvider>,
  );
  client.clear();
  return markup;
}

const observed: SentinelUpdateJob = {
  id: 'a'.repeat(32),
  version: '1.2.3',
  phase: 'downloading',
  startedAt: 100,
  updatedAt: 200,
  download: { file: 'release', currentBytes: 1024, totalBytes: 4096 },
};

test('the Updates card renders observed file bytes and changes to indeterminate verification', () => {
  const renderJob = (job: SentinelUpdateJob) => renderProgress({ jobs: [job], pending: false, unavailable: false });
  const downloading = renderJob(observed);
  expect(downloading).toContain('Sentinel release · 1 KiB of 4 KiB');
  expect(downloading).toContain('value="25"');
  const unknown = renderJob({ ...observed, download: { file: 'release', currentBytes: 1024, totalBytes: null } });
  expect(unknown).toContain('1 KiB downloaded');
  expect(unknown).toContain('data-known="false"');
  const verifying = renderJob({ ...observed, phase: 'verifying', download: null });
  expect(verifying).toContain('Verifying Sentinel publisher');
  expect(verifying).toContain('data-known="false"');
  expect(verifying).not.toContain('value="100"');
  const staging = renderJob({ ...observed, phase: 'staging', download: null });
  expect(staging).toContain('Staging verified Sentinel files');
  expect(staging).toContain('data-known="false"');
  expect(describeSentinelUpdate({ ...observed, download: { file: 'release', currentBytes: 4096, totalBytes: 4096 } }).percentage).toBeUndefined();
});

test('the Updates card reports unsupported progress and hides operator data from other sessions', () => {
  const unavailable = { jobs: [], pending: false, unavailable: true };
  expect(renderProgress(unavailable)).toContain('Sentinel update progress is unavailable.');
  expect(renderProgress({ jobs: [observed], pending: false, unavailable: false }, false)).not.toContain('1 KiB');
});

test('global activity projects current and terminal Sentinel work without an Updates page or Core/package job', () => {
  const concurrent: SentinelUpdateJob[] = [observed, { ...observed, id: 'b'.repeat(32), version: '1.2.4', phase: 'installing', download: null }];
  const groups = desktopActivityGroups([], new Map(), null, null, [], null, concurrent);
  expect(groups.map(({ category }) => category)).toEqual(['sentinel']);
  expect(groups[0]).toMatchObject({ count: 2, percentage: undefined });
  expect(groups[0]?.items.map(({ title }) => title)).toEqual(['Sentinel 1.2.3', 'Sentinel 1.2.4']);
  const terminal: SentinelUpdateJob = { ...observed, phase: 'rolled-back', download: null };
  expect(desktopActivityGroups([], new Map(), null, null, [], null, [terminal])).toEqual([]);
  expect(systemActivityRecords({ sentinel: [terminal] })).toMatchObject([{ bucket: 'review', status: 'Sentinel update failed and was rolled back' }]);
  const prepared = systemActivityRecords({ sentinel: [{ ...terminal, phase: 'prepared' }] });
  expect(taskCentreRecords({ tasks: [], system: prepared })).toMatchObject([{ outcome: 'unconfirmed', source: 'Sentinel updates' }]);
});

test('a fresh query reconnects to current Host work and navigating shares the session cache', async () => {
  const originalFetch = globalThis.fetch;
  const client = new QueryClient();
  const session = new AbortController();
  const dock = sentinelUpdateProgressOptions(6, session.signal, true, true);
  const updates = sentinelUpdateProgressOptions(6, session.signal, true, false);
  let reads = 0;
  globalThis.fetch = Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      reads++;
      expect(request).toBe('/api/system/sentinel/update-progress');
      expect(init?.method).toBe('GET');
      return Response.json({ version: 1, available: true, jobs: [observed] });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    expect((await client.fetchQuery(dock)).jobs).toEqual([observed]);
    expect((await client.fetchQuery(updates)).jobs).toEqual([observed]);
    expect(reads).toBe(1);
    expect(client.getQueryData(sentinelUpdateProgressOptions(6, new AbortController().signal, true, false).queryKey)).toBeUndefined();
    session.abort();
    expect(sentinelUpdateProgressOptions(6, session.signal, true, true).enabled).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    client.clear();
  }
});

test('Sentinel spans the bottom row and the Updates grid keeps its narrow single-column reflow', async () => {
  const css = await Bun.file(new URL('./updates.css', import.meta.url)).text();
  expect(css).toMatch(/\.desktop-updates-sentinel\s*\{\s*grid-column: 1 \/ -1;/);
  expect(css).toMatch(/@container \(max-width: 49rem\)\s*\{\s*\.desktop-updates-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/);
  expect(css).not.toMatch(/\.desktop-updates-card-orbis\s*\{[^}]*grid-column/);
});

test('shows the independently reported version and service status in a labelled definition list', () => {
  const markup = render({ value: healthy });
  expect(markup).toContain('>Sentinel</h2>');
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

const portalUrl = 'https://independent.example:8443/sentinel/recovery/';

test('shows the staged operator the next human step without claiming emergency key confirmation', () => {
  const access = { state: 'configured', portalUrl, unitState: 'active', enrollment: 'key-prepared' } as const;
  const operator = render({ operator: true, access });
  expect(operator).toContain('Emergency key prepared.');
  expect(operator).toContain('confirm the saved file');
  expect(operator).not.toContain('Host recorded a key acknowledgment.');
  expect(render({ access })).not.toContain('Emergency key prepared.');
});

test('renders a native recovery link to the reported independent portal with qualified unit state', () => {
  for (const unitState of ['active', 'inactive', 'unknown'] as const) {
    const markup = render({ access: { state: 'configured', portalUrl, unitState } });
    expect(markup).toContain(`href="${portalUrl}" target="_blank" rel="noopener noreferrer">Open recovery</a>`);
    expect(markup).toContain(unitState === 'unknown' ? 'Recovery service status unknown.' : `Recovery service ${unitState}.`);
    expect(markup).toContain('Open the portal to check sign-in availability.');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('tabindex=');
  }
});

test('healthy Sentinel and stale access after authentication failure cannot fabricate recovery access', () => {
  const missing = render({ value: healthy, access: { state: 'missing', portalUrl: null, unitState: null } });
  expect(missing).toContain('Recovery portal setup required.');
  expect(missing).not.toContain('href=');
  const stale = render({
    value: healthy,
    operator: true,
    access: { state: 'configured', portalUrl, unitState: 'active', enrollment: 'activated' },
    accessError: new SentinelStatusError(401),
  });
  expect(stale).toContain('Sign in again to check recovery access.');
  expect(stale).not.toContain('href=');
  expect(stale).not.toContain('Recovery service active.');
  expect(stale).not.toContain('Recovery credentials activated.');
  const unknownEnrollment = render({ operator: true, access: { state: 'configured', portalUrl, unitState: 'active' } });
  expect(unknownEnrollment).toContain('Enrollment progress could not be verified.');
  expect(unknownEnrollment).not.toContain('Recovery credentials activated.');
  const unavailable = render({ value: healthy, access: { state: 'unavailable', portalUrl: null, unitState: null } });
  expect(unavailable).toContain('Recovery access could not be verified.');
  expect(unavailable).not.toContain('href=');
});

test('recovery entry is offered only to an operator with active, activated recovery', () => {
  const access = { state: 'configured', portalUrl, unitState: 'active', enrollment: 'activated' } as const;
  expect(render({ operator: true, access })).toContain('Enter recovery');
  expect(render({ access })).not.toContain('Enter recovery');
  expect(render({ operator: true, access: { ...access, unitState: 'inactive' } })).not.toContain('Enter recovery');
  expect(render({ operator: true, access: { ...access, enrollment: 'operator-staged' } })).not.toContain('Enter recovery');
  expect(render({ operator: true, access, accessError: new SentinelStatusError(401) })).not.toContain('Enter recovery');
});
