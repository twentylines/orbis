// Run only against a fresh disposable Orbis stack bound to loopback.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const base = process.env.ORBIS_SMOKE_URL || 'http://127.0.0.1:18080';
const parsed = new URL(base);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
  throw new Error('The live smoke test accepts only a loopback test stack.');
}

const screenshots = path.join(__dirname, '..', 'screenshots', 'live-smoke');
fs.mkdirSync(screenshots, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    for (const endpoint of ['/api/system/telemetry', '/api/system/build', '/api/desktop-preferences']) {
      const response = await page.request.get(`${base}${endpoint}`);
      assert.equal(response.status(), 401, `${endpoint} should require authentication`);
    }

    await page.goto(`${base}/register`);
    await page.locator('input[type=email]').fill('browser@orbis.test');
    const password = randomBytes(24).toString('base64url');
    await page.locator('input[type=password]').nth(0).fill(password);
    await page.locator('input[type=password]').nth(1).fill(password);
    await page.locator('button[type=submit]').click();
    await page.waitForURL('**/dashboard');
    await page.getByRole('button', { name: 'Save and enter' }).click();
    await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
    assert.equal(await page.title(), 'Orbis');

    const preferences = { serverName: 'Orbis Test', preset: 'graphite', density: 'compact' };
    const saved = await page.request.put(`${base}/api/desktop-preferences`, {
      headers: { Origin: base },
      data: preferences,
    });
    assert.equal(saved.status(), 200, 'saving preferences should succeed');
    const reloaded = await page.request.get(`${base}/api/desktop-preferences`);
    assert.deepEqual(await reloaded.json(), preferences);
    await page.reload();
    await page.getByRole('heading', { name: 'Orbis Test', exact: true }).waitFor();

    const api = {};
    for (const endpoint of [
      '/api/marketplace/all',
      '/api/marketplace/apps/search?pageSize=5',
      '/api/apps/installed',
      '/api/system/telemetry',
      '/api/system/build',
    ]) {
      const response = await page.request.get(`${base}${endpoint}`);
      assert.equal(response.status(), 200, `${endpoint} should succeed`);
      api[endpoint] = await response.json();
    }
    assert.equal(api['/api/system/build'].version, process.env.ORBIS_EXPECTED_VERSION || 'development');

    for (const [name, route] of [
      ['workspace', '/dashboard'],
      ['monitor', '/monitor'],
      ['updates', '/updates'],
      ['store', '/app-store'],
      ['apps', '/apps'],
      ['settings', '/settings'],
    ]) {
      await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(650);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} should fit the viewport`);
      await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
    }

    let lifecycle = null;
    if (process.env.ORBIS_SMOKE_LIFECYCLE === '1') {
      const search = await page.request.get(`${base}/api/marketplace/apps/search?search=whoami&pageSize=20`);
      assert.equal(search.status(), 200);
      const catalogue = await search.json();
      const whoami = catalogue.data.find((item) => item.id === 'whoami');
      assert.ok(whoami?.urn, 'the official store should contain Whoami');
      const urn = encodeURIComponent(whoami.urn);

      const waitForStatus = async (expected) => {
        for (let attempt = 0; attempt < 120; attempt++) {
          const response = await page.request.get(`${base}/api/apps/installed`);
          assert.equal(response.status(), 200);
          const installed = await response.json();
          const entry = installed.installed.find((item) => item.info.urn === whoami.urn);
          const status = entry?.app.status || 'absent';
          if (status === expected) return;
          if (status === 'error') throw new Error(`Whoami entered error state while waiting for ${expected}`);
          await page.waitForTimeout(1000);
        }
        throw new Error(`Whoami did not reach ${expected} within two minutes`);
      };

      const command = async (method, suffix, data) => {
        const response = await page.request[method](`${base}/api/app-lifecycle/${urn}/${suffix}`, {
          headers: { Origin: base },
          ...(data === undefined ? {} : { data }),
        });
        assert.ok(response.ok(), `${suffix} should be accepted: ${response.status()} ${await response.text()}`);
        const result = await response.json();
        assert.ok(result.requestId, `${suffix} should return a request ID`);
      };

      await command('post', 'install', { openPort: false, exposed: false, exposedLocal: false });
      await waitForStatus('running');
      await command('post', 'stop');
      await waitForStatus('stopped');
      await command('post', 'start');
      await waitForStatus('running');
      await command('post', 'restart');
      await waitForStatus('running');
      const backup = await page.request.post(`${base}/api/backups/${urn}/backup`, { headers: { Origin: base } });
      assert.ok(backup.ok(), `backup should be accepted: ${backup.status()} ${await backup.text()}`);
      assert.ok((await backup.json()).requestId, 'backup should return a request ID');
      await waitForStatus('running');
      const listed = await page.request.get(`${base}/api/backups/${urn}`);
      assert.equal(listed.status(), 200);
      const backups = await listed.json();
      const savedBackup = backups.data.find((item) => item.id.endsWith('.tar.gz'));
      assert.ok(savedBackup, 'backup should create a downloadable archive');
      await command('post', 'reset');
      await waitForStatus('running');
      const restore = await page.request.post(`${base}/api/backups/${urn}/restore`, {
        headers: { Origin: base },
        data: { filename: savedBackup.id },
      });
      assert.ok(restore.ok(), `restore should be accepted: ${restore.status()} ${await restore.text()}`);
      assert.ok((await restore.json()).requestId, 'restore should return a request ID');
      await waitForStatus('running');
      await command('delete', 'uninstall', { removeBackups: true });
      await waitForStatus('absent');
      lifecycle = { app: whoami.urn, actions: ['install', 'stop', 'start', 'restart', 'backup', 'reset', 'restore', 'uninstall'] };
    }

    assert.deepEqual(errors, [], 'browser should have no page errors');
    console.info(
      JSON.stringify({
        result: 'passed',
        title: await page.title(),
        storeCount: api['/api/marketplace/all'].appStores.length,
        catalogueTotal: api['/api/marketplace/apps/search?pageSize=5'].total,
        screens: 6,
        lifecycle,
        pageErrors: errors.length,
      }),
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
