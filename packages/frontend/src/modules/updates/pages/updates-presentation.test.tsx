import { expect, test } from 'bun:test';
import { orbisReleaseChannelStatus } from '@runtipi/common/schemas/orbis-release-channel';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { appContextQueryKey, getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { ClusterContext } from '@/desktop/cluster-context';
import { installedOrbisBuildOptions, orbisPublishedReleasesOptions, orbisReleasesOptions } from '@/desktop/orbis-release';
import { orbisReleaseChannelsOptions } from '@/desktop/release-channels';
import { sentinelStatusOptions } from '../sentinel-status';
import { OrbisDowngrade } from './orbis-downgrade';
import Updates from './updates';

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

test('downgrade is a permanent labelled section with the primary Downgrade action', () => {
  const { markup, requests } = renderDowngrade();
  expect(markup).toContain('<section class="desktop-downgrade" aria-label="Downgrade">');
  expect(markup).toContain('<h3>Downgrade</h3>');
  expect(markup).not.toContain('<details');
  expect(markup).not.toContain('<summary');
  expect(markup).toContain('>Downgrade</button>');
  expect(markup).not.toContain('Open last downgrade plan');
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

function renderLocalUpdates({
  operator = true,
  legacyHelper = false,
  jobState,
  operatingSystem = 'Ubuntu 24.04 LTS',
  releaseBody = 'Release notes',
}: {
  operator?: boolean;
  legacyHelper?: boolean;
  jobState?: 'running' | 'complete';
  operatingSystem?: string;
  releaseBody?: string;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator }, version: { current: '4.10.1' } });
  client.setQueryData(getInstalledAppsOptions().queryKey, { installed: [] });
  client.setQueryData(installedOrbisBuildOptions().queryKey, {
    version: 'v0.1.0',
    commit: '0123456789ab',
    imageDigest: null,
    runtipiCompatibility: '4.10.1',
  });
  client.setQueryData(orbisReleaseChannelsOptions().queryKey, orbisReleaseChannelStatus);
  client.setQueryData(orbisReleasesOptions('stable').queryKey, [
    {
      tag: 'v0.2.0',
      imageManifestUrl: 'https://example.test/manifest.json',
      publishedAt: null,
      body: releaseBody,
      url: 'https://example.test/release',
    },
  ]);
  client.setQueryData(['orbis-host-update-status'], {
    available: true,
    enrolled: true,
    imageMatches: true,
    coreState: 'running',
    coreHealth: 'healthy',
    currentTag: 'v0.1.0',
    capabilities: legacyHelper ? ['restart.v1'] : ['restart.v1', 'packages.refresh.v1'],
  });
  client.setQueryData(['orbis-host-packages'], {
    available: true,
    operatingSystem,
    checkedAt: '2026-11-19T05:00:00Z',
    packageCount: 1,
    packages: [{ name: 'test-package', installedVersion: '1', candidateVersion: '2', downloadBytes: 1024, security: false, sources: [] }],
  });
  client.setQueryData(['orbis-host-package-job'], {
    available: true,
    job: jobState ? { id: 'job', state: jobState, message: 'Recorded package operation' } : null,
  });
  client.setQueryData(sentinelStatusOptions(true).queryKey, {
    available: true,
    state: 'healthy',
    installedVersion: '0.1.0',
    availableVersion: null,
  });
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AppContextProvider>
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
            <Updates />
          </ClusterContext.Provider>
        </AppContextProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  client.clear();
  return markup;
}

test('default System view brings the Orbis, OS and service statuses together while Applications stays separate', () => {
  const markup = renderLocalUpdates();
  expect(markup).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>.*?<span>System<\/span><\/button>/);
  expect(markup).toMatch(/<section[^>]*desktop-updates-apps[^>]*role="tabpanel"[^>]*hidden=""/);
  for (const heading of ['Orbis', 'Operating system', 'Sentinel']) {
    expect(markup).toMatch(new RegExp(`<h2[^>]*>${heading}</h2>`));
  }
  expect(markup).toMatch(/desktop-updates-sentinel[^>]*>[\s\S]*<h3>System connection<\/h3>/);
  expect(markup).not.toMatch(/<h2[^>]*>Host service<\/h2>/);
  expect(markup).toContain('Update Orbis');
  expect(markup).toContain('Update system');
  expect(markup).toContain('1 update available');
  expect(markup).toMatch(/<details class="desktop-system-update-details(?: desktop-orbis-update-details)?"><summary>/);
  expect(markup).toContain('Package details and exclusions');
  expect(markup).toContain('Installed build details');
  expect(markup).toContain('Last checked <time dateTime="2026-11-19T05:00:00Z">');
  expect(markup).toContain('>Release notes</p>');
  expect(markup).toContain('/settings?tab=updates');
});

test('legacy helper capabilities and operator permissions still control system actions and inventory details', () => {
  const legacy = renderLocalUpdates({ legacyHelper: true });
  expect(legacy).toContain('System service update needed');
  expect(legacy).toContain('View setup guide');
  expect(legacy).toMatch(/<button[^>]*desktop-update-check[^>]*disabled=""[^>]*>/);
  const member = renderLocalUpdates({ operator: false });
  expect(member).toContain('Host package details require an operator account.');
  expect(member).not.toContain('Filter package details');
  expect(member).not.toContain('Check for updates');
  expect(member).not.toContain('Update system');
  expect(member).toMatch(/<button[^>]*desktop-system-update-primary[^>]*disabled=""[^>]*>/);
});

test('active package progress stays in the System view and completed output remains available through its disclosure', () => {
  const active = renderLocalUpdates({ jobState: 'running' });
  expect(active).toContain('Installing system updates');
  expect(active).toContain('View live output');
  expect(active).toMatch(/<button[^>]*desktop-system-update-primary[^>]*disabled=""[^>]*>/);
  const complete = renderLocalUpdates({ jobState: 'complete' });
  expect(complete).toMatch(/data-state="complete"[^>]*><details><summary>/);
  expect(complete).toContain('System update complete');
  expect(complete).toContain('Recorded package operation');
  expect(complete).not.toContain('<progress');
});

test('Orbis and distro branding uses the installed logo and a neutral icon for unrecognized hosts', () => {
  const ubuntu = renderLocalUpdates();
  expect(ubuntu).toMatch(/data-brand="orbis"[^>]*><svg class="orbis-logo"/);
  expect(ubuntu).toMatch(/data-brand="ubuntu"[^>]*><svg[^>]*tabler-icon-brand-ubuntu/);
  expect(renderLocalUpdates({ operatingSystem: 'Debian GNU/Linux 13 (trixie)' })).toMatch(/data-brand="debian"[^>]*><img[^>]*alt=""/);
  expect(renderLocalUpdates({ operatingSystem: 'Red Hat Enterprise Linux 10' })).toContain('tabler-icon-brand-redhat');

  const unknown = renderLocalUpdates({ operatingSystem: 'Linux appliance based on Ubuntu' });
  expect(unknown).toContain('Linux appliance based on Ubuntu');
  expect(unknown).toContain('tabler-icon-device-desktop-cog');
  expect(unknown).not.toContain('tabler-icon-brand-ubuntu');
  expect(renderLocalUpdates({ operatingSystem: '' })).toContain('tabler-icon-device-desktop-cog');
});

test('long release notes start folded and keep their own release entry', () => {
  const markup = renderLocalUpdates({ releaseBody: 'Long release notes. '.repeat(50) });
  expect(markup).toMatch(/<details class="desktop-release-note"><summary>/);
  expect(markup).toContain('View release on GitHub');
  expect(markup).not.toContain('Long release notes.');
});
