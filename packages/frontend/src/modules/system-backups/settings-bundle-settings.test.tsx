import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { SettingsBundleSettings, pendingAcceptedExport, settingsRestoreCanReload } from './settings-bundle-settings';

test.each(['running', 'recovery-required', 'unknown'] as const)(
  'blocks new work while restore status is %s and keeps verified downloads available',
  (status) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    client.setQueryData(['orbis-settings-bundles', 7, 'exports'], {
      version: 1,
      jobs: [
        {
          version: 1,
          id,
          createdAt: 1,
          status: 'ready',
          stage: 'complete',
          completedBytes: 64,
          totalBytes: 64,
          bytes: 64,
          sha256: 'a'.repeat(64),
          selection: { version: 1, settings: true, dashboard: false, wallpapers: false, themes: false, timeMachine: [] },
        },
      ],
    });
    client.setQueryData(['orbis-settings-bundles', 7, 'imports'], { available: true, jobs: [] });
    if (status !== 'unknown')
      client.setQueryData(['orbis-settings-bundles', 7, 'restore'], {
        job: { id, status, stage: status === 'running' ? 'applying' : 'recovery', needsRecovery: status === 'recovery-required', canRollback: true },
      });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AppContextProvider>
            <SettingsBundleSettings />
          </AppContextProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Create backup<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Restore<\/button>/);
    expect(html.match(/<button[^>]*>Download<\/button>/)?.[0]).not.toContain('disabled');
    if (status !== 'unknown') expect(html.match(/<button[^>]*>Roll back<\/button>/)?.[0]).not.toContain('disabled');
    client.clear();
  },
);

test('a routed file cannot upload while settings restore recovery is held', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
  client.setQueryData(['orbis-settings-bundles', 7, 'exports'], { version: 1, jobs: [] });
  client.setQueryData(['orbis-settings-bundles', 7, 'imports'], { available: true, jobs: [] });
  client.setQueryData(['orbis-settings-bundles', 7, 'restore'], {
    job: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'recovery-required', stage: 'recovery', needsRecovery: true, canRollback: true },
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AppContextProvider>
          <SettingsBundleSettings restoreOnly initialFile={new File(['fixture'], 'backup.orbis-settings')} />
        </AppContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Upload<\/button>/);
  client.clear();
});

test('shows verified contents and download for a ready backup', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const available = { version: 1, settings: true, dashboard: false, wallpapers: false, themes: false, timeMachine: [] };
  client.setQueryData(['orbis-settings-bundles', 7, 'exports'], {
    version: 1,
    jobs: [
      {
        version: 1,
        id,
        createdAt: 1,
        status: 'ready',
        stage: 'complete',
        completedBytes: 64,
        totalBytes: 64,
        bytes: 64,
        sha256: 'a'.repeat(64),
        selection: available,
      },
    ],
  });
  client.setQueryData(['orbis-settings-bundles', 7, 'imports'], {
    available: true,
    jobs: [
      {
        id,
        createdAt: 1,
        updatedAt: 2,
        status: 'reviewed',
        uploadedBytes: 64,
        completedBytes: 64,
        totalBytes: 64,
        message: 'Verified',
        review: {
          version: 1,
          reviewId: id,
          archiveSha256: 'a'.repeat(64),
          createdAt: '2026-01-01T00:00:00.000Z',
          orbisVersion: '1.0',
          contents: [{ kind: 'settings', id: null, bytes: 64, items: 2 }],
          available,
          expiresAt: Date.now() + 60000,
        },
      },
    ],
  });
  client.setQueryData(['orbis-settings-bundles', 7, 'restore'], { job: null });
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AppContextProvider>
          <SettingsBundleSettings />
        </AppContextProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  expect(markup).toContain('Ready to download');
  expect(markup).toContain('Download');
  expect(markup).toContain('Settings · 64 B · 2 items');
  expect(markup).toContain('Choose what to restore');
  expect(markup).toContain('doesn’t take a new copy of your apps or media');
  const render = () =>
    renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <AppContextProvider>
            <SettingsBundleSettings />
          </AppContextProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  client
    .getQueryCache()
    .find({ queryKey: ['orbis-settings-bundles', 7, 'imports'] })
    ?.setState({ status: 'error', error: new Error('unavailable') });
  let failed = render();
  expect(failed).toMatch(/>Download<\/button>/);
  expect(failed).toContain('Import status could not be loaded');
  client
    .getQueryCache()
    .find({ queryKey: ['orbis-settings-bundles', 7, 'restore'] })
    ?.setState({ status: 'error', error: new Error('unavailable') });
  failed = render();
  expect(failed).toMatch(/>Download<\/button>/);
  expect(failed).toMatch(/disabled=""[^>]*>Choose what to restore<\/button>/);
  client
    .getQueryCache()
    .find({ queryKey: ['orbis-settings-bundles', 7, 'exports'] })
    ?.setState({ status: 'error', error: new Error('unavailable') });
  failed = render();
  expect(failed).toContain('Ready to download');
  expect(failed).toMatch(/disabled=""[^>]*>Download<\/button>/);
  client.clear();
});

test('dashboard reload follows only the observed completed restore, never old, active or recovery-held status', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const succeeded = { id, status: 'succeeded' as const, stage: 'complete' as const, needsRecovery: false, canRollback: false };
  expect(settingsRestoreCanReload(succeeded, id, null)).toBe(true);
  expect(settingsRestoreCanReload(succeeded, null, null)).toBe(false);
  expect(settingsRestoreCanReload(succeeded, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null)).toBe(false);
  expect(settingsRestoreCanReload(succeeded, id, id)).toBe(false);
  expect(settingsRestoreCanReload({ ...succeeded, status: 'running', stage: 'applying', canRollback: true }, id, null)).toBe(false);
  expect(
    settingsRestoreCanReload({ ...succeeded, status: 'recovery-required', stage: 'recovery', needsRecovery: true, canRollback: true }, id, null),
  ).toBe(false);
});

test('accepted export stops being a fallback once its id has appeared', () => {
  const accepted = { id: 'accepted', status: 'queued' } as NonNullable<Parameters<typeof pendingAcceptedExport>[0]>;
  expect(pendingAcceptedExport(accepted, [])).toBe(accepted);
  const cleared = pendingAcceptedExport(accepted, [accepted]);
  expect(cleared).toBeNull();
  expect(pendingAcceptedExport(cleared, [])).toBeNull();
});
