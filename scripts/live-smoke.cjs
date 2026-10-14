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

    for (const endpoint of ['/api/system/telemetry', '/api/desktop-preferences']) {
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
    await page.getByRole('heading', { name: 'Your server' }).waitFor();
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
    await page.getByRole('heading', { name: 'Your server' }).waitFor();

    const api = {};
    for (const endpoint of ['/api/marketplace/all', '/api/marketplace/apps/search?pageSize=5', '/api/apps/installed', '/api/system/telemetry']) {
      const response = await page.request.get(`${base}${endpoint}`);
      assert.equal(response.status(), 200, `${endpoint} should succeed`);
      api[endpoint] = await response.json();
    }

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

    assert.deepEqual(errors, [], 'browser should have no page errors');
    console.log(
      JSON.stringify({
        result: 'passed',
        title: await page.title(),
        storeCount: api['/api/marketplace/all'].appStores.length,
        catalogueTotal: api['/api/marketplace/apps/search?pageSize=5'].total,
        screens: 6,
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
