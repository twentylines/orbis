const assert = require('node:assert/strict');
const { dom } = require('./host-devices-checks.cjs');

module.exports = async function inspectStartup({ page, base, preferences, capture }) {
  assert.equal(base, 'http://localhost:8080', 'Startup checks require isolated source fixtures');
  const key = 'server-desktop-preferences-v1';
  const report = { passed: false, samples: [], recovery: [], anonymous: [], writes: [], errors: [], cleanup: {} };
  const storage = await page.evaluate((key) => localStorage.getItem(key), key);
  const viewport = page.viewportSize();
  let shadow = structuredClone(preferences);
  let phase = 'success';
  let anonymous = false;
  let preferenceReads = 0;
  let release;
  let arrived;
  let gate;
  let arrival;
  let contextHeld = false;
  let contextRelease;
  let contextArrived;
  let contextGate;
  const hold = () => {
    gate = new Promise((resolve) => {
      release = resolve;
    });
    arrival = new Promise((resolve) => {
      arrived = resolve;
    });
  };
  const onError = (error) => report.errors.push(error.message);
  const awaitArrival = async (promise) => {
    let timer;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Startup request did not arrive')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    if (phase === 'static' && request.resourceType() === 'script') return route.abort('blockedbyclient');
    if (contextHeld && url.pathname === '/api/app-context') {
      contextArrived();
      await contextGate;
      return route.fallback();
    }
    if (url.pathname === '/api/user-context' && anonymous)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: { current: '4.10.1', latest: '4.10.1', body: '', releases: [] },
          isLoggedIn: false,
          isConfigured: true,
          isGuestDashboardEnabled: false,
          allowAutoThemes: false,
          allowErrorMonitoring: false,
          themeColor: 'blue',
          themeBase: 'slate',
        }),
      });
    if (url.pathname !== '/api/desktop-preferences') {
      assert.ok(['GET', 'HEAD'].includes(request.method()), 'Startup must not perform unrelated mutations');
      return route.fallback();
    }
    if (request.method() === 'PUT') {
      assert.ok(phase === 'retry', 'Startup must not write server preferences');
      shadow = JSON.parse(request.postData());
      report.writes.push(structuredClone(shadow));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(shadow) });
    }
    assert.equal(request.method(), 'GET');
    preferenceReads++;
    const currentPhase = phase;
    if (['held', 'retry', 'timeout'].includes(currentPhase)) {
      arrived();
      await gate;
    }
    if (currentPhase === 'failure') return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    if (currentPhase === 'invalid') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"mode":"dark"}' });
    try {
      return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(shadow) });
    } catch (error) {
      if (currentPhase !== 'timeout') throw error;
    }
  };
  await page.route('**/*', handler);
  page.on('pageerror', onError);
  await page.addInitScript(
    ({ key }) => {
      const config = JSON.parse(window.name || '{}');
      if (!config.startupCheck) return;
      if (config.cache === null) localStorage.removeItem(key);
      else localStorage.setItem(key, config.cache);
      if (config.blocked)
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() {
            throw new DOMException('Storage blocked', 'SecurityError');
          },
        });
      window.__startupFrames = [];
      const inspect = () => {
        const desktop = document.querySelector('.desktop[data-desktop-mode], .desktop-auth[data-desktop-mode]');
        const sample = {
          ready: document.readyState,
          startup: Boolean(document.querySelector('.orbis-startup')),
          mode: desktop?.dataset.desktopMode ?? null,
          preset: desktop?.dataset.desktopPreset ?? null,
          body: document.body?.dataset.bsTheme ?? null,
        };
        const frames = window.__startupFrames;
        if (JSON.stringify(frames.at(-1)) !== JSON.stringify(sample)) frames.push(sample);
        requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    },
    { key },
  );
  const configure = async (config) =>
    page.evaluate((config) => {
      window.name = JSON.stringify({ startupCheck: true, ...config });
    }, config);
  const frames = () => page.evaluate(() => window.__startupFrames);
  const checkFrames = (samples, mode, preset) => {
    assert.ok(
      samples.every((sample) => sample.ready === 'loading' || sample.startup || sample.mode),
      'Startup must not leave a blank committed page',
    );
    assert.ok(
      samples.some((sample) => sample.mode === mode),
      'The expected workspace must actually paint',
    );
    for (const sample of samples.filter((sample) => sample.mode)) {
      assert.equal(sample.mode, mode, 'A workspace frame painted the wrong mode');
      assert.equal(sample.preset, preset, 'A workspace frame painted the wrong preset');
      assert.equal(sample.body, mode, 'Legacy body chrome must agree before paint');
    }
  };
  const loaded = (mode, preset) =>
    page.waitForFunction(
      ({ mode, preset }) => {
        const desktop = document.querySelector('.desktop[data-desktop-mode], .desktop-auth[data-desktop-mode]');
        return (
          desktop?.dataset.desktopMode === mode &&
          desktop?.dataset.desktopPreset === preset &&
          document.body.dataset.bsTheme === mode &&
          !document.querySelector('.orbis-startup')
        );
      },
      { mode, preset },
    );
  try {
    for (const mode of ['light', 'dark'])
      for (const width of [1440, 768, 390, 320])
        for (const scale of [1, 2]) {
          const cacheType = { 1440: 'cold', 768: 'stale', 390: 'invalid', 320: 'blocked' }[width];
          shadow = { ...structuredClone(preferences), mode, preset: mode === 'dark' ? 'ocean' : 'blush', wallpaper: 'tidal' };
          const cached =
            cacheType === 'stale'
              ? JSON.stringify({ ...shadow, mode: mode === 'dark' ? 'light' : 'dark', preset: 'frost' })
              : cacheType === 'invalid'
                ? '{invalid'
                : null;
          phase = 'held';
          hold();
          await page.setViewportSize({ width, height: width === 1440 ? 1120 : width === 768 ? 1024 : 844 });
          await page.emulateMedia({ colorScheme: mode === 'dark' ? 'light' : 'dark' });
          await configure({ cache: cached, blocked: cacheType === 'blocked' });
          await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
          await awaitArrival(arrival);
          await page.locator('.orbis-startup output').waitFor();
          await page.waitForTimeout(180);
          assert.equal(await page.locator('.desktop').count(), 0, 'Pending preferences must not reveal a default or stale desktop');
          assert.ok((await frames()).every((sample) => sample.mode === null));
          if (cacheType !== 'blocked')
            assert.equal(
              await page.evaluate((key) => localStorage.getItem(key), key),
              cached,
              'An unresolved load must not manufacture or overwrite cached preferences',
            );
          await dom.scaleText(page, scale);
          await capture(`${mode}-${width}-text${scale}-loading`, { scrollTop: false });
          release();
          await loaded(mode, shadow.preset);
          await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
          await dom.restoreText(page);
          await dom.scaleText(page, scale);
          await dom.settle(page);
          const samples = await frames();
          checkFrames(samples, mode, shadow.preset);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await capture(`${mode}-${width}-text${scale}-loaded`, { scrollTop: false });
          report.samples.push({ mode, width, scale, cacheType, frames: samples });
        }
    contextHeld = true;
    contextGate = new Promise((resolve) => {
      contextRelease = resolve;
    });
    const contextArrival = new Promise((resolve) => {
      contextArrived = resolve;
    });
    shadow = { ...structuredClone(preferences), mode: 'dark', preset: 'ocean' };
    phase = 'success';
    await configure({ cache: null });
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await awaitArrival(contextArrival);
    await page.locator('.desktop-loading').waitFor();
    await loaded('dark', 'ocean');
    await dom.scaleText(page, 2);
    await dom.settle(page);
    checkFrames(await frames(), 'dark', 'ocean');
    await capture('delayed-app-context-dark-text2', { scrollTop: false });
    contextHeld = false;
    contextRelease();
    await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
    report.appContextWait = { themedFallbackVisible: true, correctFrames: true };
    for (const kind of ['failure', 'invalid', 'timeout', 'blocked']) {
      phase = kind === 'blocked' ? 'failure' : kind;
      anonymous = false;
      hold();
      shadow = { ...structuredClone(preferences), mode: 'dark', preset: 'ocean' };
      const fallbackPreset = kind === 'blocked' ? 'frost' : 'blush';
      const cached = { ...structuredClone(preferences), mode: 'light', preset: fallbackPreset };
      await page.setViewportSize({ width: kind === 'failure' ? 1440 : 320, height: 900 });
      await configure({ cache: kind === 'blocked' ? null : JSON.stringify(cached), blocked: kind === 'blocked' });
      await page.goto(`${base}/settings?tab=appearance`, { waitUntil: 'domcontentloaded' });
      if (kind === 'timeout') await awaitArrival(arrival);
      const notice = page.getByText('Appearance could not be loaded. Using this browser’s settings.', { exact: true });
      await notice.waitFor({ timeout: 15000 });
      if (kind === 'timeout') release();
      await loaded('light', fallbackPreset);
      const input = page.locator('#desktop-server-name');
      await input.fill('Unsaved draft');
      const original = await input.elementHandle();
      await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
      await loaded('dark', fallbackPreset);
      await dom.scaleText(page, kind === 'failure' ? 1 : 2);
      await dom.settle(page);
      await capture(`${kind}-fallback-with-retry`, { scrollTop: false });
      const count = report.writes.length;
      phase = 'retry';
      hold();
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await awaitArrival(arrival);
      assert.equal(await page.locator('.orbis-startup').count(), 0, 'Retry must preserve mounted forms');
      assert.equal(await input.evaluate((node, original) => node === original, original), true);
      assert.equal(await input.inputValue(), 'Unsaved draft');
      assert.equal(
        await page.locator('.desktop-search-trigger').evaluate((node) => node === document.activeElement),
        true,
        'Retry must restore focus before removing its notification',
      );
      release();
      await page.getByText('Synced to your account', { exact: true }).waitFor();
      assert.equal(report.writes.length, count + 1, 'Recovery must save the pending local edit once');
      assert.equal(shadow.mode, 'dark');
      assert.equal(shadow.preset, fallbackPreset, 'Retry must not overwrite dirty local appearance with stale server values');
      assert.equal(await input.evaluate((node, original) => node === original, original), true);
      assert.equal(await input.inputValue(), 'Unsaved draft');
      await original.dispose();
      report.recovery.push({ kind, retainedDraft: true, retainedNode: true, pendingEditSavedOnce: true, focusRestored: true });
    }
    contextHeld = true;
    contextGate = new Promise((resolve) => {
      contextRelease = resolve;
    });
    const missingContextArrival = new Promise((resolve) => {
      contextArrived = resolve;
    });
    phase = 'failure';
    await configure({ cache: JSON.stringify({ ...preferences, mode: 'dark' }) });
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await awaitArrival(missingContextArrival);
    await page.locator('.desktop-loading').waitFor();
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await retry.waitFor();
    await dom.scaleText(page, 2);
    await retry.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await retry.evaluate((node) => node === document.activeElement && node.matches(':focus-visible')), true);
    await capture('failed-preferences-held-context-retry', { scrollTop: false });
    phase = 'retry';
    hold();
    const beforeRetryWrites = report.writes.length;
    shadow = { ...structuredClone(preferences), mode: 'light', preset: 'ocean' };
    await page.keyboard.press('Enter');
    await awaitArrival(arrival);
    assert.equal(
      await page.locator('#root').evaluate((node) => node === document.activeElement),
      true,
      'A loading workspace needs a surviving focus target',
    );
    release();
    await loaded('light', 'ocean');
    await capture('held-context-retry-focus-restored', { scrollTop: false });
    contextHeld = false;
    contextRelease();
    await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
    assert.equal(
      await page.locator('#root').evaluate((node) => node === document.activeElement),
      true,
      'Loading completion must preserve the fallback focus target',
    );
    assert.equal(report.writes.length, beforeRetryWrites, 'Clean retry must adopt saved server preferences without a PUT');
    report.loadingFocusRecovery = { rootFocusSurvivesContextResolution: true, cleanRetryAdoptedServerState: true, redundantWrites: 0 };
    phase = 'held';
    hold();
    shadow = { ...structuredClone(preferences), mode: 'system', preset: 'forest' };
    await configure({ cache: null });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await awaitArrival(arrival);
    release();
    await loaded('dark', 'forest');
    await dom.settle(page);
    checkFrames(await frames(), 'dark', 'forest');
    await capture('server-system-dark-loaded', { scrollTop: false });
    await page.emulateMedia({ colorScheme: 'light' });
    await loaded('light', 'forest');
    report.serverSystemMode = { firstPaintCorrect: true, respondsToOsChanges: true };
    for (const colourScheme of ['light', 'dark']) {
      phase = 'success';
      anonymous = true;
      await configure({ cache: JSON.stringify({ ...preferences, mode: 'system', preset: 'forest' }) });
      await page.emulateMedia({ colorScheme: colourScheme });
      const count = preferenceReads;
      await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
      await loaded(colourScheme, 'forest');
      await page.locator('.desktop-auth input').first().waitFor();
      await dom.settle(page);
      checkFrames(await frames(), colourScheme, 'forest');
      assert.equal(preferenceReads, count, 'Anonymous startup must not request protected preferences');
      await capture(`anonymous-system-${colourScheme}`, { scrollTop: false });
      report.anonymous.push({ colourScheme, protectedPreferenceReads: 0 });
      await page.emulateMedia({ colorScheme: colourScheme === 'dark' ? 'light' : 'dark' });
      await loaded(colourScheme === 'dark' ? 'light' : 'dark', 'forest');
    }
    phase = 'static';
    anonymous = false;
    await page.emulateMedia({ colorScheme: 'dark' });
    await configure({ cache: null });
    const count = preferenceReads;
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.locator('.orbis-startup output').waitFor();
    await dom.scaleText(page, 2);
    await dom.settle(page);
    assert.equal(preferenceReads, count, 'The generated SPA loading surface must work before application scripts');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await capture('static-html-dark-text2', { scrollTop: false });
    report.staticHtml = { loadingSurfacePresentWithoutAppScripts: true, preferenceReads: 0 };
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.failure = { name: error.name, message: error.message, frames: await frames() };
    await capture('failure-diagnostic', { scrollTop: false });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    throw error;
  } finally {
    release?.();
    contextRelease?.();
    anonymous = false;
    phase = 'success';
    await configure({ cache: storage });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.unroute('**/*', handler);
    page.off('pageerror', onError);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: 'light' });
    report.cleanup = { routesRestored: true, errorListenerRemoved: true, viewportRestored: true, storageReenabled: true };
  }
  return report;
};
