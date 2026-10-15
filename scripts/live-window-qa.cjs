const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
if (!cookieFile || !releaseFile || process.env.ORBIS_ALLOW_PREFERENCE_AUDIT !== '1')
  throw new Error('Set release/cookie files and ORBIS_ALLOW_PREFERENCE_AUDIT=1 for a disposable account.');
const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
const base = process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Window audit requires a loopback disposable stack');
const screenshotDir = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || path.join(os.tmpdir(), 'orbis-window-live');
fs.mkdirSync(screenshotDir, { recursive: true });
const cookies = fs
  .readFileSync(cookieFile, 'utf8')
  .split('\n')
  .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
  .map((line) => {
    const [rawDomain, , path, secure, expires, name, value] = line.split('\t');
    return {
      domain: rawDomain.replace(/^#HttpOnly_/, ''),
      path,
      secure: secure === 'TRUE',
      expires: Number(expires),
      name,
      value,
      httpOnly: rawDomain.startsWith('#HttpOnly_'),
    };
  });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1120 } });
  await context.addCookies(cookies);
  const read = async (endpoint) => {
    const response = await context.request.get(`${base}${endpoint}`);
    assert.ok(response.ok(), `Read failed with ${response.status()}`);
    return response.json();
  };
  const waitFor = async (condition, message) => {
    for (let i = 0; i < 60; i++) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(message);
  };
  let original;
  let page;
  let result;
  const errors = [];
  try {
    const build = await read('/api/system/build');
    assert.equal(build.version, release.tag);
    assert.equal(build.commit, release.commit);
    assert.equal(build.imageDigest, release.image.split('@')[1]);
    original = await read('/api/desktop-preferences');
    const serverIp = (await read('/api/app-context')).userSettings.internalIp;
    assert.ok(serverIp, 'Configured server IP is required');
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    let writes = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/desktop-preferences') writes++;
    });
    const frame = () => page.locator('.desktop-route-window');
    const layout = async (name, mode) => {
      await page.getByRole('button', { name: 'Window layout', exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
      await waitFor(async () => (await frame().getAttribute('data-window-mode')) === mode, 'Window layout did not apply');
      await waitFor(async () => (await read('/api/desktop-preferences')).windows?.settings?.mode === mode, 'Window placement did not save');
    };
    await page.goto(`${base}/settings?tab=appearance&probe=windows#draft`, { waitUntil: 'domcontentloaded' });
    const input = page.getByRole('textbox', { name: 'Server name', exact: true });
    await input.waitFor();
    await layout('Floating window', 'floating');
    await input.fill('Unsaved window audit draft');
    await page.getByRole('button', { name: 'Minimize Settings', exact: true }).click();
    await frame().waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: original.serverName, exact: true }).waitFor();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await frame().waitFor({ state: 'visible' });
    assert.equal(await input.inputValue(), 'Unsaved window audit draft');
    assert.equal(new URL(page.url()).searchParams.get('probe'), 'windows');
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'appearance');
    assert.equal(new URL(page.url()).hash, '#draft');
    assert.equal((await read('/api/desktop-preferences')).serverName, original.serverName);
    await page.waitForTimeout(700);
    const before = await frame().boundingBox();
    const bar = await page.locator('.desktop-window-bar').boundingBox();
    writes = 0;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width / 2 + 70, bar.y + bar.height / 2 + 30, { steps: 8 });
    await page.waitForTimeout(450);
    assert.equal(writes, 0, 'Pointer movement saved too early');
    await page.mouse.up();
    await waitFor(
      async () => (await read('/api/desktop-preferences')).windows.settings.bounds.x === Math.round(before.x + 70),
      'Dragged bounds did not persist',
    );
    assert.equal(writes, 1, 'A completed drag must make one debounced write');
    const moved = await frame().boundingBox();
    assert.equal(Math.round(moved.y - before.y), 30);
    await page.getByRole('button', { name: 'Maximize Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Restore Settings size', exact: true }).click();
    assert.ok(isDeepStrictEqual(await frame().boundingBox(), moved), 'Maximize restore lost floating bounds');
    await layout('Snap left', 'left');
    const left = await frame().boundingBox();
    await layout('Snap right', 'right');
    const right = await frame().boundingBox();
    assert.equal(left.width, right.width);
    assert.equal(right.x - left.x - left.width, 16);
    await layout('Floating window', 'floating');
    await page.evaluate(() => localStorage.removeItem('server-desktop-preferences-v1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await input.waitFor();
    await waitFor(async () => (await frame().getAttribute('data-window-mode')) === 'floating', 'Account-backed window placement did not load');
    assert.equal(await input.inputValue(), original.serverName, 'Reload should discard an unsaved form draft');
    assert.equal(await frame().getAttribute('data-window-mode'), 'floating');
    assert.ok(isDeepStrictEqual(await frame().boundingBox(), moved), 'Account-backed bounds did not survive reload');
    await page.screenshot({ path: path.join(screenshotDir, 'floating-settings.png'), animations: 'disabled' });
    await page.getByRole('link', { name: 'Monitor', exact: true }).click();
    await page.getByRole('heading', { name: 'Monitor', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Maximize Monitor', exact: true }).click();
    await waitFor(async () => (await read('/api/desktop-preferences')).windows?.monitor?.mode === 'maximized', 'Monitor placement did not save');
    const prefs = await read('/api/desktop-preferences');
    assert.equal(prefs.windows.settings.mode, 'floating');
    await page.screenshot({ path: path.join(screenshotDir, 'monitor.png'), animations: 'disabled' });
    await page.goto(`${base}/settings?tab=appearance`, { waitUntil: 'domcontentloaded' });
    await input.waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await waitFor(async () => (await frame().getAttribute('data-window-mode')) === 'focused', 'Mobile fallback did not apply');
    assert.equal(await frame().getAttribute('data-window-mode'), 'focused');
    assert.equal(await page.getByRole('button', { name: 'Window layout', exact: true }).count(), 0);
    await page.locator('.desktop-connection-dot.is-connected').waitFor();
    assert.equal((await page.locator('.desktop-connection').innerText()).trim(), serverIp);
    await page.getByRole('button', { name: 'Minimize Settings', exact: true }).click();
    await frame().waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: original.serverName, exact: true }).waitFor();
    await page.screenshot({ path: path.join(screenshotDir, 'minimized-mobile.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Restore Settings', exact: true }).click();
    await frame().waitFor({ state: 'visible' });
    assert.deepEqual(errors, []);
    result = {
      version: build.version,
      digest: build.imageDigest,
      draftPreserved: true,
      dragWrites: 1,
      snapGap: 16,
      accountBoundsPersisted: true,
      perToolPlacement: true,
      mobileFallback: true,
      serverIpVisible: true,
      pageErrors: errors,
    };
  } finally {
    try {
      if (page && !page.isClosed()) await page.close();
      if (original) {
        const response = await context.request.put(`${base}/api/desktop-preferences`, { headers: { Origin: base }, data: original });
        assert.ok(response.ok(), 'Preference restoration failed');
        assert.ok(isDeepStrictEqual(await read('/api/desktop-preferences'), original), 'Original preferences were not restored');
      }
    } finally {
      await browser.close();
    }
  }
  process.stdout.write(`${JSON.stringify({ ...result, originalPreferencesRestored: true })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
