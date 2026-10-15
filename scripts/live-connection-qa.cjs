const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const base = process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080';
if (!releaseFile || !cookieFile || process.env.ORBIS_ALLOW_PREFERENCE_AUDIT !== '1')
  throw new Error('Release, cookie and preference-audit opt-in required');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname));
const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
const screenshots = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || '/tmp/orbis-connection-live';
fs.mkdirSync(screenshots, { recursive: true });
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
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const read = async (url) => {
    const response = await context.request.get(`${base}${url}`);
    assert.ok(response.ok());
    return response.json();
  };
  let original;
  let page;
  let releaseStream;
  const errors = [];
  const cases = [];
  try {
    const build = await read('/api/system/build');
    assert.equal(build.version, release.tag);
    assert.equal(build.commit, release.commit);
    assert.equal(build.imageDigest, release.image.split('@')[1]);
    original = await read('/api/desktop-preferences');
    const ip = (await read('/api/app-context')).userSettings.internalIp;
    assert.ok(ip);
    for (const width of [1440, 768, 390, 320]) {
      for (const mode of ['light', 'dark']) {
        const saved = await context.request.put(`${base}/api/desktop-preferences`, { headers: { Origin: base }, data: { ...original, mode } });
        assert.ok(saved.ok());
        page = await context.newPage();
        await page.setViewportSize({ width, height: width >= 768 ? 1024 : 844 });
        page.on('pageerror', (error) => errors.push(error.message));
        const held = new Promise((resolve) => {
          releaseStream = resolve;
        });
        let firstStream = true;
        await page.route(
          (url) => url.pathname === '/api/sse/app',
          async (route) => {
            if (firstStream) {
              firstStream = false;
              await held;
              await route.abort('internetdisconnected');
            } else await route.continue();
          },
        );
        await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
        await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
        const check = async (state, label) => {
          await page.locator(`.desktop-connection-dot.is-${state}`).waitFor();
          assert.equal((await page.locator('.desktop-connection-label').innerText()).trim(), label);
          const geometry = await page.locator('.desktop-connection').evaluate((node) => {
            const dot = node.querySelector('.desktop-connection-dot').getBoundingClientRect();
            const label = node.querySelector('.desktop-connection-label').getBoundingClientRect();
            const bar = node.closest('.desktop-system-bar').getBoundingClientRect();
            return {
              centered: Math.abs(dot.y + dot.height / 2 - label.y - label.height / 2) < 0.5,
              contained: label.left >= bar.left && label.right <= bar.right,
              overflow: document.documentElement.scrollWidth > innerWidth,
              secondaryText: node.querySelectorAll('small').length,
            };
          });
          assert.deepEqual(geometry, { centered: true, contained: true, overflow: false, secondaryText: 0 });
          await page
            .locator('.desktop-system-bar')
            .screenshot({ path: path.join(screenshots, `connection-${width}-${mode}-${state}.png`), animations: 'disabled' });
        };
        await check('connecting', 'Connecting');
        releaseStream();
        releaseStream = undefined;
        await check('reconnecting', 'Reconnecting');
        await check('connected', ip);
        cases.push({ width, mode, nativeEventSource: true, heldInitialRequest: true, abortedInitialRequest: true, recoveredWithRealEndpoint: true });
        await page.close();
        page = undefined;
      }
    }
    assert.deepEqual(errors, []);
    process.stdout.write(`${JSON.stringify({ version: release.tag, cases, errors })}\n`);
  } finally {
    try {
      releaseStream?.();
      await context.setOffline(false);
      await page?.close();
      if (original) {
        const restored = await context.request.put(`${base}/api/desktop-preferences`, { headers: { Origin: base }, data: original });
        assert.ok(restored.ok());
        assert.ok(isDeepStrictEqual(await read('/api/desktop-preferences'), original));
      }
    } finally {
      await browser.close();
    }
  }
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
