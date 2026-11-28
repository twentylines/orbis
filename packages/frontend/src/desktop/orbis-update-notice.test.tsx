import { expect, test } from 'bun:test';
import { orbisReleaseChannelStatus } from '@runtipi/common/schemas/orbis-release-channel';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { createAppQueryClient } from '@/lib/query-client';
import { ClusterContext } from './cluster-context';
import { orbisUpdateEligibilityOptions } from './core-update-api';
import { HostUpdateProvider } from './host-update-watch';
import { installedOrbisBuildOptions, orbisReleasesOptions } from './orbis-release';
import { orbisReleaseChannelsOptions } from './release-channels';
import { OrbisUpdateIcon, OrbisUpdateNotice } from './orbis-update-notice';

test.each([undefined, false, true])('the top bar offers only a verified compatible release (%s)', (compatible) => {
  const client = createAppQueryClient();
  const installed = 'v0.9.1';
  const target = 'v0.9.2-beta.11';
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
  client.setQueryData(orbisReleaseChannelsOptions().queryKey, { ...orbisReleaseChannelStatus, current: 'nightly' });
  client.setQueryData(installedOrbisBuildOptions().queryKey, {
    version: installed,
    commit: null,
    imageDigest: null,
    runtipiCompatibility: '4.10.1',
  });
  client.setQueryData(orbisReleasesOptions('nightly').queryKey, [
    {
      tag: target,
      publishedAt: null,
      body: '',
      url: 'https://example.invalid/release',
      imageManifestUrl: 'https://example.invalid/manifest',
    },
  ]);
  client.setQueryData(['orbis-host-update-status'], {
    available: true,
    enrolled: true,
    currentTag: installed,
    coreState: 'running',
    coreHealth: 'healthy',
    imageMatches: true,
    capabilities: ['runtipi-412-update.v1'],
  });
  if (compatible !== undefined)
    client.setQueryData(orbisUpdateEligibilityOptions(target, 7, installed, '4.10.1', true).queryKey, {
      tag: target,
      currentRuntipiVersion: '4.10.1',
      targetRuntipiVersion: '4.12.0',
      crossesRuntipiBoundary: true,
      hostUpdateSupported: compatible,
      warning: null,
    });
  const rendered = renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AppContextProvider>
          <HostUpdateProvider>
            <ClusterContext.Provider
              value={{
                data: undefined,
                selectedId: 'local',
                selectedServer: undefined,
                merged: false,
                select: () => undefined,
                isPending: false,
                isError: false,
                refetch: async () => undefined,
              }}
            >
              <OrbisUpdateNotice />
            </ClusterContext.Provider>
          </HostUpdateProvider>
        </AppContextProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  client.clear();
  expect(rendered.includes('Update to Orbis')).toBe(compatible === true);
});

test('the update icon stays active during submission and stops after a rejected request', async () => {
  const client = createAppQueryClient();
  let rejectRequest: ((error: Error) => void) | undefined;
  const request = new Promise<never>((_resolve, reject) => {
    rejectRequest = reject;
  });
  const mutation = client.getMutationCache().build(client, {
    mutationKey: ['orbis-compatibility', 'update', 1, 'v1.1.0', 'apply'],
    mutationFn: () => request,
    retry: false,
  });
  const submitted = mutation.execute(undefined).catch(() => undefined);
  const render = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <OrbisUpdateIcon />
      </QueryClientProvider>,
    );
  expect(render()).toContain('orbis-update-spinning');
  rejectRequest?.(new Error('Declared request failure'));
  await submitted;
  expect(render()).not.toContain('orbis-update-spinning');
  client.clear();
});

test('a compatibility review alone does not spin the update icon', async () => {
  const client = createAppQueryClient();
  let finish: (() => void) | undefined;
  const request = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const mutation = client.getMutationCache().build(client, {
    mutationKey: ['orbis-compatibility', 'update', 1, 'v1.1.0'],
    mutationFn: () => request,
  });
  const submitted = mutation.execute(undefined);
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <OrbisUpdateIcon />
    </QueryClientProvider>,
  );
  expect(markup).not.toContain('orbis-update-spinning');
  finish?.();
  await submitted;
  client.clear();
});
