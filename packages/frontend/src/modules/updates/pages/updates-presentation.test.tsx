import { expect, test } from 'bun:test';
import { orbisReleaseChannelStatus } from '@runtipi/common/schemas/orbis-release-channel';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { appContextQueryKey, getInstalledAppsOptions, userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { UserContextProvider } from '@/context/user-context';
import { ClusterContext } from '@/desktop/cluster-context';
import { installedOrbisBuildOptions, orbisPublishedReleasesOptions, orbisReleasesOptions } from '@/desktop/orbis-release';
import { orbisReleaseChannelsOptions } from '@/desktop/release-channels';
import { sentinelStatusOptions } from '../sentinel-status';
import { OrbisDowngrade } from './orbis-downgrade';
import { orbisUpdateEligibilityOptions } from '@/desktop/core-update-api';
import Updates, { checkUpdateSources } from './updates';

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
  packageRefresh = false,
  operatingSystem = 'Ubuntu 24.04 LTS',
  releaseBody = 'Release notes',
  releaseChannel = 'stable',
  coreRequest,
  runningCore = false,
  unbackedInterrupted = false,
  queryClient,
  packagesReady = 'available',
  readyCount = 1,
  deferredCount = 0,
  includeAppUpdate = false,
  releaseEligible = true,
}: {
  operator?: boolean;
  legacyHelper?: boolean;
  jobState?: 'running' | 'complete';
  packageRefresh?: boolean;
  operatingSystem?: string;
  releaseBody?: string;
  releaseChannel?: 'stable' | 'nightly';
  coreRequest?: 'review';
  runningCore?: boolean;
  unbackedInterrupted?: boolean;
  queryClient?: QueryClient;
  packagesReady?: 'available' | 'unavailable' | 'legacy';
  readyCount?: number;
  deferredCount?: number;
  includeAppUpdate?: boolean;
  releaseEligible?: boolean;
} = {}) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator }, version: { current: '4.10.1' } });
  client.setQueryData<unknown>(getInstalledAppsOptions().queryKey, {
    installed: includeAppUpdate ? [{ app: { version: 2 }, info: { urn: 'notes:community', name: 'Notes' }, metadata: { latestVersion: 3 } }] : [],
  });
  client.setQueryData(installedOrbisBuildOptions().queryKey, {
    version: 'v0.1.0',
    commit: '0123456789ab',
    imageDigest: null,
    runtipiCompatibility: '4.10.1',
  });
  client.setQueryData(orbisReleaseChannelsOptions().queryKey, { ...orbisReleaseChannelStatus, current: releaseChannel });
  client.setQueryData(orbisReleasesOptions(releaseChannel).queryKey, [
    {
      tag: 'v0.2.0',
      imageManifestUrl: 'https://example.test/manifest.json',
      publishedAt: null,
      body: releaseBody,
      url: 'https://example.test/release',
    },
  ]);
  client.setQueryData(orbisUpdateEligibilityOptions('v0.2.0', 7, 'v0.1.0', '4.10.1', false).queryKey, {
    tag: 'v0.2.0',
    currentRuntipiVersion: '4.10.1',
    targetRuntipiVersion: releaseEligible ? '4.10.1' : '4.12.0',
    crossesRuntipiBoundary: !releaseEligible,
    hostUpdateSupported: releaseEligible,
    warning: null,
  });
  client.setQueryData(['orbis-host-update-status'], {
    available: true,
    enrolled: true,
    imageMatches: true,
    coreState: 'running',
    coreHealth: 'healthy',
    currentTag: 'v0.1.0',
    job: unbackedInterrupted
      ? {
          id: 'core',
          state: 'interrupted',
          phase: 'recovery-required',
          backupPolicy: 'none',
          message: 'This update has no automatic data backup. Preserve its state for local recovery review.',
        }
      : runningCore
        ? { id: 'core', state: 'running', message: 'Downloading image' }
        : null,
    capabilities: legacyHelper ? ['restart.v1'] : ['restart.v1', 'packages.refresh.v1'],
  });
  client.setQueryData(['orbis-host-packages'], {
    available: true,
    operatingSystem,
    checkedAt: '2026-11-19T05:00:00Z',
    packageCount: readyCount + deferredCount,
    readiness: packagesReady === 'legacy' ? undefined : packagesReady,
    readyPackageCount: packagesReady === 'available' ? readyCount : undefined,
    deferredPackageCount: packagesReady === 'available' ? deferredCount : undefined,
    packages: Array.from({ length: readyCount + deferredCount }, (_, index) => ({
      name: `test-package-${index}`,
      installedVersion: '1',
      candidateVersion: '2',
      downloadBytes: 1024,
      security: false,
      sources: [],
      ready: packagesReady === 'available' ? index < readyCount : undefined,
    })),
  });
  client.setQueryData(['orbis-host-package-job'], {
    available: true,
    job: jobState ? { id: 'job', state: jobState, kind: packageRefresh ? 'refresh' : undefined, message: 'Recorded package operation' } : null,
  });
  client.setQueryData(userContextQueryKey(), { isLoggedIn: true });
  client.setQueryData(sentinelStatusOptions(true).queryKey, {
    available: true,
    state: 'healthy',
    installedVersion: '0.1.0',
    availableVersion: null,
  });
  if (coreRequest) {
    client.getMutationCache().build(
      client,
      { mutationKey: ['orbis-compatibility', 'update', 7, 'v0.1.0'] },
      {
        status: 'pending',
        error: null,
        failureReason: null,
        data: undefined,
        variables: 'v0.2.0',
        context: undefined,
        failureCount: 0,
        isPaused: false,
        submittedAt: Date.now(),
      },
    );
  }
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <UserContextProvider>
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
        </UserContextProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  if (!queryClient) client.clear();
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
  expect(markup).toContain('1 update ready');
  expect(markup).toMatch(/<details class="desktop-system-update-details(?: desktop-orbis-update-details)?"><summary>/);
  expect(markup).toContain('Package details and exclusions');
  expect(markup).toContain('Installed build details');
  expect(markup).toContain('Last checked <time dateTime="2026-11-19T05:00:00Z">');
  expect(markup).toContain('>Release notes</p>');
  expect(markup).toContain('/settings?tab=updates');
  expect(markup.match(/<button[^>]*desktop-update-check[^>]*>/g)).toHaveLength(1);
  expect(markup.indexOf('desktop-update-check')).toBeLessThan(markup.indexOf('desktop-updates-card-orbis'));
});

test('the Orbis action follows the release status without labelling the release by the selected channel', () => {
  const markup = renderLocalUpdates({ releaseChannel: 'nightly' });
  expect(markup).toMatch(/Update available <strong>0\.2\.0<\/strong><\/p><\/div><button[^>]*desktop-system-update-primary[^>]*>Update Orbis/);
});

test('an unsupported Nightly is listed without an install action or availability claim', () => {
  const markup = renderLocalUpdates({ releaseChannel: 'nightly', releaseEligible: false });
  expect(markup).toContain('Latest release <strong>0.2.0</strong>');
  expect(markup).toContain('This release requires a supported Orbis Host updater.');
  expect(markup).not.toContain('>Update Orbis</button>');
  expect(markup).not.toContain('Update available <strong>0.2.0</strong>');
});

test('legacy helper capabilities and operator permissions still control system actions and inventory details', () => {
  const legacy = renderLocalUpdates({ legacyHelper: true });
  expect(legacy).toContain('System service update needed');
  expect(legacy).toContain('View setup guide');
  expect(legacy).toMatch(/<button[^>]*desktop-update-check[^>]*aria-disabled="false"[^>]*>/);
  const member = renderLocalUpdates({ operator: false });
  expect(member).toContain('Host package details require an operator account.');
  expect(member).not.toContain('Filter package details');
  expect(member).toMatch(/<button[^>]*desktop-update-check[^>]*aria-disabled="false"[^>]*>/);
  expect(member).not.toContain('Update system');
  expect(member).toMatch(/<button[^>]*desktop-system-update-primary[^>]*disabled=""[^>]*>/);
});

test('the global check runs both admitted sources independently even if one fails', async () => {
  const started: string[] = [];
  const activity: boolean[] = [];
  const pending = { current: false };
  let finishPackages!: (value: string) => void;
  const packages = new Promise<string>((resolve) => {
    finishPackages = resolve;
  });
  const request = {
    blocked: false,
    onChecking: (value: boolean) => activity.push(value),
    checkOrbis: () => {
      started.push('orbis');
      throw new Error('release unavailable');
    },
    checkSystem: () => {
      started.push('os');
      return packages;
    },
  };
  const result = checkUpdateSources(pending, request);
  await Promise.resolve();
  expect(started).toEqual(['orbis', 'os']);
  expect(await checkUpdateSources(pending, request)).toBeUndefined();
  expect(started).toEqual(['orbis', 'os']);
  expect(activity).toEqual([true]);
  finishPackages('checked');
  expect(await result).toMatchObject([{ status: 'rejected' }, { status: 'fulfilled', value: 'checked' }]);
  expect(activity).toEqual([true, false]);
  expect(await checkUpdateSources(pending, { ...request, blocked: true })).toBeUndefined();
  expect(started).toEqual(['orbis', 'os']);
  expect(await checkUpdateSources(pending, { ...request, checkOrbis: async () => 'checked', checkSystem: undefined })).toEqual([
    { status: 'fulfilled', value: 'checked' },
  ]);
});

test('an active OS check updates the status line without removing the inventory or its guarded actions', () => {
  const markup = renderLocalUpdates({ jobState: 'running', packageRefresh: true });
  expect(markup).toMatch(/desktop-update-check[^>]*aria-disabled="true"[^>]*aria-busy="true"/);
  expect(markup).toMatch(/desktop-os-check-status[^>]*data-checking="true"/);
  expect(markup).toMatch(/desktop-os-check-active[^>]*aria-hidden="false"[^>]*>.*Checking operating system updates…/);
  expect(markup).toMatch(/desktop-os-check-idle[^>]*aria-hidden="true"[^>]*>Last checked/);
  expect(markup).toContain('1 update ready');
  expect(markup).toContain('Filter package details');
  expect(markup).toMatch(/<button[^>]*desktop-system-update-primary[^>]*disabled=""[^>]*>Update system<\/button>/);
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

test('Orbis status covers unresolved preflight, transfers to the host job, and clears on failure', async () => {
  const reviewing = renderLocalUpdates({ coreRequest: 'review' });
  expect(reviewing).toContain('Initialising update</strong><span>Checking release compatibility');

  const queryClient = new QueryClient();
  try {
    const { promise, reject } = Promise.withResolvers<never>();
    const applying = queryClient
      .getMutationCache()
      .build(queryClient, {
        mutationKey: ['orbis-compatibility', 'update', 7, 'v0.1.0', 'apply'],
        mutationFn: () => promise,
      })
      .execute('v0.2.0');
    expect(renderLocalUpdates({ queryClient })).toContain('Initialising update</strong><span>Checking the release and update readiness');

    const installing = renderLocalUpdates({ queryClient, runningCore: true });
    expect(installing).toContain('Installing Orbis</strong><span>Downloading image');
    expect(installing).not.toContain('Initialising update');

    reject(new Error('Could not verify backup storage.'));
    await expect(applying).rejects.toThrow('Could not verify backup storage.');
    const failed = renderLocalUpdates({ queryClient });
    expect(failed).toContain('Could not verify backup storage.');
    expect(failed).not.toContain('Initialising update');
  } finally {
    queryClient.clear();
  }
});

test('the Orbis card contains the release changelog after the version and action, ahead of other system cards', () => {
  const markup = renderLocalUpdates();
  expect(markup).toMatch(
    /desktop-updates-card-orbis[\s\S]*Update available[\s\S]*>Update Orbis<\/button>[\s\S]*desktop-updates-release[\s\S]*<h3[^>]*>Changelog<\/h3>[\s\S]*<\/section><section class="desktop-updates-card desktop-updates-host"/,
  );
});

test('package readiness shows a ready subset and keeps deferred packages visible but unselectable', () => {
  const markup = renderLocalUpdates({ readyCount: 2, deferredCount: 1 });
  expect(markup).toContain('2 updates ready');
  expect(markup).toContain('3 available · 1 deferred by APT');
  expect(markup).toContain('2 of 2 ready selected');
  expect(markup).toMatch(/aria-label="Select test-package-0 for update"[^>]*checked/);
  expect(markup).toMatch(/aria-label="Select test-package-2 for update"[^>]*disabled/);
  expect(markup).toContain('>Deferred</span>');
});

test('zero ready is distinct from unreadable or legacy readiness, with no install action', () => {
  const deferred = renderLocalUpdates({ readyCount: 0, deferredCount: 2 });
  expect(deferred).toContain('No updates ready');
  expect(deferred).toContain('2 available · 2 deferred by APT');
  expect(deferred).not.toContain('>Update system</button>');
  const unavailable = renderLocalUpdates({ packagesReady: 'unavailable' });
  expect(unavailable).toContain('APT could not confirm which packages are ready.');
  expect(unavailable).not.toContain('>Update system</button>');
  const legacy = renderLocalUpdates({ packagesReady: 'legacy' });
  expect(legacy).toContain('Update the system service to check which packages are ready.');
  expect(legacy).not.toContain('>Update system</button>');
});

test('an interrupted no-backup update offers a state check without promising automatic restore', () => {
  const markup = renderLocalUpdates({ unbackedInterrupted: true });
  expect(markup).toContain('>Check update state</button>');
  expect(markup).not.toContain('>Restore previous release</button>');
  expect(markup).toContain('Preserve its state for local recovery review.');
});

test('each available app update exposes its existing review action to operators', () => {
  const operator = renderLocalUpdates({ includeAppUpdate: true });
  expect(operator).toContain('<ul class="desktop-updates-app-list">');
  expect(operator).toContain('href="/apps/community/notes/update"');
  expect(operator).toContain('aria-label="Update Notes"');
  expect(renderLocalUpdates({ includeAppUpdate: true, operator: false })).not.toContain('/apps/community/notes/update');
});
