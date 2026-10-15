// Development fixtures for isolated visual checks. These never run in the product.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const inspectAppDetails = require('./app-detail-checks.cjs');
const inspectWorkspaceAlignment = require('./workspace-alignment-checks.cjs');
const inspectCommandSearch = require('./command-search-checks.cjs');
const inspectHomeApps = require('./home-app-checks.cjs');
const inspectWindowFlows = require('./window-flow-checks.cjs');
const inspectAppUpdate = require('./app-update-checks.cjs');
const inspectConnectionStatus = require('./connection-status-checks.cjs');
const inspectNotifications = require('./notification-checks.cjs');
const inspectErrorAuth = require('./error-auth-checks.cjs');
const homeOnly = process.env.ORBIS_VISUAL_HOME_ONLY === '1';
const windowsOnly = process.env.ORBIS_VISUAL_WINDOWS_ONLY === '1';
const updatesOnly = process.env.ORBIS_VISUAL_UPDATES_ONLY === '1';
const connectionOnly = process.env.ORBIS_VISUAL_CONNECTION_ONLY === '1';
const notificationsOnly = process.env.ORBIS_VISUAL_NOTIFICATIONS_ONLY === '1';
const errorsOnly = process.env.ORBIS_VISUAL_ERRORS_ONLY === '1';

const base = 'http://localhost:8080';
const screenshotDir = process.env.ORBIS_VISUAL_SCREENSHOT_DIR || path.join(__dirname, '..', 'screenshots', 'desktop-fixtures');
const version = { current: '4.10.1', latest: '4.10.1', body: '', releases: [] };
const hostUpdateFixture = process.env.ORBIS_VISUAL_HOST_UPDATE === '1';
const zoom = Number(process.env.ORBIS_VISUAL_ZOOM || 1);
if (!Number.isInteger(zoom) || zoom < 1 || zoom > 3) throw new Error('ORBIS_VISUAL_ZOOM must be 1, 2, or 3');
const narrowWidth = Number(process.env.ORBIS_VISUAL_WIDTH || 320);
const narrowHeight = Number(process.env.ORBIS_VISUAL_HEIGHT || 800);
const panelWidth = Number(process.env.ORBIS_VISUAL_PANEL_WIDTH || 0);
if (!Number.isInteger(narrowWidth) || narrowWidth < 320 * zoom || narrowWidth > 4096)
  throw new Error('ORBIS_VISUAL_WIDTH must be an integer between 320 times the zoom and 4096');
if (!Number.isInteger(narrowHeight) || narrowHeight < 400 * zoom || narrowHeight > 2400)
  throw new Error('ORBIS_VISUAL_HEIGHT must be an integer between 400 times the zoom and 2400');
if (!Number.isInteger(panelWidth) || (panelWidth !== 0 && (panelWidth < 240 || panelWidth > 1200)))
  throw new Error('ORBIS_VISUAL_PANEL_WIDTH must be an integer between 240 and 1200');
const apps = [
  {
    info: { urn: 'media:test', name: 'Media', short_desc: 'Local media service', available: true },
    app: { id: 1, status: 'running', version: 1, ignoredVersion: null },
    metadata: { latestVersion: 1 },
  },
  {
    info: { urn: 'dns:test', name: 'DNS', short_desc: 'Network filtering', available: true },
    app: { id: 2, status: 'running', version: 1, ignoredVersion: null },
    metadata: { latestVersion: 1 },
  },
  {
    info: { urn: 'backup:test', name: 'Backups', short_desc: 'Data snapshots', available: true },
    app: { id: 3, status: 'stopped', version: 1, ignoredVersion: null },
    metadata: { latestVersion: 2 },
  },
];
if (homeOnly) {
  const names = [
    'Home Assistant',
    'Jellyfin Media Library and Transcoding Server',
    'Paperless document archive and optical character recognition',
    'Syncthing',
    'Immich Photo Library',
    'Uptime Kuma',
    'Vaultwarden',
    'Home automation and household telemetry dashboard',
    'Audiobookshelf',
    'Nextcloud collaborative workspace and private file storage',
    'Crafty Controller',
  ];
  apps.push(
    ...names.map((name, index) => ({
      info: { urn: `extra${index}:test`, name, short_desc: 'An installed home server service', available: true },
      app: { id: index + 4, status: index % 4 === 0 ? 'stopped' : 'running', version: 1, ignoredVersion: null },
      metadata: { latestVersion: index % 3 === 0 ? 2 : 1 },
    })),
  );
}
const catalogue = [
  { id: 'media', urn: 'media:official', name: 'Media', short_desc: 'A self-hosted media service', categories: ['media'], created_at: 0 },
  { id: 'dns', urn: 'dns:official', name: 'DNS', short_desc: 'Manage network filtering', categories: ['network'], created_at: 0 },
  { id: 'photos', urn: 'photos:official', name: 'Photos', short_desc: 'Organise your photo library', categories: ['media'], created_at: 0 },
];
const appDetailFixture = (urn) => {
  const [id, storeId] = urn.split(':');
  const summary = apps.find((item) => item.info.urn === urn) || (urn === 'managed:_user' ? { app: { id: 4, status: 'stopped', version: 1 } } : null);
  const name =
    summary?.info?.name || (id === 'photos' ? 'Photos' : id === 'custom' ? 'Custom service' : id === 'managed' ? 'Managed service' : 'Media');
  return {
    info: {
      id,
      urn,
      name,
      short_desc: summary?.info?.short_desc || 'A self-hosted application for your server',
      description: `## ${name} on your server\n\nRead the application documentation before configuring access.\n\n- Configuration stays with this installation.\n- Backups and logs remain available in their sections.`,
      version: '1.2.3',
      author: 'Fixture maintainer',
      source: 'https://example.com/source',
      website: 'https://example.com',
      available: true,
      deprecated: false,
      supported_architectures: ['amd64', 'arm64'],
      categories: ['utilities'],
      created_at: 0,
      updated_at: 0,
      tipi_version: 1,
      dynamic_config: true,
      exposable: true,
      force_expose: false,
      force_pull: false,
      generate_vapid_keys: false,
      no_gui: false,
      https: false,
      port: 8123,
      form_fields: [{ type: 'text', label: 'Service label', env_variable: 'SERVICE_LABEL', required: true }],
    },
    app: summary
      ? {
          ...summary.app,
          createdAt: 0,
          updatedAt: 0,
          port: 8123,
          domain: null,
          exposed: false,
          exposedLocal: false,
          openPort: true,
          pendingRestart: false,
          config: { SERVICE_LABEL: 'Media library' },
          templateUrn: null,
          isVisibleOnGuestDashboard: false,
        }
      : null,
    metadata: { latestVersion: 2, latestDockerVersion: '1.3.0', localSubdomain: `${id}-${storeId}`, composeSchemaVersion: 2, hasCustomConfig: true },
  };
};
const containerFixture = {
  sampledAt: new Date().toISOString(),
  available: true,
  omitted: 0,
  containers: [
    {
      id: 'media-container',
      name: 'media-web',
      appUrn: 'media:test',
      service: 'web',
      state: 'running',
      health: 'healthy',
      cpuPercent: 24.7,
      memoryBytes: 268435456,
      memoryLimitBytes: 2147483648,
      receivedBytes: 8097152,
      transmittedBytes: 2097152,
      blockReadBytes: 1048576,
      blockWriteBytes: 524288,
      statsAvailable: true,
    },
    {
      id: 'dns-container',
      name: 'dns-server',
      appUrn: 'dns:test',
      service: 'server',
      state: 'running',
      health: 'not-configured',
      cpuPercent: 1.3,
      memoryBytes: 536870912,
      memoryLimitBytes: 2147483648,
      receivedBytes: 2097152,
      transmittedBytes: 1048576,
      blockReadBytes: 0,
      blockWriteBytes: 0,
      statsAvailable: true,
    },
    {
      id: 'backup-container',
      name: 'backup-worker',
      appUrn: 'backup:test',
      service: 'worker',
      state: 'exited',
      health: 'not-configured',
      cpuPercent: null,
      memoryBytes: null,
      memoryLimitBytes: null,
      receivedBytes: null,
      transmittedBytes: null,
      blockReadBytes: null,
      blockWriteBytes: null,
      statsAvailable: false,
    },
  ],
};
const historyFixture = (range = '1h') => {
  const ranges = { '5m': [300, 10], '1h': [3600, 60], '24h': [86400, 300], '7d': [604800, 1800] };
  const [duration, interval] = ranges[range] || ranges['1h'];
  const now = Date.now();
  const start = now - duration * 1000;
  const count = Math.floor(duration / interval);
  const metric = (value, samples) => ({
    average: value,
    peak: value === null ? null : samples === 1 ? value : value * 1.1,
    samples: value === null ? 0 : samples,
  });
  return {
    range,
    from: new Date(start).toISOString(),
    to: new Date(now).toISOString(),
    resolutionSeconds: interval,
    sampledEverySeconds: 10,
    retentionDays: 7,
    storage: 'persistent',
    collectorAvailable: true,
    lastSampleAt: new Date(now - 1000).toISOString(),
    persistedThrough: new Date(now - 60000).toISOString(),
    points: Array.from({ length: count }, (_, index) => {
      const at = start + index * interval * 1000;
      const samples = interval / 10;
      return {
        at: new Date(at).toISOString(),
        until: new Date(at + (interval - 10) * 1000).toISOString(),
        intervalSeconds: interval,
        samples,
        cpuScope: index === 4 ? 'runtime' : 'host-proc',
        cpu: metric(index === 2 ? null : 11 + (index % 12) * 1.5, samples),
        memory: metric(35 + (index % 4), samples),
        download: metric(42000 + (index % 8) * 2000, samples),
        upload: metric(12000 + (index % 6) * 500, samples),
      };
    }).filter((_, index) => index !== Math.floor(count / 2) && index !== Math.floor(count / 2) + 1),
  };
};
const taskFixture = {
  sampledAt: new Date().toISOString(),
  storage: 'persistent',
  retentionDays: 30,
  limit: 300,
  tasks: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      appUrn: 'media:test',
      action: 'backup',
      status: 'running',
      createdAt: '2026-10-15T01:00:00Z',
      updatedAt: '2026-10-15T01:00:05Z',
      startedAt: '2026-10-15T01:00:05Z',
      finishedAt: null,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      appUrn: 'backup:test',
      action: 'start',
      status: 'failed',
      createdAt: '2026-10-15T00:45:00Z',
      updatedAt: '2026-10-15T00:45:10Z',
      startedAt: '2026-10-15T00:45:02Z',
      finishedAt: '2026-10-15T00:45:10Z',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      appUrn: 'dns:test',
      action: 'update',
      status: 'succeeded',
      createdAt: '2026-10-15T00:30:00Z',
      updatedAt: '2026-10-15T00:32:00Z',
      startedAt: '2026-10-15T00:30:05Z',
      finishedAt: '2026-10-15T00:32:00Z',
    },
  ],
};
const translations = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'packages', 'backend', 'src', 'modules', 'i18n', 'translations', 'en.json'), 'utf8'),
);

async function capture(page, name, { scrollTop = true } = {}) {
  await page.waitForTimeout(600);
  if (scrollTop) await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(screenshotDir, name), animations: 'disabled' });
}

async function chromeGeometry(page) {
  return page.locator('.desktop-system-bar').evaluate((bar) => {
    const controls = [...bar.querySelectorAll('.desktop-task-trigger, .desktop-mode-toggle, .desktop-search-trigger, .desktop-icon-button')];
    const boxes = controls.map((control) => {
      const { x, y, width, height } = control.getBoundingClientRect();
      const glyph = control.querySelector('svg').getBoundingClientRect();
      return { x, y, width, height, glyph: { y: glyph.y, width: glyph.width, height: glyph.height } };
    });
    const brand = bar.querySelector('.desktop-brand').getBoundingClientRect();
    const current = bar.querySelector('.desktop-current');
    const next = current && getComputedStyle(current).display !== 'none' ? current.getBoundingClientRect() : boxes[0];
    return {
      boxes,
      aligned: boxes.every(
        (box) =>
          Math.abs(box.y - boxes[0].y) < 0.1 &&
          Math.abs(box.height - boxes[0].height) < 0.1 &&
          Math.abs(box.glyph.width - 20) < 0.1 &&
          Math.abs(box.glyph.height - 20) < 0.1 &&
          Math.abs(box.glyph.y + box.glyph.height / 2 - box.y - box.height / 2) < 0.1,
      ),
      separated:
        brand.right + 4 <= (next.left ?? next.x) && boxes.every((box, index) => !index || boxes[index - 1].x + boxes[index - 1].width < box.x),
      addressVisible: (() => {
        const label = bar.querySelector('.desktop-connection-label');
        const dot = bar.querySelector('.desktop-connection-dot');
        const bounds = label.getBoundingClientRect();
        const signal = dot.getBoundingClientRect();
        const expected = dot.classList.contains('is-connected')
          ? '127.0.0.1'
          : dot.classList.contains('is-connecting')
            ? 'Connecting'
            : 'Reconnecting';
        return (
          getComputedStyle(label).display !== 'none' &&
          bounds.width > 0 &&
          label.textContent === expected &&
          label.childElementCount === 0 &&
          Math.abs(bounds.top + bounds.height / 2 - signal.top - signal.height / 2) < 0.5 &&
          bounds.left >= bar.getBoundingClientRect().left + 8 &&
          bounds.right <= bar.getBoundingClientRect().right - 8
        );
      })(),
      backdropMatches: getComputedStyle(document.body).backgroundColor === getComputedStyle(document.querySelector('.desktop')).backgroundColor,
    };
  });
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const freshPreferences = () => ({
    serverName: 'Hades',
    preset: 'frost',
    mode: 'light',
    density: 'comfortable',
    wallpaper: 'sandstone',
    workspace: { order: ['applications', 'activity', 'storage', 'attention'], hidden: [], wide: ['applications'], pinnedApps: [] },
  });
  let preferences = freshPreferences();
  const reports = [];
  const viewports = connectionOnly
    ? [{ name: 'connection', width: 1440, height: 1120 }]
    : process.env.ORBIS_VISUAL_NARROW
      ? [{ name: 'narrow', width: Math.floor(narrowWidth / zoom), height: Math.floor(narrowHeight / zoom) }]
      : [
          { name: 'desktop', width: 1440, height: 1120 },
          { name: 'tablet', width: 768, height: 1024 },
          { name: 'mobile', width: 390, height: 844 },
          ...(updatesOnly || notificationsOnly || errorsOnly ? [{ name: 'narrow', width: 320, height: 800 }] : []),
        ];
  for (const viewport of viewports) {
    preferences = freshPreferences();
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: zoom });
    let fixtureServerAddress = '127.0.0.1';
    const errors = [];
    let detailPhase = false;
    let logRequests = 0;
    const logLimits = [];
    const actionRequests = [];
    page.on('pageerror', (error) => errors.push(error.stack || error.message));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const respond = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname.startsWith('/api/i18n/')) return respond(translations);
      if (url.pathname.startsWith('/api/sse/')) {
        if (url.pathname === '/api/sse/app-logs') {
          logRequests += 1;
          logLimits.push(url.searchParams.get('maxLines'));
        }
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: url.pathname === '/api/sse/app-logs' ? 'data: {"lines":["[fixture] application ready"]}\n\n' : '',
        });
      }
      if (url.pathname.endsWith('/image')) {
        const id = decodeURIComponent(url.pathname).split('/').at(-2)?.split(':')[0];
        const glyphs = {
          media: '<path d="M25 18 47 32 25 46Z" fill="#fff"/>',
          dns: '<path d="M32 12 49 19v13c0 10-17 20-17 20S15 42 15 32V19Z" fill="none" stroke="#fff" stroke-width="4"/><path d="m24 31 6 6 12-13" fill="none" stroke="#fff" stroke-width="4"/>',
          backup:
            '<ellipse cx="32" cy="19" rx="18" ry="7" fill="none" stroke="#fff" stroke-width="3"/><path d="M14 19v24c0 9 36 9 36 0V19M14 31c0 9 36 9 36 0" fill="none" stroke="#fff" stroke-width="3"/>',
          photos:
            '<rect x="13" y="14" width="38" height="36" rx="5" fill="none" stroke="#fff" stroke-width="3"/><path d="m16 45 12-15 8 9 8-12 5 9" fill="none" stroke="#fff" stroke-width="3"/>',
        };
        return route.fulfill({
          status: 200,
          contentType: 'image/svg+xml',
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${id === 'media' ? '#5a90af' : id === 'dns' ? '#4d9374' : '#b48b62'}"/><stop offset="1" stop-color="#21423e"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#g)"/>${glyphs[id] || glyphs.photos}</svg>`,
        });
      }
      if (url.pathname === '/api/user-context')
        return respond({
          version,
          isLoggedIn: true,
          isConfigured: true,
          isGuestDashboardEnabled: false,
          allowAutoThemes: false,
          allowErrorMonitoring: false,
          themeColor: 'blue',
          themeBase: 'slate',
          localDomain: 'local.test',
          sslPort: 443,
        });
      if (url.pathname === '/api/app-context')
        return respond({
          version,
          userSettings: {
            allowAutoThemes: false,
            localDomain: 'local.test',
            sslPort: 443,
            maxBackups: 5,
            guestDashboard: false,
            internalIp: fixtureServerAddress,
          },
          user: { id: 1, username: 'fixture', totpEnabled: false, locale: 'en', operator: true, hasSeenWelcome: true },
          apps: [],
          updatesAvailable: 0,
        });
      if (url.pathname.startsWith('/api/app-lifecycle/')) {
        actionRequests.push({ path: url.pathname, body: JSON.parse(route.request().postData() || '{}') });
        return respond({ requestId: '55555555-5555-4555-8555-555555555555' });
      }
      if (url.pathname === '/api/apps/installed') return respond({ installed: apps });
      if (url.pathname === '/api/apps/random-port') return respond({ port: 8123 });
      if (/^\/api\/apps\/[^/]+$/.test(url.pathname)) return respond(appDetailFixture(decodeURIComponent(url.pathname.split('/').at(-1))));
      if (/^\/api\/apps\/[^/]+\/config$/.test(url.pathname))
        return respond({
          config: JSON.stringify({
            'x-runtipi': { schema_version: 2 },
            services: { web: { image: 'nginx:alpine', 'x-runtipi': { is_main: true, internal_port: 80 } } },
          }),
        });
      if (url.pathname.endsWith('/config-diff')) return respond({ current: 'SERVICE_LABEL=old', new: 'SERVICE_LABEL=new' });
      if (url.pathname.endsWith('/compose-diff')) return respond({ current: '{"services":{}}', new: '{"services":{}}' });
      if (url.pathname.startsWith('/api/backups/')) return respond({ currentPage: 1, data: [], lastPage: 1, total: 0 });
      if (url.pathname.startsWith('/api/user-config/'))
        return respond({
          appEnv: 'KEEP_THIS=unchanged',
          dockerCompose: '',
          sourceCompose: 'services:\n  web:\n    image: example/service:1.2.3\n',
          isEnabled: true,
        });
      if (url.pathname === '/api/system/containers')
        return respond(
          detailPhase
            ? {
                ...containerFixture,
                containers: [
                  ...containerFixture.containers,
                  { ...containerFixture.containers[0], id: 'other-store', name: 'media-other-store', appUrn: 'media:other' },
                ],
              }
            : containerFixture,
        );
      if (url.pathname === '/api/system/history') return respond(historyFixture(url.searchParams.get('range') || '1h'));
      if (url.pathname === '/api/tasks')
        return respond(
          detailPhase
            ? {
                ...taskFixture,
                tasks: [...taskFixture.tasks, { ...taskFixture.tasks[0], id: '44444444-4444-4444-8444-444444444444', appUrn: 'media:other' }],
              }
            : taskFixture,
        );
      if (url.pathname === '/api/links') return respond({ links: [] });
      if (url.pathname === '/api/system/load')
        return respond({ diskUsed: 43, diskSize: 256, percentUsed: 17, cpuLoad: 11.3, memoryTotal: 32, percentUsedMemory: 38 });
      if (url.pathname === '/api/system/telemetry')
        return respond({
          sampledAt: new Date().toISOString(),
          cpu: { scope: 'host-proc', totalPercent: 11.3, perCorePercent: [12, 9, 17, 7], uptimeSeconds: 345600 },
          memory: { scope: 'host-proc', totalBytes: 34359738368, availableBytes: 21474836480, swapTotalBytes: 8589934592, swapFreeBytes: 7516192768 },
          filesystems: [
            { mount: '/', filesystem: 'overlay', sizeBytes: 274877906944, usedBytes: 46170898432, availableBytes: 228707008512, scope: 'runtime' },
          ],
          network: [
            {
              interface: 'eth0',
              rxBytesPerSecond: 42000,
              txBytesPerSecond: 12000,
              receivedBytes: 1099511627776,
              transmittedBytes: 322122547200,
              scope: 'runtime',
            },
          ],
        });
      if (url.pathname === '/api/system/build')
        return respond({
          version: hostUpdateFixture ? 'v0.1.0-beta.7' : 'development',
          commit: null,
          imageDigest: null,
          runtipiCompatibility: '4.10.1',
        });
      if (url.pathname === '/api/system/orbis-release')
        return respond(
          hostUpdateFixture
            ? {
                tag: 'v0.1.0-beta.8',
                url: 'https://github.com/twentylines/orbis/releases/tag/v0.1.0-beta.8',
                publishedAt: '2026-10-15T00:00:00Z',
                body: 'Fixture release notes.',
                imageManifestUrl: 'https://github.com/twentylines/orbis/releases/download/v0.1.0-beta.8/release-manifest.json',
              }
            : null,
        );
      if (url.pathname === '/api/host-updates/status')
        return respond(
          hostUpdateFixture
            ? {
                available: true,
                enrolled: true,
                currentTag: 'v0.1.0-beta.7',
                currentDigest: `sha256:${'b'.repeat(64)}`,
                coreState: 'running',
                coreHealth: 'healthy',
                imageMatches: true,
                job: null,
              }
            : { available: false, reason: 'The Orbis host service is not connected.' },
        );
      if (url.pathname === '/api/host-updates/packages')
        return respond(
          hostUpdateFixture
            ? {
                available: true,
                manager: 'apt',
                operatingSystem: 'Ubuntu 24.04.4 LTS',
                checkedAt: '2026-10-15T04:15:00Z',
                indexesUpdatedAt: '2026-10-14T20:07:01Z',
                rebootRequired: false,
                packageCount: 3,
                truncated: false,
                packages: [
                  {
                    name: 'linux-image-generic:arm64',
                    installedVersion: '6.8.0-80.80',
                    candidateVersion: '6.8.0-86.86',
                    downloadBytes: 18439872,
                    security: true,
                    sources: [{ origin: 'Ubuntu', archive: 'noble-security', site: 'ports.ubuntu.com', trusted: true }],
                  },
                  {
                    name: 'openssh-server:arm64',
                    installedVersion: '1:9.6p1-3ubuntu13.10',
                    candidateVersion: '1:9.6p1-3ubuntu13.13',
                    downloadBytes: 501000,
                    security: true,
                    sources: [{ origin: 'Ubuntu', archive: 'noble-updates', site: 'ports.ubuntu.com', trusted: true }],
                  },
                  {
                    name: 'base-files:arm64',
                    installedVersion: '13ubuntu10.4',
                    candidateVersion: '13ubuntu10.5',
                    downloadBytes: 73378,
                    security: false,
                    sources: [{ origin: 'Ubuntu', archive: 'noble-updates', site: 'ports.ubuntu.com', trusted: true }],
                  },
                ],
              }
            : { available: false, reason: 'The Orbis host service is not connected.' },
        );
      if (url.pathname === '/api/host-updates/packages/changelog')
        return respond({
          name: url.searchParams.get('name'),
          candidateVersion: '6.8.0-86.86',
          available: true,
          source: 'APT distribution changelog',
          body: 'linux-image-generic (6.8.0-86.86) noble; urgency=medium\n\n  * Security and stability fixes.\n',
          truncated: false,
        });
      if (url.pathname === '/api/host-updates/packages/job') return respond({ available: true, job: null });
      if (url.pathname === '/api/host-updates/packages/plan') {
        const names = JSON.parse(route.request().postData() || '{}').names || [];
        return respond({
          planId: '00000000-0000-4000-8000-000000000000',
          createdAt: Date.now() / 1000,
          selected: names.map((name) => ({ name })),
          operations: [
            { name: 'linux-image-generic', installedVersion: '6.8.0-80.80', candidateVersion: '6.8.0-86.86', action: 'upgrade' },
            { name: 'linux-image-6.8.0-86-generic', installedVersion: null, candidateVersion: '6.8.0-86.86', action: 'install' },
            { name: 'openssh-server', installedVersion: '1:9.6p1-3ubuntu13.10', candidateVersion: '1:9.6p1-3ubuntu13.13', action: 'upgrade' },
            { name: 'base-files', installedVersion: '13ubuntu10.4', candidateVersion: '13ubuntu10.5', action: 'upgrade' },
          ],
        });
      }
      if (url.pathname === '/api/host-updates/plan')
        return respond({
          planId: '00000000-0000-4000-8000-000000000000',
          currentTag: 'v0.1.0-beta.7',
          targetTag: 'v0.1.0-beta.8',
          targetDigest: `sha256:${'c'.repeat(64)}`,
          snapshotBytes: 78_925_886,
          appsMustBeStopped: true,
        });
      if (url.pathname === '/api/marketplace/apps/search') {
        const needle = (url.searchParams.get('search') || '').toLowerCase();
        return respond({
          data: catalogue.filter((app) => `${app.name} ${app.short_desc}`.toLowerCase().includes(needle)).map((app) => ({ ...app, available: true })),
          nextCursor: null,
        });
      }
      if (url.pathname === '/api/marketplace/enabled') return respond({ appStores: [] });
      if (url.pathname === '/api/desktop-preferences') {
        if (route.request().method() === 'PUT') preferences = JSON.parse(route.request().postData() || '{}');
        return respond(preferences);
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
    if (errorsOnly) {
      const errorAuth = await inspectErrorAuth({
        page,
        base,
        capture: (name, options) => capture(page, `${viewport.name}-${name}.png`, options),
      });
      reports.push({ viewport: viewport.name, errorAuth, errors });
      await page.close();
      continue;
    }
    if (notificationsOnly) {
      const notifications = await inspectNotifications({
        page,
        base,
        capture: (name, options) => capture(page, `${viewport.name}-${name}.png`, options),
        checkTiming: viewport.name === 'desktop',
      });
      reports.push({ viewport: viewport.name, notifications, errors });
      await page.close();
      continue;
    }
    if (connectionOnly) {
      const connection = await inspectConnectionStatus(page, {
        base,
        screenshotDir: path.join(screenshotDir, 'connection'),
        setServerAddress: (address) => {
          fixtureServerAddress = address;
        },
      });
      reports.push({ viewport: viewport.name, connection, errors });
      await page.close();
      continue;
    }
    if (updatesOnly) {
      const updates = await inspectAppUpdate({
        page,
        base,
        capture: (name, options) => capture(page, `${viewport.name}-${name}.png`, options),
      });
      reports.push({ viewport: viewport.name, updates, errors });
      await page.close();
      continue;
    }
    if (windowsOnly) {
      const windows = await inspectWindowFlows(page, {
        getPreferences: () => preferences,
        capture: (name, options) => capture(page, `${viewport.name}-${name}.png`, options),
      });
      reports.push({ viewport: viewport.name, windows, errors });
      await page.close();
      continue;
    }
    if (homeOnly) {
      const homeApps = await inspectHomeApps(page, {
        apps,
        resetPreferences: (mode) => {
          preferences = { ...freshPreferences(), mode };
        },
        capture: (name, options) => capture(page, `${viewport.name}-${name}.png`, options),
      });
      reports.push({ viewport: viewport.name, homeApps, errors });
      await page.close();
      continue;
    }
    const ignoredApps = structuredClone(apps);
    ignoredApps[0].metadata.latestVersion = 2;
    ignoredApps[0].app.ignoredVersion = 2;
    const ignoredHandler = (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ installed: ignoredApps }) });
    await page.route('**/api/apps/installed', ignoredHandler);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.workspace-attention').getByText('1 installed application stopped or ready to update.', { exact: true }).waitFor();
    const ignoredUpdateExcluded = true;
    await page.unroute('**/api/apps/installed', ignoredHandler);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Host CPU').waitFor();
    await page.getByText('Core network').waitFor();
    await page.getByText('Healthy', { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('img.app-logo')].every((img) => img.complete && img.naturalWidth > 0));
    await page.locator('.desktop-system-bar').evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const iconsLoaded = await page
      .locator('img.app-logo')
      .evaluateAll((images) => images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0));
    const desktopStartsAtTop = await page.locator('.desktop').evaluate((element) => element.getBoundingClientRect().top === 0);
    const shellInset = await page
      .locator('.desktop-system-bar')
      .evaluate((element) => element.getBoundingClientRect().left >= 20 && element.getBoundingClientRect().top >= 20);
    const orbisBrand = (await page.title()) === 'Orbis' && (await page.getByRole('link', { name: 'Orbis workspace on Hades' }).isVisible());
    const lightChrome = await chromeGeometry(page);
    const lightWorkspaceAlignment = await inspectWorkspaceAlignment(page);
    let chromeHoverAligned = true;
    for (const selector of ['.desktop-task-trigger', '.desktop-mode-toggle', '.desktop-search-trigger', '.desktop-icon-button']) {
      await page.locator(selector).hover();
      await page.waitForTimeout(250);
      const hovered = await chromeGeometry(page);
      chromeHoverAligned &&= hovered.aligned && hovered.separated;
    }
    await page.mouse.move(0, 0);
    await capture(page, `${viewport.name}-workspace.png`);
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await page.locator('.desktop[data-desktop-mode="dark"]').waitFor();
    for (let attempt = 0; attempt < 40 && preferences.mode !== 'dark'; attempt++) await page.waitForTimeout(50);
    await page.reload();
    await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
    await page.getByText('Host CPU').waitFor();
    await page.getByText('Core network').waitFor();
    const darkModePersisted =
      (await page.locator('.desktop').getAttribute('data-desktop-mode')) === 'dark' &&
      (await page.evaluate(() => document.body.dataset.bsTheme)) === 'dark';
    const darkChrome = await chromeGeometry(page);
    const darkWorkspaceAlignment = await inspectWorkspaceAlignment(page);
    const chromeAligned =
      lightChrome.aligned &&
      darkChrome.aligned &&
      lightChrome.separated &&
      darkChrome.separated &&
      lightChrome.addressVisible &&
      darkChrome.addressVisible &&
      chromeHoverAligned;
    const chromeModeStable = Math.abs(lightChrome.boxes[1].width - darkChrome.boxes[1].width) < 0.1;
    const rootBackdropMatches = lightChrome.backdropMatches && darkChrome.backdropMatches;
    await capture(page, `${viewport.name}-workspace-dark.png`);
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
    await page.locator('.desktop[data-desktop-mode="light"]').waitFor();
    const workspaceOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const workspaceBackgroundGap = await page.evaluate(
      () => (document.querySelector('.desktop')?.getBoundingClientRect().bottom ?? 0) < document.documentElement.scrollHeight - 1,
    );
    await page.getByRole('button', { name: 'Edit workspace' }).click();
    if (viewport.name === 'narrow' && zoom === 1)
      await page.addStyleTag({ content: '.workspace-editor button,.workspace-editor-name,.workspace-editor p{font-size:200% !important}' });
    const dockHiddenWhileEditing = await page.getByRole('navigation', { name: 'Desktop tools' }).isHidden();
    await page.getByRole('button', { name: 'Move System status up' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Hide Recent operations' }).click();
    await page.getByRole('button', { name: 'Expand System status wide' }).click();
    await page.getByRole('button', { name: 'Pin Backups' }).click();
    const savingAfterPin = await page.locator('.workspace-editor-sync').innerText();
    const editedOrder = await page.locator('.workspace-widget').first().locator('h2').first().innerText();
    const storageHidden = (await page.locator('.workspace-operations').count()) === 0;
    const activityResized = (await page.locator('.workspace-widget').first().getAttribute('class')).includes('workspace-widget-wide');
    await capture(page, `${viewport.name}-workspace-edit.png`);
    const editOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    for (
      let attempt = 0;
      attempt < 40 && (preferences.workspace.hidden.length === 0 || !preferences.workspace.pinnedApps.includes('backup:test'));
      attempt++
    )
      await page.waitForTimeout(50);
    await page.reload();
    await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
    const dockVisibleAfterReload = await page.getByRole('navigation', { name: 'Desktop tools' }).isVisible();
    const workspaceLayoutPersisted =
      (await page.locator('.workspace-widget').first().locator('h2').first().innerText()) === 'System status' &&
      (await page.locator('.workspace-operations').count()) === 0;
    const pinnedAppFirst = (await page.locator('.workspace-app').first().locator('strong').innerText()) === 'Backups';
    const commandSearch = await inspectCommandSearch(page, () => capture(page, `${viewport.name}-search.png`));
    await page.waitForTimeout(5200);
    await page.getByRole('heading', { name: 'Host memory' }).waitFor();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/system/history?range=24h')),
      page.getByRole('button', { name: '24 hours', exact: true }).click(),
    ]);
    const historyRanges = (await page.getByRole('button', { name: '24 hours', exact: true }).getAttribute('aria-pressed')) === 'true';
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/system/history?range=7d')),
      page.getByRole('button', { name: '7 days', exact: true }).click(),
    ]);
    await page.reload();
    await page.getByRole('button', { name: '7 days', exact: true }).waitFor();
    const historyRangePersisted = (await page.getByRole('button', { name: '7 days', exact: true }).getAttribute('aria-pressed')) === 'true';
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/system/history?range=1h')),
      page.getByRole('button', { name: '1 hour', exact: true }).click(),
    ]);
    const chart = page.getByRole('slider', { name: 'Inspect CPU utilisation history' });
    await chart.scrollIntoViewIfNeeded();
    await chart.focus();
    await page.keyboard.press('Home');
    const firstHistoryIndex = await chart.getAttribute('aria-valuenow');
    await page.keyboard.press('End');
    const historyKeyboard =
      firstHistoryIndex === '0' &&
      Number(await chart.getAttribute('aria-valuenow')) > 0 &&
      (await page.locator('.metric-chart[data-metric="cpu"] .metric-chart-tooltip').isVisible());
    const historyTooltipContained = await page.locator('.metric-chart[data-metric="cpu"] .metric-chart-tooltip').evaluate((tooltip) => {
      const box = tooltip.getBoundingClientRect();
      const plot = tooltip.closest('.metric-chart-plot').getBoundingClientRect();
      return box.top >= plot.top + 8 && box.bottom <= plot.bottom - 8 && box.left >= plot.left + 8 && box.right <= plot.right - 8;
    });
    const historyGaps = (await page.locator('.metric-chart[data-metric="cpu"] [data-history-segment]').count()) > 1;
    await capture(page, `${viewport.name}-monitor-history.png`, { scrollTop: false });
    await chart.blur();
    const cpuRanked = (await page.locator('.container-resource-list > li').first().getAttribute('data-container')) === 'media-web';
    await page.getByRole('group', { name: 'Rank containers by' }).getByRole('button', { name: 'Memory', exact: true }).click();
    const memoryRanked = (await page.locator('.container-resource-list > li').first().getAttribute('data-container')) === 'dns-server';
    await page.getByRole('group', { name: 'Rank containers by' }).getByRole('button', { name: 'CPU', exact: true }).click();
    await capture(page, `${viewport.name}-monitor.png`);
    const monitor3DContained = await page.locator('.desktop-host-visual').evaluate((visual) => {
      const hero = visual.closest('.desktop-host-overview').getBoundingClientRect();
      return [...visual.querySelectorAll('.desktop-host-machine-front, .desktop-host-machine-side, .desktop-host-machine-top')].every((face) => {
        const bounds = face.getBoundingClientRect();
        return bounds.left >= hero.left && bounds.right <= hero.right;
      });
    });
    await page.locator('.container-resources').scrollIntoViewIfNeeded();
    await capture(page, `${viewport.name}-monitor-containers.png`, { scrollTop: false });
    const monitorOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.getByRole('link', { name: 'Open task centre, 1 active operation' }).click();
    await page.getByRole('heading', { name: 'Task centre', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Active', exact: true }).click();
    const activeTaskFiltered = (await page.locator('.task-list > li').count()) === 1;
    await page.locator('.task-list summary').click();
    await page.getByText('Operation running.', { exact: false }).waitFor();
    await capture(page, `${viewport.name}-tasks.png`);
    const tasksOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.getByRole('button', { name: 'Needs review', exact: true }).click();
    const failedTaskFiltered = (await page.locator('.task-list > li[data-status="failed"]').count()) === 1;
    await page.locator('.desktop-window-dismiss').click();
    await page.getByRole('link', { name: 'Applications', exact: true }).click();
    await page
      .getByTestId('apps-list')
      .waitFor({ timeout: 5000 })
      .catch(async (error) => {
        await capture(page, `${viewport.name}-applications-error.png`);
        console.error((await page.locator('body').innerText()).slice(0, 1800));
        throw error;
      });
    const panelStyle = panelWidth
      ? await page.addStyleTag({ content: `.desktop-view-app { width: ${panelWidth}px; max-width: 100%; margin-inline: auto; }` })
      : null;
    const bulkControlsCollapsed = !(await page.locator('.desktop-batch-controls').evaluate((element) => element.open));
    await capture(page, `${viewport.name}-applications.png`);
    const installedAppRowsAligned = await page.locator('.desktop-installed-grid').evaluate((grid) => {
      const cards = [...grid.querySelectorAll('.app-tile')].map((card) => ({
        card: card.getBoundingClientRect(),
        logo: card.querySelector('.app-logo').getBoundingClientRect(),
        title: card.querySelector('.fw-bolder').getBoundingClientRect(),
        health: card.querySelector('.docker-health').getBoundingClientRect(),
      }));
      return (
        cards.length >= 3 &&
        cards.every((card) =>
          cards
            .filter((peer) => Math.abs(peer.card.top - card.card.top) < 0.1)
            .every(
              (peer) =>
                Math.abs(peer.card.bottom - card.card.bottom) < 0.1 &&
                Math.abs(peer.logo.top - card.logo.top) < 0.1 &&
                Math.abs(peer.title.top - card.title.top) < 0.1 &&
                Math.abs(peer.health.bottom - card.health.bottom) < 0.1,
            ),
        )
      );
    });
    await page.locator('.desktop-batch-controls > summary').click();
    const bulkControlsReachable = await page.locator('.batch-action-desktop-button').first().isVisible();
    const batchActionsStacked =
      !panelWidth || (await page.locator('.action-bar-content').evaluate((element) => getComputedStyle(element).flexDirection === 'column'));
    await capture(page, `${viewport.name}-applications-controls.png`);
    const batchOpener = page.locator('.batch-action-desktop-button').first();
    await batchOpener.click();
    const batchDialog = page.getByRole('dialog');
    await batchDialog.waitFor();
    await capture(page, `${viewport.name}-application-dialog.png`);
    const dialogCentered = await batchDialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return Math.abs(box.x + box.width / 2 - innerWidth / 2) < 2 && box.x >= 8 && box.right <= innerWidth - 8;
    });
    await page.keyboard.press('Tab');
    const dialogFocusContained = await batchDialog.evaluate((element) => element.contains(document.activeElement));
    await page.keyboard.press('Escape');
    await batchDialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement === document.querySelector('.batch-action-desktop-button'), null, { timeout: 2000 });
    const dialogFocusReturned = await batchOpener.evaluate((element) => element === document.activeElement);
    await page.locator('.desktop-batch-controls > summary').click();
    const appsOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const appTilesContained = await page
      .locator('.desktop-installed-grid .card-body')
      .evaluateAll((bodies) => bodies.every((body) => body.scrollWidth <= body.clientWidth + 1));
    const appTileSingleColumn =
      !panelWidth ||
      (await page
        .locator('.desktop-installed-grid .app-link')
        .first()
        .evaluate((first) => {
          const second = first.parentElement?.querySelectorAll('.app-link')[1];
          return second !== undefined && Math.abs(first.getBoundingClientRect().left - second.getBoundingClientRect().left) <= 1;
        }));
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement?.scrollHeight ?? 0));
    await page.waitForTimeout(100);
    const appsDock = await page.evaluate(() => {
      const lastTile = document.querySelector('.desktop-installed-grid .button-tile:last-child');
      const dock = document.querySelector('.desktop-dock');
      if (!lastTile || !dock) return null;
      const tileBox = lastTile.getBoundingClientRect();
      const dockBox = dock.getBoundingClientRect();
      return { tileBottom: tileBox.bottom, dockTop: dockBox.top, scrollY, scrollHeight: document.scrollingElement?.scrollHeight };
    });
    const appsDockClearance = appsDock !== null && appsDock.tileBottom + 8 <= appsDock.dockTop;
    if (panelStyle) await panelStyle.evaluate((element) => element.remove());
    await page.getByRole('link', { name: 'App Store', exact: true }).click();
    await page.locator('.desktop-catalogue-grid').waitFor();
    await capture(page, `${viewport.name}-store.png`);
    await page.getByRole('combobox').first().click();
    await page.getByRole('listbox').waitFor();
    await capture(page, `${viewport.name}-store-menu.png`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement === document.querySelector('[role="combobox"]'), null, { timeout: 2000 });
    const categoryFocusReturned = await page
      .getByRole('combobox')
      .first()
      .evaluate((element) => element === document.activeElement);
    const storeOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const singleStoreTitle =
      (await page.getByRole('heading', { name: 'App Store', exact: true }).count()) === 1 &&
      (await page.locator('.desktop-route-title').count()) === 0;
    detailPhase = true;
    const appDetails = await inspectAppDetails({
      page,
      base,
      viewport,
      capture,
      logs: { count: () => logRequests, limits: () => logLimits },
      actions: actionRequests,
    });
    detailPhase = false;
    await page.getByRole('link', { name: 'Updates', exact: true }).click();
    await page.getByRole('heading', { name: 'Updates', exact: true }).waitFor();
    if (process.env.ORBIS_VISUAL_UPDATES_TEXT_SCALE === '2') await page.addStyleTag({ content: '.desktop-updates { font-size: 200% !important; }' });
    if (hostUpdateFixture) {
      await page.getByRole('button', { name: 'Prepare update to v0.1.0-beta.8' }).click();
      await page.getByText('Review core update').waitFor();
      await page.getByRole('button', { name: 'Select matching (3)' }).click();
      await page.getByRole('button', { name: 'Review selected updates' }).click();
      await page.getByRole('region', { name: 'Review host package update' }).waitFor();
    }
    const updatePlanDockVisible = await page.getByRole('navigation', { name: 'Desktop tools' }).isVisible();
    await capture(page, `${viewport.name}-updates.png`);
    const updatesOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    let changelogAccessible = true;
    if (hostUpdateFixture) {
      await page.locator('.desktop-update-release summary').click();
      const changelog = page.getByRole('region', { name: 'v0.1.0-beta.8 changelog' });
      changelogAccessible = await changelog.evaluate((element) => {
        const style = getComputedStyle(element);
        return element.tabIndex === 0 && (window.innerWidth > 760 || (style.maxHeight === 'none' && style.overflow === 'visible'));
      });
      await capture(page, `${viewport.name}-updates-changelog.png`);
      await page.getByRole('button', { name: 'Read changelog' }).first().click();
      await page.getByRole('region', { name: 'linux-image-generic:arm64 changelog' }).waitFor();
      await capture(page, `${viewport.name}-host-packages.png`);
    }
    if (hostUpdateFixture) await page.getByRole('button', { name: 'Cancel' }).first().click();
    await page.locator('.desktop-window-dismiss').click();
    await page.getByRole('link', { name: 'Monitor', exact: true }).click();
    await page.getByRole('heading', { name: 'Monitor', exact: true }).waitFor();
    await page.locator('.desktop-window-dismiss').click();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByRole('textbox', { name: 'Server name' }).waitFor();
    await capture(page, `${viewport.name}-appearance.png`);
    const settingsOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const windowInsets = await page
      .locator('.desktop-window-content')
      .evaluate((element) => element.getBoundingClientRect().left >= 24 && Number.parseFloat(getComputedStyle(element).paddingLeft) >= 20);
    await page.getByRole('button', { name: 'Graphite Dark grey' }).click();
    await page.getByRole('button', { name: 'Tidal' }).click();
    for (let attempt = 0; attempt < 40 && (preferences.preset !== 'graphite' || preferences.wallpaper !== 'tidal'); attempt++)
      await page.waitForTimeout(50);
    if (preferences.preset !== 'graphite') throw new Error('Graphite preference was not sent to the server fixture');
    if (preferences.wallpaper !== 'tidal') throw new Error('Tidal wallpaper was not sent to the server fixture');
    await capture(page, `${viewport.name}-graphite.png`);
    await page.reload();
    await page.getByRole('textbox', { name: 'Server name' }).waitFor();
    const graphitePersisted = await page.getByRole('button', { name: 'Graphite Dark grey' }).getAttribute('aria-pressed');
    const wallpaperPersisted = await page.getByRole('button', { name: 'Tidal' }).getAttribute('aria-pressed');
    const bodyTheme = await page.evaluate(() => document.body.dataset.bsTheme);
    await page.getByRole('link', { name: 'Workspace', exact: true }).click();
    await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
    const graphiteHeadingColor = await page.locator('.workspace-heading').evaluate((element) => getComputedStyle(element).color);
    await capture(page, `${viewport.name}-workspace-graphite.png`);
    await page.route('**/api/marketplace/apps/**/image', async (route) => {
      if (decodeURIComponent(route.request().url()).includes('/media:test/image')) return route.fulfill({ status: 404, body: '' });
      return route.fallback();
    });
    await page.reload();
    await page.locator('img.app-logo[src="/app-not-found.jpg"]').waitFor();
    const iconFallback = await page
      .locator('img.app-logo[src="/app-not-found.jpg"]')
      .first()
      .evaluate((img) => img.complete && img.naturalWidth > 0);
    await page.route('**/api/system/containers', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sampledAt: new Date().toISOString(), available: false, containers: [], omitted: 0 }),
      }),
    );
    await page.reload();
    await page.getByText('Docker unavailable', { exact: true }).first().waitFor();
    const unavailableDockerHonest = (await page.getByText('Healthy', { exact: true }).count()) === 0;
    await capture(page, `${viewport.name}-disconnected.png`);
    reports.push({
      viewport: viewport.name,
      zoom,
      cssViewportWidth: viewport.width,
      cssViewportHeight: viewport.height,
      orbisBrand,
      ignoredUpdateExcluded,
      iconsLoaded,
      iconFallback,
      unavailableDockerHonest,
      desktopStartsAtTop,
      shellInset,
      chromeAligned,
      workspaceAlignment: { light: lightWorkspaceAlignment, dark: darkWorkspaceAlignment },
      chromeModeStable,
      rootBackdropMatches,
      bulkControlsCollapsed,
      bulkControlsReachable,
      dialogCentered,
      dialogFocusContained,
      dialogFocusReturned,
      categoryFocusReturned,
      appDetails,
      historyRanges,
      historyRangePersisted,
      historyKeyboard,
      historyGaps,
      historyTooltipContained,
      cpuRanked,
      memoryRanked,
      activeTaskFiltered,
      failedTaskFiltered,
      tasksOverflow,
      darkModePersisted,
      workspaceOverflow,
      workspaceBackgroundGap,
      editedOrder,
      dockHiddenWhileEditing,
      dockVisibleAfterReload,
      storageHidden,
      activityResized,
      editOverflow,
      workspaceLayoutPersisted,
      pinnedAppFirst,
      commandSearch,
      savingAfterPin,
      monitorOverflow,
      monitor3DContained,
      appsOverflow,
      appTilesContained,
      installedAppRowsAligned,
      appTileSingleColumn,
      batchActionsStacked,
      appsDockClearance,
      appsDock,
      storeOverflow,
      singleStoreTitle,
      windowInsets,
      updatesOverflow,
      updatePlanDockVisible,
      changelogAccessible,
      settingsOverflow,
      graphitePersisted,
      wallpaperPersisted,
      bodyTheme,
      graphiteHeadingColor,
      errors,
    });
    await Promise.race([page.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  if (homeOnly || windowsOnly || updatesOnly || connectionOnly || notificationsOnly || errorsOnly) {
    if (reports.some((report) => report.errors.length)) process.exitCode = 1;
    await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    return;
  }
  if (
    reports.some(
      (report) =>
        report.workspaceOverflow ||
        report.workspaceBackgroundGap ||
        report.editedOrder !== 'System status' ||
        !report.iconsLoaded ||
        !report.iconFallback ||
        !report.unavailableDockerHonest ||
        !report.desktopStartsAtTop ||
        !report.shellInset ||
        !report.chromeAligned ||
        !report.chromeModeStable ||
        !report.rootBackdropMatches ||
        !report.bulkControlsCollapsed ||
        !report.bulkControlsReachable ||
        !report.dialogCentered ||
        !report.dialogFocusContained ||
        !report.dialogFocusReturned ||
        !report.categoryFocusReturned ||
        !report.historyRanges ||
        !report.historyRangePersisted ||
        !report.historyKeyboard ||
        !report.historyGaps ||
        !report.historyTooltipContained ||
        !report.cpuRanked ||
        !report.memoryRanked ||
        !report.activeTaskFiltered ||
        !report.failedTaskFiltered ||
        report.tasksOverflow ||
        !report.dockHiddenWhileEditing ||
        !report.dockVisibleAfterReload ||
        !report.storageHidden ||
        !report.activityResized ||
        report.editOverflow ||
        !report.workspaceLayoutPersisted ||
        !report.pinnedAppFirst ||
        report.savingAfterPin !== 'Saving layout…' ||
        !report.orbisBrand ||
        !report.ignoredUpdateExcluded ||
        !report.darkModePersisted ||
        report.monitorOverflow ||
        !report.monitor3DContained ||
        report.appsOverflow ||
        !report.appTilesContained ||
        !report.installedAppRowsAligned ||
        !report.appTileSingleColumn ||
        !report.batchActionsStacked ||
        !report.appsDockClearance ||
        report.storeOverflow ||
        !report.singleStoreTitle ||
        !report.windowInsets ||
        report.updatesOverflow ||
        !report.updatePlanDockVisible ||
        !report.changelogAccessible ||
        report.settingsOverflow ||
        report.graphitePersisted !== 'true' ||
        report.wallpaperPersisted !== 'true' ||
        report.bodyTheme !== 'dark' ||
        report.graphiteHeadingColor !== 'rgb(237, 242, 239)' ||
        report.errors.length,
    )
  )
    process.exitCode = 1;
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
