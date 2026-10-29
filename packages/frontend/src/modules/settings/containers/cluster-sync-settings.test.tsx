import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { ClusterSyncHostChoices, ClusterSyncSettings } from './cluster-sync-settings';
import { clusterSyncKey, type ClusterSyncHost, type ClusterSyncSnapshot } from './cluster-sync-api';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const host: ClusterSyncHost = {
  id,
  name: 'Receiving server',
  available: true,
  accepted: ['customisation', 'orbis-updates', 'app-updates', 'schedules'],
  revisions: { customisation: 'a'.repeat(64) },
  receipts: {},
  plan: null,
};
const run = async () => undefined;
async function checkboxes(markup: string) {
  const boxes: { id: string; checked: boolean; disabled: boolean }[] = [];
  await new HTMLRewriter()
    .on('input[type=checkbox]', {
      element: (element) => {
        boxes.push({ id: element.getAttribute('id') ?? '', checked: element.hasAttribute('checked'), disabled: element.hasAttribute('disabled') });
      },
    })
    .transform(new Response(markup))
    .text();
  return boxes;
}
test('unselected hosts render one unchecked host choice and no implicit selected categories', async () => {
  const markup = renderToStaticMarkup(<ClusterSyncHostChoices host={host} busy={false} run={run} />);
  expect((await checkboxes(markup)).map((box) => box.checked)).toEqual([false]);
  expect(markup).toContain('orbis-checkbox cluster-sync-check');
  expect(markup).toContain('Sync to this server');
  expect(markup).not.toContain('Sync now');
});
test('reloaded saved rules hydrate exact category and keep-in-sync controls', async () => {
  const plan = {
    hostId: id,
    revision: 2,
    categories: ['customisation' as const],
    automatic: true,
    status: 'synced' as const,
    lastAttemptAt: null,
    results: [],
    usesYourAccount: true,
    trustCurrent: true,
  };
  const markup = renderToStaticMarkup(<ClusterSyncHostChoices host={{ ...host, plan }} busy={false} run={run} />);
  const boxes = await checkboxes(markup);
  expect(boxes.filter((box) => box.checked)).toHaveLength(3);
  expect(boxes.find((box) => box.id.endsWith('-customisation'))?.checked).toBe(true);
  expect(boxes.find((box) => box.id.endsWith('-schedules'))?.checked).toBe(false);
  expect(markup).toContain('Sync now');
  expect(markup).toContain('Selected settings synced');
  expect(markup).toContain('orbis-checkbox cluster-sync-check');
  expect(markup).toContain('Keep selected settings in sync');
});
test('pairing changes, offline hosts and account mismatches make retry explicit', () => {
  const plan = {
    hostId: id,
    revision: 2,
    categories: ['customisation' as const],
    automatic: true,
    status: 'unavailable' as const,
    lastAttemptAt: null,
    results: [{ category: 'customisation' as const, status: 'unsupported' as const, skippedApps: 0 }],
    usesYourAccount: false,
    trustCurrent: false,
  };
  const markup = renderToStaticMarkup(<ClusterSyncHostChoices host={{ ...host, available: false, plan }} busy={false} run={run} />);
  expect(markup).toContain('Pairing changed');
  expect(markup).toContain('another admin account');
  expect(markup).toContain('Unavailable');
  expect(markup).toContain('Unsupported local settings');
  expect(markup).toContain('disabled=""');
});
test('member receiving choices reload without account, hostname, wallpaper upload or package-install controls', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
  const value: ClusterSyncSnapshot = {
    version: 1,
    role: 'member',
    receiving: { revision: 3, categories: ['customisation'], configured: true, usesYourAccount: true },
    hosts: [],
    source: null,
  };
  client.setQueryData(clusterSyncKey(7), value);
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppContextProvider>
        <ClusterSyncSettings />
      </AppContextProvider>
    </QueryClientProvider>,
  );
  client.clear();
  expect((await checkboxes(markup)).find((box) => box.id.endsWith('-customisation'))?.checked).toBe(true);
  expect(markup).toContain('your account here');
  expect(markup).toContain('Private wallpapers');
  expect(markup).toContain('Save receiving choices');
  expect(markup).not.toContain('type="password"');
  expect(markup).not.toContain('Install');
});
