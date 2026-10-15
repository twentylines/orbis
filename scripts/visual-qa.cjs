// Development fixtures for isolated visual checks. These never run in the product.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const base = 'http://localhost:8080';
const screenshotDir = path.join(__dirname, '..', 'screenshots', 'desktop-fixtures');
const version = { current: '4.10.1', latest: '4.10.1', body: '', releases: [] };
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
const catalogue = [
  { id: 'media', urn: 'media:official', name: 'Media', short_desc: 'A self-hosted media service', categories: ['media'], created_at: 0 },
  { id: 'dns', urn: 'dns:official', name: 'DNS', short_desc: 'Manage network filtering', categories: ['network'], created_at: 0 },
  { id: 'photos', urn: 'photos:official', name: 'Photos', short_desc: 'Organise your photo library', categories: ['media'], created_at: 0 },
];
const translations = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'packages', 'backend', 'src', 'modules', 'i18n', 'translations', 'en.json'), 'utf8'),
);

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const freshPreferences = () => ({
    serverName: 'Hades',
    preset: 'frost',
    density: 'comfortable',
    wallpaper: 'sandstone',
    workspace: { order: ['applications', 'activity', 'storage', 'attention'], hidden: [], wide: ['applications', 'activity'], pinnedApps: [] },
  });
  let preferences = freshPreferences();
  const reports = [];
  const viewports = process.env.ORBIS_VISUAL_NARROW
    ? [{ name: 'narrow', width: 320, height: 800 }]
    : [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'mobile', width: 390, height: 844 },
      ];
  for (const viewport of viewports) {
    preferences = freshPreferences();
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack || error.message));
    await page.route(/^https:\/\/api\.github\.com\/repos\/twentylines\/orbis\/releases/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    );
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const respond = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname.startsWith('/api/i18n/')) return respond(translations);
      if (url.pathname.startsWith('/api/sse/')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
      if (url.pathname.endsWith('/image'))
        return route.fulfill({
          status: 200,
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="13" fill="#79947f"/></svg>',
        });
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
          userSettings: { allowAutoThemes: false, localDomain: 'local.test', sslPort: 443 },
          user: { id: 1, username: 'fixture', totpEnabled: false, locale: 'en', operator: true, hasSeenWelcome: true },
          apps: [],
          updatesAvailable: 0,
        });
      if (url.pathname === '/api/apps/installed') return respond({ installed: apps });
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
        return respond({ version: 'development', commit: null, imageDigest: null, runtipiCompatibility: '4.10.1' });
      if (url.pathname === '/api/marketplace/apps/search') return respond({ data: catalogue, nextCursor: null });
      if (url.pathname === '/api/marketplace/enabled') return respond({ appStores: [] });
      if (url.pathname === '/api/desktop-preferences') {
        if (route.request().method() === 'PUT') preferences = JSON.parse(route.request().postData() || '{}');
        return respond(preferences);
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Your server' }).waitFor();
    await page.getByText('Host CPU').waitFor();
    await page.getByText('Core network').waitFor();
    const orbisBrand = (await page.title()) === 'Orbis' && (await page.getByRole('link', { name: 'Orbis workspace on Hades' }).isVisible());
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-workspace.png`), fullPage: true });
    const workspaceOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const workspaceBackgroundGap = await page.evaluate(
      () => (document.querySelector('.desktop')?.getBoundingClientRect().bottom ?? 0) < document.documentElement.scrollHeight - 1,
    );
    await page.getByRole('button', { name: 'Edit workspace' }).click();
    if (viewport.name === 'narrow')
      await page.addStyleTag({ content: '.workspace-editor button,.workspace-editor-name,.workspace-editor p{font-size:200% !important}' });
    const dockHiddenWhileEditing = await page.getByRole('navigation', { name: 'Desktop tools' }).isHidden();
    await page.getByRole('button', { name: 'Move System activity up' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Hide Runtime filesystem' }).click();
    await page.getByRole('button', { name: 'Make System activity standard width' }).click();
    await page.getByRole('button', { name: 'Pin Backups' }).click();
    const savingAfterPin = await page.locator('.workspace-editor-sync').innerText();
    const editedOrder = await page.locator('.workspace-widget').first().locator('h2').innerText();
    const storageHidden = (await page.locator('.workspace-storage').count()) === 0;
    const activityStandard = !(await page.locator('.workspace-widget').first().getAttribute('class')).includes('workspace-widget-wide');
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-workspace-edit.png`), fullPage: true });
    const editOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    for (
      let attempt = 0;
      attempt < 40 && (preferences.workspace.hidden.length === 0 || !preferences.workspace.pinnedApps.includes('backup:test'));
      attempt++
    )
      await page.waitForTimeout(50);
    await page.reload();
    await page.getByRole('heading', { name: 'Your server' }).waitFor();
    const dockVisibleAfterReload = await page.getByRole('navigation', { name: 'Desktop tools' }).isVisible();
    const workspaceLayoutPersisted =
      (await page.locator('.workspace-widget').first().locator('h2').innerText()) === 'System activity' &&
      (await page.locator('.workspace-storage').count()) === 0;
    const pinnedAppFirst = (await page.locator('.workspace-app').first().locator('strong').innerText()) === 'Backups';
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Search tools' }).waitFor();
    await page.getByRole('textbox', { name: 'Find a tool or application' }).fill('Monitor');
    await page.getByRole('dialog', { name: 'Search tools' }).getByRole('button', { name: 'Monitor' }).click();
    await page.getByRole('heading', { name: 'Monitor', exact: true }).waitFor();
    await page.waitForTimeout(5200);
    await page.getByRole('heading', { name: 'Host memory' }).waitFor();
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-monitor.png`), fullPage: true });
    const monitorOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.getByRole('link', { name: 'Applications', exact: true }).click();
    await page
      .getByTestId('apps-list')
      .waitFor({ timeout: 5000 })
      .catch(async (error) => {
        await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-applications-error.png`), fullPage: true });
        console.error((await page.locator('body').innerText()).slice(0, 1800));
        throw error;
      });
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-applications.png`), fullPage: true });
    const appsOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.getByRole('link', { name: 'App Store', exact: true }).click();
    await page.locator('.desktop-catalogue-grid').waitFor();
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-store.png`), fullPage: true });
    const storeOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.getByRole('link', { name: 'Updates', exact: true }).click();
    await page.getByRole('heading', { name: 'Updates', exact: true }).waitFor();
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-updates.png`), fullPage: true });
    const updatesOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.getByRole('link', { name: 'Monitor', exact: true }).click();
    await page.getByRole('heading', { name: 'Monitor', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByRole('heading', { name: 'Appearance & workspace' }).waitFor();
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-appearance.png`), fullPage: true });
    const settingsOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.getByRole('button', { name: 'Graphite Deep charcoal' }).click();
    await page.getByRole('button', { name: 'Tidal' }).click();
    for (let attempt = 0; attempt < 40 && (preferences.preset !== 'graphite' || preferences.wallpaper !== 'tidal'); attempt++)
      await page.waitForTimeout(50);
    if (preferences.preset !== 'graphite') throw new Error('Graphite preference was not sent to the server fixture');
    if (preferences.wallpaper !== 'tidal') throw new Error('Tidal wallpaper was not sent to the server fixture');
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-graphite.png`), fullPage: true });
    await page.reload();
    await page.getByRole('heading', { name: 'Appearance & workspace' }).waitFor();
    const graphitePersisted = await page.getByRole('button', { name: 'Graphite Deep charcoal' }).getAttribute('aria-pressed');
    const wallpaperPersisted = await page.getByRole('button', { name: 'Tidal' }).getAttribute('aria-pressed');
    const bodyTheme = await page.evaluate(() => document.body.dataset.bsTheme);
    await page.getByRole('link', { name: 'Workspace', exact: true }).click();
    await page.getByRole('heading', { name: 'Your server' }).waitFor();
    const graphiteHeadingColor = await page.locator('.workspace-heading').evaluate((element) => getComputedStyle(element).color);
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-workspace-graphite.png`), fullPage: true });
    reports.push({
      viewport: viewport.name,
      orbisBrand,
      workspaceOverflow,
      workspaceBackgroundGap,
      editedOrder,
      dockHiddenWhileEditing,
      dockVisibleAfterReload,
      storageHidden,
      activityStandard,
      editOverflow,
      workspaceLayoutPersisted,
      pinnedAppFirst,
      savingAfterPin,
      monitorOverflow,
      appsOverflow,
      storeOverflow,
      updatesOverflow,
      settingsOverflow,
      graphitePersisted,
      wallpaperPersisted,
      bodyTheme,
      graphiteHeadingColor,
      errors,
    });
    await page.close();
  }
  await browser.close();
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  if (
    reports.some(
      (report) =>
        report.workspaceOverflow ||
        report.workspaceBackgroundGap ||
        report.editedOrder !== 'System activity' ||
        !report.dockHiddenWhileEditing ||
        !report.dockVisibleAfterReload ||
        !report.storageHidden ||
        !report.activityStandard ||
        report.editOverflow ||
        !report.workspaceLayoutPersisted ||
        !report.pinnedAppFirst ||
        report.savingAfterPin !== 'Saving layout…' ||
        !report.orbisBrand ||
        report.monitorOverflow ||
        report.appsOverflow ||
        report.storeOverflow ||
        report.updatesOverflow ||
        report.settingsOverflow ||
        report.graphitePersisted !== 'true' ||
        report.wallpaperPersisted !== 'true' ||
        report.bodyTheme !== 'dark' ||
        report.graphiteHeadingColor !== 'rgb(237, 242, 239)' ||
        report.errors.length,
    )
  )
    process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
