const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
if (!cookieFile || !releaseFile || process.env.ORBIS_ALLOW_PREFERENCE_AUDIT !== '1')
  throw new Error('Set release/cookie files and ORBIS_ALLOW_PREFERENCE_AUDIT=1 for a disposable account.');
const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
const screenshotDir = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || require('node:path').join(require('node:os').tmpdir(), 'orbis-desktop-qa');
fs.mkdirSync(screenshotDir, { recursive: true });
const base = process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('This audit requires a loopback disposable stack.');
const urn = process.env.ORBIS_AUDIT_APP_URN || 'whoami:migrated';
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies(cookies);
  const read = async (path) => {
    const response = await context.request.get(`${base}${path}`);
    assert.ok(response.ok(), `Read failed with ${response.status()}`);
    return response.json();
  };
  let original;
  let page;
  const errors = [];
  try {
    const build = await read('/api/system/build');
    assert.equal(build.version, release.tag);
    assert.equal(build.commit, release.commit);
    assert.equal(build.imageDigest, release.image.split('@')[1]);
    original = await read('/api/desktop-preferences');
    const installed = await read('/api/apps/installed');
    const app = installed.installed.find(({ info }) => info.urn === urn);
    assert.ok(app, 'Disposable app is missing');
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: original.serverName, exact: true }).waitFor();
    const address = await page.locator('.desktop-connection-label').innerText();
    assert.match(address, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    assert.equal(await page.locator('.desktop-connection-label').isVisible(), true);
    await page.getByRole('button', { name: 'Choose home apps', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Show all installed apps', exact: true });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
    const pin = page.getByRole('button', { name: `Pin ${app.info.name}`, exact: true });
    if (await pin.count()) await pin.click();
    for (const label of ['Recent operations', 'Needs attention']) {
      const hide = page.getByRole('button', { name: `Hide ${label}`, exact: true });
      if (await hide.count()) await hide.click();
    }
    await page.getByText('Saved to your account.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Done editing', exact: true }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.workspace-app-scroll').waitFor();
    const saved = await read('/api/desktop-preferences');
    assert.equal(saved.workspace.showAllApps, true);
    assert.ok(saved.workspace.pinnedApps.includes(urn));
    assert.ok(saved.workspace.hidden.includes('storage') && saved.workspace.hidden.includes('attention'));
    assert.equal(await page.locator('.workspace-app-scroll').getAttribute('data-scroll'), 'false');
    await page.getByRole('button', { name: 'Choose home apps', exact: true }).click();
    await page.getByRole('button', { name: 'Restore layout', exact: true }).click();
    await page.getByText('Saved to your account.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Done editing', exact: true }).click();
    assert.equal(await page.locator('.workspace-operations').count(), 1);
    assert.equal(await page.locator('.workspace-attention').count(), 1);
    assert.equal(await page.locator('.workspace-app-scroll').getAttribute('data-scroll'), 'true');
    await page.screenshot({ path: require('node:path').join(screenshotDir, 'workspace-mobile.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Search tools and settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search Orbis' });
    const input = dialog.getByRole('searchbox', { name: 'Find a tool or application' });
    await input.fill(app.info.name);
    await dialog
      .getByRole('region', { name: 'Installed apps', exact: true })
      .getByRole('button')
      .filter({ hasText: app.info.name })
      .first()
      .waitFor();
    await dialog.getByRole('region', { name: 'App Store', exact: true }).getByRole('button').filter({ hasText: app.info.name }).first().waitFor();
    await dialog.locator('img.app-logo').evaluateAll(async (images) => Promise.all(images.map((image) => image.decode())));
    await page.screenshot({ path: require('node:path').join(screenshotDir, 'search-mobile.png'), animations: 'disabled' });
    await input.fill('system updates');
    await dialog.getByRole('button', { name: 'Updates', exact: true }).waitFor();
    await input.press('Enter');
    await page.getByRole('heading', { name: 'Updates', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/updates');
    await page.keyboard.press('Control+k');
    await dialog.getByRole('searchbox').fill('appearance');
    await dialog.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('heading', { name: 'Server name', exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'appearance');
    await page.keyboard.press('Control+k');
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement === document.querySelector('.desktop-search-trigger'));
    assert.deepEqual(errors, []);
    process.stdout.write(
      `${JSON.stringify({
        version: build.version,
        ipVisible: true,
        preferencesPersisted: true,
        cardsRestored: true,
        installedAndCatalogueSearch: true,
        iconsDecoded: true,
        sectionSearchRoutes: true,
        focusRestored: true,
        pageErrors: errors,
      })}\n`,
    );
  } finally {
    if (page) await page.close();
    if (original) {
      const response = await context.request.put(`${base}/api/desktop-preferences`, { data: original, headers: { Origin: base } });
      assert.ok(response.ok(), `Preference restoration failed with ${response.status()}`);
      assert.deepEqual(await read('/api/desktop-preferences'), original, 'Original preferences were not restored');
    }
    await browser.close();
  }
})()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
