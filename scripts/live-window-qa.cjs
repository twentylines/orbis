const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');

const installRoot = '/Users/sai/.codex/tmp/orbis-stock-20261015';
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const expectedTag = process.env.ORBIS_AUDIT_EXPECTED_TAG;
const expectedCommit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
const clipFramePreview = process.env.ORBIS_AUDIT_CLIP_FRAME_PREVIEW === '1';
const baseUrl = (() => {
  try {
    return new URL(process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080');
  } catch {
    throw new Error('The audit URL must be a valid owned loopback origin.');
  }
})();
const base = baseUrl.origin;
const screenshotDir = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || `/tmp/orbis-window-live-${expectedTag}`;
const reportFile = process.env.ORBIS_AUDIT_REPORT_FILE || `/tmp/orbis-window-live-${expectedTag}.json`;
const originalFile = process.env.ORBIS_AUDIT_BASELINE_FILE || `/tmp/orbis-window-live-${expectedTag}-original-${Date.now()}.json`;
const same = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) =>
  crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  );
const privateInput = (file, cookie = false) => {
  assert.ok(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file, 'Input must be a canonical absolute path');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Input must be an owned regular file');
  const real = fs.realpathSync(file);
  if (cookie) {
    assert.equal(file, `${installRoot}/test-cookies.txt`, 'Only the owned isolated account cookie file is permitted');
    assert.equal(real, file, 'Cookie input must not redirect');
    assert.equal(stat.mode & 0o077, 0, 'Cookie input must remain private');
  } else assert.ok(file.startsWith('/tmp/') && real.startsWith(`${fs.realpathSync('/tmp')}/`), 'Release checker must remain under /tmp');
  return fs.readFileSync(file, 'utf8');
};
const outputGuard = (file) => {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file && file.startsWith('/tmp/'), 'Audit evidence must remain under /tmp');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink() && stat.uid === process.getuid(), 'Evidence path must be owned and not a symlink');
  }
  let parent = file;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = fs.realpathSync(parent);
  assert.ok(real === fs.realpathSync('/tmp') || real.startsWith(`${fs.realpathSync('/tmp')}/`), 'Evidence path escapes /tmp');
};
const identity = (url) => {
  const value = new URL(url);
  value.searchParams.delete('orbisWindow');
  return { pathname: value.pathname, query: [...value.searchParams], hash: value.hash };
};

(async () => {
  assert.equal(process.env.ORBIS_ALLOW_PREFERENCE_AUDIT, '1', 'Explicit preference audit opt-in is required');
  assert.match(expectedTag || '', /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/, 'An explicit release tag is required');
  assert.match(expectedCommit || '', /^[a-f0-9]{40}$/);
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(baseUrl.hostname) &&
      baseUrl.protocol === 'http:' &&
      baseUrl.port === '18080' &&
      baseUrl.pathname === '/' &&
      !baseUrl.username &&
      !baseUrl.password &&
      !baseUrl.search &&
      !baseUrl.hash,
    'Only owned HTTP loopback18080 is allowed',
  );
  assert.equal(fs.realpathSync(installRoot), installRoot);
  const release = JSON.parse(privateInput(releaseFile));
  assert.ok(release.tag === expectedTag && release.commit === expectedCommit, 'Release checker differs from explicit tag/commit guards');
  assert.match(release.image || '', /^ghcr\.io\/twentylines\/orbis@sha256:[a-f0-9]{64}$/);
  const cookies = privateInput(cookieFile, true)
    .split('\n')
    .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map((line) => {
      const fields = line.split('\t');
      assert.equal(fields.length, 7, 'Invalid private cookie format');
      const [rawDomain, , cookiePath, secure, expires, name, value] = fields;
      const domain = rawDomain.replace(/^#HttpOnly_/, '');
      assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(domain), 'Cookie domain is outside loopback');
      return {
        domain,
        path: cookiePath,
        secure: secure === 'TRUE',
        expires: Number(expires) || -1,
        name,
        value,
        httpOnly: rawDomain.startsWith('#HttpOnly_'),
      };
    });
  assert.ok(
    cookies.some((cookie) => cookie.name === 'runtipi-sid' && cookie.domain === baseUrl.hostname),
    'A matching private isolated session is required',
  );
  for (const file of [screenshotDir, reportFile, originalFile]) outputGuard(file);
  assert.ok(!fs.existsSync(originalFile), 'Original-preference backup must be new');
  fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
  const report = {
    passed: false,
    source: `Published ${release.tag} HTML/assets and actual isolated APIs; only desktop-preference writes are permitted.${clipFramePreview ? ' Browser-local overflow:clip preview; this is not unmodified release acceptance.' : ''}`,
    release: { tag: release.tag, commit: release.commit, image: release.image },
    browserLocalClipFramePreview: clipFramePreview,
    screenshots: screenshotDir,
    originalPreferenceBackup: originalFile,
    boundaryCases: [],
    mobileThemes: [],
    blockedMutations: [],
    pageErrors: [],
    preferenceWrites: 0,
    restorationWrites: 0,
    failedPreferenceRequests: 0,
    captureHeaders: [],
    preferenceRequests: [],
    preferenceBodyHashFormat: 'sha256 of canonical JSON; no preference values are recorded',
    actionTrace: [],
    originalPreferencesRestored: false,
    protectedApiStatePreserved: false,
    cleanupConfirmed: false,
    cleanupFailures: [],
  };
  let browser;
  let reader;
  let context;
  let page;
  let original;
  let protectedBefore;
  let stage = 'preflight';
  let writes = 0;
  const pendingWrites = new Set();
  const preferenceRequests = new Map();
  const startedAt = performance.now();
  const timestamp = () => Math.round((performance.now() - startedAt) * 100) / 100;
  const markStage = (next) => {
    stage = next;
    report.actionTrace.push({ stage, atMs: timestamp() });
  };
  const requestDiagnostic = (body, source = 'browser') => {
    const record = {
      id: report.preferenceRequests.length + 1,
      source,
      startedStage: stage,
      startedMs: timestamp(),
      bodyHash: hash(canonical(body)),
      outcome: 'in-flight',
      responseStatus: null,
    };
    report.preferenceRequests.push(record);
    return record;
  };
  const errors = report.pageErrors;
  const save = () => {
    outputGuard(reportFile);
    fs.writeFileSync(reportFile, `${JSON.stringify({ ...report, stage }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(reportFile, 0o600);
  };
  const read = async (endpoint) => {
    assert.ok(endpoint.startsWith('/api/'), 'Only selected authenticated API reads are permitted');
    const response = await reader.request.get(`${base}${endpoint}`, { maxRedirects: 0, timeout: 20000 });
    assert.ok(response.ok(), 'Authenticated read failed');
    return response.json();
  };
  const waitFor = async (condition, message) => {
    for (let i = 0; i < 80; i++) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(message);
  };
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const settleCapture = async () => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
      let previous = '';
      let stable = 0;
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const frame = document.querySelector('.desktop-route-window');
        const heading = document.querySelector('.desktop-window-bar') || document.querySelector('.workspace-heading');
        const rect = heading?.getBoundingClientRect();
        const current = JSON.stringify([scrollX, scrollY, frame?.scrollTop, rect?.x, rect?.y, rect?.width, rect?.height]);
        stable = previous === current ? stable + 1 : 0;
        previous = current;
        if (stable >= 3) return;
      }
      throw new Error('Capture geometry did not settle');
    });
    const metrics = await page.evaluate(() => {
      const frame = document.querySelector('.desktop-route-window[data-window-navigation="desktop"]');
      if (!frame || frame.dataset.windowScrollsFrame === 'true') return null;
      const bounds = frame.getBoundingClientRect();
      const bar = frame.querySelector('.desktop-window-bar').getBoundingClientRect();
      const icon = frame.querySelector('.desktop-window-icon').getBoundingClientRect();
      const label = frame.querySelector('.desktop-window-label').getBoundingClientRect();
      return { frameTop: bounds.top, barTop: bar.top, scrollTop: frame.scrollTop, topPadding: Math.min(icon.top, label.top) - bar.top };
    });
    if (metrics) {
      report.captureHeaders.push({ stage, ...metrics });
      assert.ok(
        Math.abs(metrics.barTop - metrics.frameTop - 1) <= 1 && metrics.scrollTop === 0,
        'The settled desktop header must not scroll under its frame',
      );
      assert.ok(metrics.topPadding >= 16, 'The settled desktop heading must retain its interior padding');
    }
  };
  const screenshot = async (name) => {
    await settleCapture();
    await page.screenshot({ path: path.join(screenshotDir, `${name}.png`) });
  };
  const protectedState = async () => {
    const installed = await read('/api/apps/installed');
    installed.installed.sort((a, b) => a.info.urn.localeCompare(b.info.urn));
    const apps = {};
    for (const item of installed.installed) apps[item.info.urn] = await read(`/api/apps/${encodeURIComponent(item.info.urn)}`);
    const stores = (await read('/api/marketplace/all')).appStores.sort((a, b) => a.slug.localeCompare(b.slug));
    const tasks = await read('/api/tasks').then(({ sampledAt: _sampledAt, ...stable }) => stable);
    return { installed, apps, stores, tasks, links: await read('/api/links') };
  };
  const allowPreferenceBody = (body) => {
    const stable = { ...body, mode: original.mode, windows: original.windows };
    same(stable, original, 'An unexpected preference field or unsaved form value would be persisted');
    assert.ok(
      ['light', 'dark'].includes(body.mode) && body.windows && typeof body.windows === 'object' && !Array.isArray(body.windows),
      'Invalid preference payload',
    );
    for (const key of new Set([...Object.keys(original.windows || {}), ...Object.keys(body.windows)]))
      if (!['settings', 'monitor'].includes(key)) same(body.windows[key], original.windows?.[key], 'Another tool placement would be changed');
  };
  const restoreOriginalPreferences = async () => {
    const record = requestDiagnostic(original, 'restoration API');
    try {
      const response = await reader.request.put(`${base}/api/desktop-preferences`, {
        maxRedirects: 0,
        timeout: 20000,
        headers: { Origin: base },
        data: original,
      });
      Object.assign(record, { outcome: 'finished', responseStatus: response.status(), finishedMs: timestamp(), finishedStage: stage });
      assert.ok(response.ok(), 'Original preference restoration failed');
    } catch (error) {
      if (record.outcome === 'in-flight')
        Object.assign(record, {
          outcome: 'failed',
          failedStage: stage,
          failedMs: timestamp(),
          failureCode: 'restoration-api-error-redacted',
          failureHash: hash(String(error.message)),
        });
      throw error;
    }
  };
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    const build = await read('/api/system/build');
    assert.ok(
      build.version === release.tag && build.commit === release.commit && build.imageDigest === release.image.split('@')[1],
      'Actual published build differs from the checker',
    );
    original = await read('/api/desktop-preferences');
    fs.writeFileSync(originalFile, `${JSON.stringify(original)}\n`, { mode: 0o600, flag: 'wx' });
    protectedBefore = await protectedState();
    report.protectedApiHashBefore = hash(protectedBefore);
    const serverIp = (await read('/api/app-context')).userSettings.internalIp;
    assert.ok(serverIp, 'Configured server IP is required');
    context = await browser.newContext({ viewport: { width: 1440, height: 1120 }, serviceWorkers: 'block' });
    await context.addCookies(cookies);
    if (clipFramePreview)
      await context.addInitScript(() => {
        document.addEventListener(
          'DOMContentLoaded',
          () => {
            const style = document.createElement('style');
            style.textContent =
              '.desktop-route-window[data-window-navigation="desktop"]:not([data-window-scrolls-frame="true"]){overflow:clip!important}';
            document.head.append(style);
          },
          { once: true },
        );
      });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) return route.abort('blockedbyclient');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        try {
          assert.ok(request.method() === 'PUT' && url.pathname === '/api/desktop-preferences' && !url.search, 'Only preference PUT is allowed');
          const body = JSON.parse(request.postData() || '{}');
          allowPreferenceBody(body);
          preferenceRequests.set(request, requestDiagnostic(body));
          pendingWrites.add(request);
          writes++;
          report.preferenceWrites++;
        } catch {
          report.blockedMutations.push({ method: request.method(), path: url.pathname });
          return route.abort('blockedbyclient');
        }
      }
      return route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(hash(error.message)));
    page.on('response', (response) => {
      const record = preferenceRequests.get(response.request());
      if (record) Object.assign(record, { responseStatus: response.status(), responseMs: timestamp(), responseStage: stage });
    });
    page.on('requestfinished', (request) => {
      pendingWrites.delete(request);
      const record = preferenceRequests.get(request);
      if (record) Object.assign(record, { outcome: 'finished', finishedMs: timestamp(), finishedStage: stage });
    });
    page.on('requestfailed', (request) => {
      if (pendingWrites.delete(request)) {
        report.failedPreferenceRequests++;
        const error = request.failure()?.errorText || 'Unknown request failure';
        const record = preferenceRequests.get(request);
        if (record)
          Object.assign(record, {
            outcome: 'failed',
            failedStage: stage,
            failedMs: timestamp(),
            failureCode: /^net::ERR_[A-Z0-9_]+$/.test(error) ? error : 'network-error-redacted',
            failureHash: hash(error),
          });
      }
    });
    markStage('desktop-windows');
    const frame = () => page.locator('.desktop-route-window');
    const layout = async (name, mode) => {
      markStage(`desktop-layout-${mode}`);
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
    markStage('desktop-minimize-settings');
    await page.getByRole('button', { name: 'Minimize Settings', exact: true }).click();
    await frame().waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: original.serverName, exact: true }).waitFor();
    markStage('desktop-restore-settings');
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
    markStage('desktop-drag-settings');
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
    markStage('desktop-maximize-settings');
    await page.getByRole('button', { name: 'Maximize Settings', exact: true }).click();
    markStage('desktop-restore-settings-size');
    await page.getByRole('button', { name: 'Restore Settings size', exact: true }).click();
    assert.ok(isDeepStrictEqual(await frame().boundingBox(), moved), 'Maximize restore lost floating bounds');
    await layout('Snap left', 'left');
    const left = await frame().boundingBox();
    await layout('Snap right', 'right');
    const right = await frame().boundingBox();
    assert.equal(left.width, right.width);
    assert.equal(right.x - left.x - left.width, 16);
    await layout('Floating window', 'floating');
    await page.getByText('Synced to your account', { exact: true }).waitFor();
    await waitFor(async () => pendingWrites.size === 0, 'Preference requests must settle before the deliberate reload');
    const acknowledged = report.preferenceRequests.filter((record) => record.source === 'browser').at(-1);
    assert.ok(
      acknowledged?.outcome === 'finished' && acknowledged.responseStatus >= 200 && acknowledged.responseStatus < 300,
      'The latest preference request must be acknowledged before reload',
    );
    const acknowledgedHash = hash(canonical(await read('/api/desktop-preferences')));
    assert.equal(acknowledgedHash, acknowledged.bodyHash, 'The exact latest preference payload must persist before reload');
    report.reloadAcknowledgement = {
      requestId: acknowledged.id,
      bodyHash: acknowledged.bodyHash,
      serverBodyHash: acknowledgedHash,
      responseStatus: acknowledged.responseStatus,
      observedMs: timestamp(),
    };
    markStage('desktop-account-placement-reload');
    await page.evaluate(() => localStorage.removeItem('server-desktop-preferences-v1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await input.waitFor();
    await waitFor(async () => (await frame().getAttribute('data-window-mode')) === 'floating', 'Account-backed window placement did not load');
    assert.equal(await input.inputValue(), original.serverName, 'Reload should discard an unsaved form draft');
    assert.equal(await frame().getAttribute('data-window-mode'), 'floating');
    assert.ok(isDeepStrictEqual(await frame().boundingBox(), moved), 'Account-backed bounds did not survive reload');
    await screenshot('floating-settings');
    markStage('desktop-monitor-navigation');
    await page.getByRole('link', { name: 'Monitor', exact: true }).click();
    await page.getByRole('heading', { name: 'Monitor', exact: true }).waitFor();
    markStage('desktop-maximize-monitor');
    await page.getByRole('button', { name: 'Maximize Monitor', exact: true }).click();
    await waitFor(async () => (await read('/api/desktop-preferences')).windows?.monitor?.mode === 'maximized', 'Monitor placement did not save');
    const prefs = await read('/api/desktop-preferences');
    assert.equal(prefs.windows.settings.mode, 'floating');
    await screenshot('monitor');
    markStage('responsive-draft-and-placement');
    const responsivePath = '/settings?tab=appearance&probe=space%20value&probe=second#draft';
    await page.goto(`${base}${responsivePath}`, { waitUntil: 'domcontentloaded' });
    await input.waitFor();
    await waitFor(async () => (await frame().getAttribute('data-window-mode')) === 'floating', 'Saved desktop placement did not load');
    await page.waitForTimeout(700);
    await page.getByText('Synced to your account', { exact: true }).waitFor();
    await waitFor(async () => pendingWrites.size === 0, 'Initial preference synchronization did not settle');
    const savedWindows = clone((await read('/api/desktop-preferences')).windows);
    const draft = 'Unsaved responsive window audit draft';
    await input.fill(draft);
    const inputIdentity = await input.elementHandle();
    const routeIdentity = identity(page.url());
    const assertPreserved = async (label) => {
      assert.ok(await inputIdentity.evaluate((element) => element.isConnected), `${label}: form DOM was remounted`);
      assert.equal(await input.inputValue(), draft, `${label}: draft was discarded`);
      same(identity(page.url()), routeIdentity, `${label}: route/query/hash changed`);
      const current = await read('/api/desktop-preferences');
      same(current.windows, savedWindows, `${label}: saved placements changed during resize`);
      assert.equal(current.serverName, original.serverName, 'Unsaved server name reached the account');
    };
    const assertPage = async (label) => {
      await page.locator('.desktop-route-window[data-window-navigation="page"][data-window-mode="page"]').waitFor();
      await settle();
      assert.equal(
        await page.locator('.desktop-window-controls,.desktop-window-resize,.desktop-window-resume').count(),
        0,
        `${label}: small page exposed window controls`,
      );
      assert.equal(await frame().getByRole('toolbar').count(), 0, `${label}: small heading exposed toolbar semantics`);
      const measurements = await frame().evaluate((element) => {
        const heading = element.querySelector('.desktop-page-heading h1');
        const content = element.querySelector('.desktop-window-content');
        const style = getComputedStyle(heading);
        const probe = document.createElement('span');
        probe.style.color = 'var(--desktop-ink)';
        element.append(probe);
        const expectedInk = getComputedStyle(probe).color;
        probe.remove();
        const text = document.createRange();
        text.selectNodeContents(heading);
        const ink = text.getBoundingClientRect();
        const bounds = heading.getBoundingClientRect();
        return {
          position: getComputedStyle(element).position,
          contentOverflow: getComputedStyle(content).overflowY,
          desktopOverflow: getComputedStyle(element.closest('.desktop')).overflowY,
          inlineGeometry: element.getAttribute('style'),
          hidden: element.hidden,
          inert: element.inert,
          headingText: heading.textContent.trim(),
          fontSize: Number.parseFloat(style.fontSize),
          lineHeight: Number.parseFloat(style.lineHeight),
          headingInk: style.color,
          expectedInk,
          headingFits: ink.left >= bounds.left - 1 && ink.right <= bounds.right + 1,
          outerOverflow: document.documentElement.scrollWidth > innerWidth,
          mode: element.closest('.desktop').dataset.desktopMode,
        };
      });
      assert.ok(
        measurements.position === 'relative' && measurements.contentOverflow === 'visible' && measurements.desktopOverflow === 'visible',
        `${label}: page must scroll with the document`,
      );
      assert.ok(!measurements.hidden && !measurements.inert && !measurements.outerOverflow, `${label}: page is hidden, inert or overflows`);
      assert.ok(
        !/(?:^|;)\s*(?:left|right|top|width|height):/.test(measurements.inlineGeometry || ''),
        `${label}: fixed window geometry leaked into a page`,
      );
      assert.ok(
        measurements.headingText === 'Settings' &&
          measurements.fontSize >= 18 &&
          measurements.fontSize <= 24 &&
          measurements.lineHeight >= measurements.fontSize * 1.25 &&
          measurements.headingFits &&
          measurements.headingInk === measurements.expectedInk,
        `${label}: compact page heading must be complete and themed`,
      );
      report.boundaryCases.push({ label, viewport: page.viewportSize(), ...measurements });
    };
    const resizeWrites = report.preferenceWrites;
    for (const [label, viewport, desktopMode] of [
      ['below-width-threshold', { width: 1099, height: 640 }, false],
      ['below-height-threshold', { width: 1100, height: 639 }, false],
      ['desktop-boundary', { width: 1100, height: 640 }, true],
      ['desktop-restored', { width: 1440, height: 1120 }, true],
      ['mobile-page', { width: 390, height: 844 }, false],
    ]) {
      markStage(`responsive-${label}`);
      await page.setViewportSize(viewport);
      if (desktopMode) await page.locator('.desktop-route-window[data-window-navigation="desktop"][data-window-mode="floating"]').waitFor();
      else await assertPage(label);
      await assertPreserved(label);
      if (label === 'desktop-restored') same(await frame().boundingBox(), moved, 'Original floating geometry did not return after resizing');
    }
    await page.waitForTimeout(700);
    assert.equal(report.preferenceWrites, resizeWrites, 'Resizing must not write a new placement or form draft');
    markStage('responsive-desktop-minimize');
    await page.setViewportSize({ width: 1440, height: 1120 });
    await page.getByRole('button', { name: 'Minimize Settings', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Minimize Settings', exact: true }).click();
    await frame().waitFor({ state: 'hidden' });
    const historyLength = await page.evaluate(() => history.length);
    markStage('responsive-minimized-to-mobile');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForURL((url) => !url.searchParams.has('orbisWindow'));
    await assertPage('minimized-desktop-to-mobile');
    await assertPreserved('minimized-desktop-to-mobile');
    assert.equal(await page.evaluate(() => history.length), historyLength, 'Small minimized cleanup must replace the current history entry');
    markStage('mobile-page-navigation');
    await page.locator('.desktop-connection-dot.is-connected').waitFor();
    assert.equal((await page.locator('.desktop-connection').innerText()).trim(), serverIp);
    for (const mode of ['light', 'dark']) {
      markStage(`mobile-theme-${mode}`);
      if (!(await page.locator(`.desktop[data-desktop-mode="${mode}"]`).count())) {
        await page.getByRole('button', { name: `Switch to ${mode} mode`, exact: true }).click();
        await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
        await waitFor(async () => (await read('/api/desktop-preferences')).mode === mode, 'Theme did not persist');
      }
      await settle();
      await page.evaluate(() => {
        document.activeElement?.blur();
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
      await assertPage(`mobile-${mode}`);
      await assertPreserved(`mobile-${mode}`);
      await screenshot(`mobile-${mode}-settings-page`);
      const lastControl = page.getByRole('button', { name: 'Restore all defaults', exact: true });
      await lastControl.focus();
      await settle();
      const scrolling = await lastControl.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const bar = document.querySelector('.desktop-system-bar').getBoundingClientRect();
        const dock = document.querySelector('.desktop-dock').getBoundingClientRect();
        return {
          scrollY,
          documentHeight: document.scrollingElement.scrollHeight,
          viewportHeight: innerHeight,
          top: bounds.top,
          bottom: bounds.bottom,
          barBottom: bar.bottom,
          dockTop: dock.top,
        };
      });
      assert.ok(
        scrolling.scrollY > 0 &&
          scrolling.documentHeight > scrolling.viewportHeight &&
          scrolling.top >= scrolling.barBottom + 4 &&
          scrolling.bottom <= scrolling.dockTop - 4,
        'Last mobile control must be reachable through document scrolling without activating it',
      );
      report.mobileThemes.push({ mode, ...scrolling });
      await screenshot(`mobile-${mode}-settings-document-scroll`);
    }
    markStage('mobile-home-navigation');
    await page.locator('.desktop-dock').getByRole('link', { name: 'Workspace', exact: true }).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.getByRole('heading', { name: original.serverName, exact: true }).waitFor();
    await page
      .locator('.workspace-activity .workspace-section-heading p')
      .filter({ hasText: /^Uptime / })
      .waitFor();
    await page.getByText('Reading Docker containers…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await frame().count(), 0, 'Mobile Home must leave the Settings page');
    assert.equal(await inputIdentity.evaluate((element) => element.isConnected), false, 'Mobile Home must unmount the departed form');
    assert.equal(
      await page.locator('.desktop-window-resume,.desktop-dock-item.is-minimized').count(),
      0,
      'Mobile Home must not keep a minimized window',
    );
    await settleCapture();
    const homePosition = await page.getByRole('heading', { name: original.serverName, exact: true }).evaluate((heading) => ({
      top: heading.getBoundingClientRect().top,
      barBottom: document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
      scrollY,
    }));
    assert.ok(
      homePosition.scrollY === 0 && homePosition.top > homePosition.barBottom,
      'Ordinary Home navigation must restore the document top and reveal its heading',
    );
    report.mobileHomeStartsAtTop = homePosition;
    await screenshot('mobile-home-navigation');
    markStage('mobile-settings-return');
    await page.locator('.desktop-dock').getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await input.waitFor();
    assert.equal(await input.inputValue(), original.serverName, 'Returning through ordinary navigation must start a new form draft');
    await assertPage('mobile-returned-settings');
    const brandInput = await input.elementHandle();
    await input.fill('Unsaved brand navigation draft');
    markStage('mobile-brand-home-navigation');
    await page.locator('.desktop-brand').click();
    await page.waitForURL(`${base}/dashboard`);
    await page.getByRole('heading', { name: original.serverName, exact: true }).waitFor();
    assert.equal(await frame().count(), 0, 'Mobile brand must navigate to Home');
    assert.equal(await brandInput.evaluate((element) => element.isConnected), false, 'Mobile brand must unmount the departed form');
    assert.equal(await page.locator('.desktop-window-resume,.desktop-dock-item.is-minimized').count(), 0);
    await inputIdentity.dispose();
    await brandInput.dispose();
    same((await read('/api/desktop-preferences')).windows, savedWindows, 'Page navigation overwrote desktop placements');
    assert.equal((await read('/api/desktop-preferences')).serverName, original.serverName, 'A mobile draft was saved');
    same(await protectedState(), protectedBefore, 'An app, store, task or link changed during the preference-only audit');
    assert.deepEqual(report.blockedMutations, [], 'Unexpected product mutation was attempted');
    assert.deepEqual(errors, [], 'Published UI raised a browser error');
    Object.assign(report, {
      draftPreserved: true,
      dragWrites: 1,
      snapGap: 16,
      accountBoundsPersisted: true,
      perToolPlacement: true,
      mobileDocumentPages: true,
      responsiveDraftAndPlacementPreserved: true,
      minimizedFlagNormalizedOnSmall: true,
      mobileHomeAndBrandNavigate: true,
      mobileNavigationUnmountsDraft: true,
      serverIpVisible: true,
    });
    report.passed = true;
  } catch (error) {
    report.failure = { stage, type: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error', messageHash: hash(String(error.message)) };
  } finally {
    markStage('cleanup');
    let writesSettled = true;
    if (context) {
      try {
        if (page && !page.isClosed()) {
          await page.waitForTimeout(750);
          await waitFor(async () => pendingWrites.size === 0, 'Preference writes did not settle');
        }
      } catch {
        writesSettled = false;
        report.cleanupFailures.push('preference-writes-still-in-flight');
      }
      try {
        await context.close();
      } catch {
        writesSettled = false;
        report.cleanupFailures.push('ui-context-close-failed');
      }
    }
    if (report.failedPreferenceRequests) {
      writesSettled = false;
      report.cleanupFailures.push('preference-request-outcome-unconfirmed');
    }
    if (original && reader) {
      try {
        const current = await read('/api/desktop-preferences');
        allowPreferenceBody(current);
        if (report.preferenceWrites) {
          report.restorationWrites++;
          await restoreOriginalPreferences();
        }
        same(await read('/api/desktop-preferences'), original, 'Original preferences were not restored');
        await new Promise((resolve) => setTimeout(resolve, 750));
        same(await read('/api/desktop-preferences'), original, 'A delayed write replaced restored preferences');
        report.originalPreferencesRestored = true;
      } catch {
        report.cleanupFailures.push('original-preferences-restoration-unconfirmed');
      }
      if (protectedBefore) {
        try {
          const after = await protectedState();
          same(after, protectedBefore, 'Protected API state changed');
          report.protectedApiHashAfter = hash(after);
          report.protectedApiStatePreserved = true;
        } catch {
          report.cleanupFailures.push('protected-api-state-changed-or-unconfirmed');
        }
      }
      report.cleanupConfirmed =
        writesSettled && report.originalPreferencesRestored && report.protectedApiStatePreserved && !report.cleanupFailures.length;
    }
    await reader?.close().catch(() => report.cleanupFailures.push('reader-close-failed'));
    await browser?.close().catch(() => report.cleanupFailures.push('browser-close-failed'));
    if (!report.cleanupConfirmed || report.cleanupFailures.length || report.blockedMutations.length || report.pageErrors.length)
      report.passed = false;
    save();
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
})().catch(() => {
  process.stderr.write('Published window audit could not complete; private session and API details were omitted.\n');
  process.exitCode = 1;
});
