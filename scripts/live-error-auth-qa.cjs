const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const base = process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080';
assert.ok(
  cookieFile && releaseFile && process.env.ORBIS_ALLOW_ERROR_AUTH_AUDIT === '1' && process.env.ORBIS_ALLOW_PREFERENCE_AUDIT === '1',
  'Provide release/cookie files and both ORBIS_ALLOW_ERROR_AUTH_AUDIT=1 and ORBIS_ALLOW_PREFERENCE_AUDIT=1',
);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Requires an owned loopback test server');
const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
const output = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || '/tmp/orbis-live-error-auth-qa';
fs.mkdirSync(output, { recursive: true });
const cookies = fs
  .readFileSync(cookieFile, 'utf8')
  .split('\n')
  .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
  .map((line) => {
    const [domain, , cookiePath, secure, expires, name, value] = line.split('\t');
    return {
      domain: domain.replace(/^#HttpOnly_/, ''),
      path: cookiePath,
      secure: secure === 'TRUE',
      expires: Number(expires),
      name,
      value,
      httpOnly: domain.startsWith('#HttpOnly_'),
    };
  });
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const report = {
    release: release.tag,
    passed: false,
    states: [],
    mutations: [],
    pagePreferenceWrites: 0,
    directPreferenceWrites: 0,
    syntheticLoginRequests: 0,
    preferencesRestored: false,
    restorationFailed: false,
    pageErrors: [],
  };
  let reader;
  let original;
  let failure;
  try {
    reader = await browser.newContext();
    await reader.addCookies(cookies);
    const read = async (endpoint) => {
      const response = await reader.request.get(`${base}${endpoint}`);
      assert.ok(response.ok(), `${endpoint} returned ${response.status()}`);
      return response.json();
    };
    const build = await read('/api/system/build');
    assert.equal(build.version, release.tag);
    assert.equal(build.commit, release.commit);
    assert.equal(build.imageDigest, release.image.split('@')[1]);
    original = await read('/api/desktop-preferences');
    const inspect = async (page, selector) =>
      page.locator(selector).evaluate((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, right: r.right, width: r.width, height: r.height, overflow: document.documentElement.scrollWidth > innerWidth };
      });
    const check = (geometry, width) => {
      assert.equal(geometry.overflow, false, 'Page overflows horizontally');
      assert.ok(geometry.x >= 12 && geometry.right <= width - 12, 'Viewport padding is missing');
    };
    const watch = async (page, syntheticLogin = false) => {
      page.on('pageerror', (error) => report.pageErrors.push(error.message));
      page.on('request', (request) => {
        const endpoint = new URL(request.url()).pathname;
        if (endpoint === '/api/desktop-preferences' && request.method() === 'PUT') report.pagePreferenceWrites += 1;
        else if (syntheticLogin && endpoint === '/api/auth/login' && request.method() === 'POST') return;
        else if (endpoint.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
          report.mutations.push({ method: request.method(), path: endpoint });
      });
      await page.route('**/api/**', (route) => {
        const request = route.request();
        if (
          ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) ||
          (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/desktop-preferences')
        )
          return route.continue();
        return route.abort();
      });
    };
    for (const width of [1440, 390, 320]) {
      for (const mode of ['light', 'dark']) {
        const preferences = { ...original, mode, windows: {} };
        report.directPreferenceWrites += 1;
        const saved = await reader.request.put(`${base}/api/desktop-preferences`, { data: preferences, headers: { Origin: base } });
        assert.ok(saved.ok(), 'Could not prepare the disposable account appearance');
        assert.deepEqual(await read('/api/desktop-preferences'), preferences);
        const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1120 : 844 } });
        try {
          await context.addCookies(cookies);
          await context.addInitScript((value) => localStorage.setItem('server-desktop-preferences-v1', JSON.stringify(value)), preferences);
          const page = await context.newPage();
          await watch(page);
          let failing = true;
          await page.route('**/api/marketplace/all', (route) =>
            failing && route.request().method() === 'GET'
              ? route.fulfill({
                  status: 500,
                  contentType: 'application/json',
                  body: JSON.stringify({ message: 'Controlled catalogue failure for the error-screen audit.' }),
                })
              : route.fallback(),
          );
          await page.goto(`${base}/settings?tab=appstores`, { waitUntil: 'domcontentloaded' });
          await page.locator('.orbis-error').waitFor();
          const closed = await inspect(page, '.desktop-fallback-panel');
          check(closed, width);
          assert.ok(closed.width <= 480 && closed.height < 380, 'Closed error card has excessive space');
          assert.equal(await page.locator('.desktop-fallback').getAttribute('data-desktop-mode'), mode);
          assert.equal(await page.locator('.orbis-error-details').getAttribute('open'), null);
          await page.screenshot({ path: path.join(output, `error-${mode}-${width}.png`) });
          await page.getByText('Details', { exact: true }).click();
          assert.equal(await page.locator('.orbis-error-details dd').first().innerText(), '/settings');
          assert.match(await page.locator('.orbis-error-details dd').last().innerText(), /Controlled catalogue failure/);
          check(await inspect(page, '.desktop-fallback-panel'), width);
          await page.screenshot({ path: path.join(output, `error-details-${mode}-${width}.png`) });
          failing = false;
          await page.getByRole('button', { name: 'Retry', exact: true }).click();
          await page.getByRole('button', { name: 'Add app store', exact: true }).waitFor();
          assert.equal(await page.locator('.orbis-error').count(), 0);
          await page.goto(`${base}/settings?tab=appearance`, { waitUntil: 'domcontentloaded' });
          await page.locator('.appearance').waitFor();
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.locator('.appearance').waitFor();
          await page.getByText('Synced to your account', { exact: true }).waitFor();
          assert.equal(await page.locator('.orbis-error').count(), 0);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await page.screenshot({ path: path.join(output, `settings-${mode}-${width}.png`) });
          report.states.push({ width, mode, error: closed, retryRecovered: true, settingsLoaded: true });
        } finally {
          await context.close();
        }
        const anonymous = await browser.newContext({ viewport: { width, height: width === 1440 ? 1120 : 844 } });
        try {
          await anonymous.addInitScript((value) => localStorage.setItem('server-desktop-preferences-v1', JSON.stringify(value)), preferences);
          const page = await anonymous.newPage();
          await watch(page, true);
          await page.route('**/api/auth/login', async (route) => {
            assert.equal(route.request().method(), 'POST');
            report.syntheticLoginRequests += 1;
            await route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({ success: true, totpSessionId: 'synthetic-visual-audit-session' }),
            });
          });
          await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
          await page.locator('.desktop-auth input[type="password"]').waitFor();
          const card = await inspect(page, '.desktop-auth .card');
          check(card, width);
          const toolbar = await page.locator('.desktop-auth-toolbar button').evaluateAll((nodes) =>
            nodes.map((node) => {
              const r = node.getBoundingClientRect();
              return { y: r.y, height: r.height, cy: r.y + r.height / 2 };
            }),
          );
          assert.equal(toolbar.length, 2);
          assert.ok(Math.abs(toolbar[0].cy - toolbar[1].cy) <= 1, 'Login toolbar controls must share one centre line');
          assert.ok(Math.abs(toolbar[0].height - toolbar[1].height) <= 1, 'Login toolbar controls must have equal height');
          assert.equal(await page.locator('.desktop-auth').getAttribute('data-desktop-mode'), mode);
          assert.equal(await page.locator('.desktop-auth .card .desktop-auth-credit').count(), 1);
          await page.screenshot({ path: path.join(output, `login-${mode}-${width}.png`) });
          report.states.push({ width, mode, login: card, toolbar });
          await page.getByLabel('Email address', { exact: true }).fill('auth-audit@example.test');
          await page.getByLabel('Password', { exact: true }).fill('synthetic-audit-password');
          await page.getByRole('button', { name: 'Log in', exact: true }).click();
          const digits = page.locator('.otp-group input');
          await digits.first().waitFor();
          assert.equal(await digits.count(), 6);
          await digits.first().fill('123456');
          assert.equal(await digits.evaluateAll((nodes) => nodes.map((node) => node.value).join('')), '123456');
          const measureDigits = async () =>
            digits.evaluateAll((nodes) =>
              nodes.map((node) => {
                const style = getComputedStyle(node);
                const probe = document.createElement('span');
                probe.style.cssText = 'position:fixed;left:-10000px;top:0;white-space:pre;';
                for (const property of [
                  'fontFamily',
                  'fontSize',
                  'fontWeight',
                  'fontStyle',
                  'fontVariantNumeric',
                  'fontFeatureSettings',
                  'letterSpacing',
                  'lineHeight',
                ])
                  probe.style[property] = style[property];
                probe.textContent = node.value;
                document.body.append(probe);
                const glyph = probe.getBoundingClientRect();
                probe.remove();
                const r = node.getBoundingClientRect();
                return {
                  width: r.width,
                  height: r.height,
                  y: r.y,
                  contentWidth: node.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
                  contentHeight: node.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom),
                  glyphWidth: glyph.width,
                  lineHeight: glyph.height,
                  visible: style.visibility === 'visible' && Number(style.opacity) > 0 && r.y >= 0 && r.bottom <= innerHeight,
                  hitTarget: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node,
                };
              }),
            );
          const nativeDigits = await measureDigits();
          for (const digit of nativeDigits) {
            assert.ok(digit.contentWidth >= digit.glyphWidth + 1, 'Entered two-factor digit is clipped');
            assert.ok(
              digit.contentHeight >= digit.lineHeight && digit.visible && digit.hitTarget,
              'Two-factor digit is vertically clipped or obscured',
            );
            assert.ok(digit.height >= 44);
            assert.ok(Math.abs(digit.y - nativeDigits[0].y) < 1);
            assert.ok(Math.abs(digit.width - nativeDigits[0].width) < 1);
          }
          check(await inspect(page, '.desktop-auth .card'), width);
          await page.screenshot({ path: path.join(output, `two-factor-${mode}-${width}.png`) });
          await digits.evaluateAll((nodes) =>
            nodes.forEach((node) => {
              node.style.fontSize = `${Number.parseFloat(getComputedStyle(node).fontSize) * 2}px`;
            }),
          );
          const enlargedDigits = await measureDigits();
          for (const digit of enlargedDigits) {
            assert.ok(digit.contentWidth >= digit.glyphWidth + 1, 'Enlarged two-factor digit is clipped');
            assert.ok(
              digit.contentHeight >= digit.lineHeight && digit.visible && digit.hitTarget,
              'Enlarged two-factor digit is vertically clipped or obscured',
            );
          }
          check(await inspect(page, '.desktop-auth .card'), width);
          await page.screenshot({ path: path.join(output, `two-factor-enlarged-digits-${mode}-${width}.png`) });
          report.states.push({ width, mode, syntheticTwoFactorChallenge: true, nativeDigits, enlargedDigits });
        } finally {
          await anonymous.close();
        }
      }
    }
    assert.deepEqual(report.mutations, [], 'Audit issued an unexpected API mutation');
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (reader && original) {
        report.directPreferenceWrites += 1;
        const response = await reader.request.put(`${base}/api/desktop-preferences`, { data: original, headers: { Origin: base } });
        assert.ok(response.ok(), 'Preference restoration failed');
        const restored = await reader.request.get(`${base}/api/desktop-preferences`);
        assert.ok(restored.ok());
        assert.deepEqual(await restored.json(), original, 'Original preferences were not restored');
        report.preferencesRestored = true;
      }
    } catch (error) {
      report.restorationFailed = true;
      report.passed = false;
      failure ||= error;
    } finally {
      await browser.close();
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (failure) throw failure;
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
