const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');
const inspectSettingsAlignment = require('./settings-alignment-checks.cjs');

const installRoot = process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install';
const ownedCookieFile = `${installRoot}/test-cookies.txt`;
const dockerContext = 'colima-runtipi-test';
const expectedTag = process.env.ORBIS_AUDIT_EXPECTED_TAG;
const preferenceKey = 'server-desktop-preferences-v1';
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const samePrivate = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);

function parsePrivate(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function readOwnedInput(file) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file, 'Audit input must be an absolute normalized path');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Audit input must be an owned regular file');
  const real = fs.realpathSync(file);
  if (file === ownedCookieFile) {
    assert.equal(real, file, 'Owned cookie path must not redirect');
    assert.equal(stat.mode & 0o077, 0, 'Owned cookies must remain private');
  } else {
    assert.ok(file.startsWith('/tmp/') && real.startsWith(`${fs.realpathSync('/tmp')}/`), 'Release manifest must remain under /tmp');
  }
  return fs.readFileSync(file, 'utf8');
}

function temporaryOutput(file) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file && file.startsWith('/tmp/'), 'Audit output must remain under /tmp');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink() && stat.uid === process.getuid(), 'Audit output must be owned and must not be a symlink');
  }
  let parent = file;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = fs.realpathSync(parent);
  const temporaryRoot = fs.realpathSync('/tmp');
  assert.ok(real === temporaryRoot || real.startsWith(`${temporaryRoot}/`), 'Audit output must not redirect outside /tmp');
}

function privateDirectory(directory) {
  temporaryOutput(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.ok(fs.lstatSync(directory).isDirectory(), 'Audit output directory is not a directory');
  fs.chmodSync(directory, 0o700);
}

function privateWrite(file, value) {
  temporaryOutput(file);
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readDocker(args) {
  const result = spawnSync('docker', ['--context', dockerContext, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.ok(!result.error && result.status === 0, 'Owned Docker inspection failed');
  return result.stdout;
}

function verifyCore(image) {
  const ids = readDocker(['ps', '-q', '--filter', 'label=com.docker.compose.service=runtipi']).trim().split('\n').filter(Boolean);
  assert.equal(ids.length, 1, 'Exactly one running core is required in the owned Docker context');
  const format =
    '{"image":{{json .Config.Image}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"mounts":{{json .Mounts}}}';
  const core = parsePrivate(readDocker(['inspect', '--format', format, ids[0]]), 'Owned core inspection');
  assert.equal(core.image, image, 'Owned core image differs from the expected published image');
  assert.ok(core.running && core.health === 'healthy', 'Owned core must be running and healthy');
  for (const [destination, relative] of Object.entries({
    '/data/.env': '.env',
    '/data/apps': 'apps',
    '/data/repos': 'repos',
    '/data/user-config': 'user-config',
    '/data/state': 'state',
    '/app-data': 'app-data',
  })) {
    const mounts = core.mounts.filter((mount) => mount.Destination === destination);
    assert.ok(
      mounts.length === 1 && mounts[0].Type === 'bind' && mounts[0].Source === path.join(installRoot, relative),
      'Core bind ownership does not match the owned rehearsal root',
    );
  }
}

function parseCookies(value, hostname) {
  const cookies = value
    .split('\n')
    .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map((line) => {
      const fields = line.split('\t');
      assert.equal(fields.length, 7, 'Cookie entry is malformed');
      const [rawDomain, , cookiePath, secure, expires, name, cookieValue] = fields;
      const domain = rawDomain.replace(/^#HttpOnly_/, '');
      assert.ok(['127.0.0.1', 'localhost'].includes(domain), 'Only loopback cookies are allowed');
      assert.ok(cookiePath.startsWith('/') && name && cookieValue, 'Cookie entry is incomplete');
      return {
        domain,
        path: cookiePath,
        secure: secure === 'TRUE',
        expires: Number(expires) || -1,
        name,
        value: cookieValue,
        httpOnly: rawDomain.startsWith('#HttpOnly_'),
      };
    });
  assert.ok(
    cookies.some((cookie) => cookie.name === 'runtipi-sid' && cookie.domain === hostname),
    'Matching owned session cookie is required',
  );
  return cookies;
}

async function scaleText(page, factor) {
  if (factor === 1) return;
  await page.evaluate((scale) => {
    const baseline = [...document.querySelectorAll('body,body *')]
      .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'META', 'LINK'].includes(element.tagName))
      .map((element) => ({
        element,
        font: Number.parseFloat(getComputedStyle(element).fontSize),
        line: Number.parseFloat(getComputedStyle(element).lineHeight),
      }));
    for (const { element, font, line } of baseline) {
      if (Number.isFinite(font)) element.style.setProperty('font-size', `${font * scale}px`, 'important');
      if (Number.isFinite(line)) element.style.setProperty('line-height', `${line * scale}px`, 'important');
    }
  }, factor);
}

async function settle(page) {
  await page.locator('.desktop-route-window').evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    let previous = '';
    let stable = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rect = document.activeElement.getBoundingClientRect();
      const current = [scrollX, scrollY, rect.x, rect.y, rect.width, rect.height].join(',');
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 3) return;
    }
    throw new Error('Focused geometry did not settle');
  });
}

async function pageGeometry(page) {
  return page.locator('.desktop-route-window').evaluate((frame) => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const content = frame.querySelector('.desktop-window-content');
    const active = document.activeElement;
    return {
      navigation: frame.dataset.windowNavigation,
      mode: frame.dataset.windowMode,
      frame: {
        ...box(frame),
        position: getComputedStyle(frame).position,
        inlineGeometry: ['left', 'right', 'top', 'width', 'height'].some((key) => Boolean(frame.style[key])),
      },
      content: {
        ...box(content),
        overflowY: getComputedStyle(content).overflowY,
        scrollTop: content.scrollTop,
        scrollHeight: content.scrollHeight,
        clientHeight: content.clientHeight,
      },
      bar: box(document.querySelector('.desktop-system-bar')),
      dock: box(document.querySelector('.desktop-dock')),
      controls: frame.querySelectorAll('.desktop-window-control,.desktop-window-resize,.desktop-window-resume').length,
      outerScroll: scrollY,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      active: { inside: frame.contains(active), tag: active.tagName, box: box(active) },
    };
  });
}

function checkPageGeometry(metrics, viewport) {
  assert.ok(metrics.documentWidth <= viewport.width + 1, 'The released page must not overflow horizontally');
  if (viewport.width >= 1100 && viewport.height >= 640) {
    assert.equal(metrics.navigation, 'desktop');
    assert.equal(metrics.mode, 'focused');
    assert.equal(metrics.frame.position, 'fixed');
    assert.ok(metrics.controls >= 4, 'Desktop Settings must retain its window controls');
    assert.ok(Math.abs(metrics.frame.top - metrics.bar.bottom - 20) <= 1, 'Focused desktop frame must clear the system bar');
    assert.ok(Math.abs(metrics.dock.top - metrics.frame.bottom - 20) <= 1, 'Focused desktop frame must clear the dock');
    assert.equal(metrics.outerScroll, 0, 'Focused desktop tools must not scroll the document');
    if (viewport.width === 3840) {
      assert.equal(metrics.frame.width, 1720, 'Ultra-wide Settings must retain its bounded width');
      assert.ok(Math.abs(metrics.frame.left - (viewport.width - metrics.frame.right)) <= 1, 'Ultra-wide Settings must be centered');
    }
  } else {
    assert.equal(metrics.navigation, 'page');
    assert.equal(metrics.mode, 'page');
    assert.equal(metrics.frame.position, 'relative');
    assert.equal(metrics.frame.inlineGeometry, false, 'Small pages must not inherit fixed window geometry');
    assert.equal(metrics.content.overflowY, 'visible');
    assert.equal(metrics.controls, 0, 'Small pages must not show window navigation controls');
  }
}

function checkFocus(metrics) {
  assert.equal(metrics.active.inside, true, 'Focused control must remain in the current Settings page');
  const top = metrics.navigation === 'page' ? metrics.bar.bottom + 7.25 : metrics.content.top - 1;
  const bottom = metrics.navigation === 'page' ? metrics.dock.top - 7.25 : metrics.content.bottom + 1;
  assert.ok(metrics.active.box.top >= top && metrics.active.box.bottom <= bottom, 'Focused control must remain clear of chrome and clipping');
}

async function inspectStoreAlignment(page) {
  return page.locator('.desktop-settings').evaluate((settings) => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const frame = settings.closest('.desktop-route-window');
    const header = settings.querySelector('[role="tablist"] .card-header');
    const nav = header.querySelector('.nav-tabs');
    const body = settings.querySelector('.card-body');
    const table = body.querySelector('.table-responsive');
    const tabs = [...nav.querySelectorAll('button')].filter((element) => element.offsetWidth && element.offsetHeight);
    return {
      settings: box(settings),
      headingIcon: box(frame.querySelector('.desktop-window-icon')),
      nav: box(nav),
      divider: { ...box(header), y: header.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(header).borderBottomWidth) / 2 },
      lastTabBottom: Math.max(...tabs.map((element) => element.getBoundingClientRect().bottom)),
      bodyHeading: box(body.querySelector('.d-flex')),
      table: { ...box(table), clientWidth: table.clientWidth, scrollWidth: table.scrollWidth, overflowX: getComputedStyle(table).overflowX },
      rowCount: table.querySelectorAll('tbody tr').length,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
}

async function main() {
  process.umask(0o077);
  const origin = new URL(process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080');
  const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
  const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
  const expectedCommit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
  const expectedDigest = process.env.ORBIS_AUDIT_EXPECTED_DIGEST;
  const output = process.env.ORBIS_AUDIT_OUTPUT_DIR || '/tmp/orbis-live-responsive';
  const reportFile = path.join(output, 'report.json');
  const baselineFile = path.join(output, 'baseline.json');
  const screenshotDir = path.join(output, 'screenshots');
  let browser;
  let reader;
  let before;
  let release;
  let outputReady = false;
  let failure;
  let stage = 'preflight';
  const privateBaseline = {};
  const report = {
    passed: false,
    source: {
      live: ['Published image, authenticated HTML and assets', 'Real account, host, installed apps, full app records and app-store reads'],
      controlled: [
        'Browser-local preference GET/PUT shadow based on real preferences: light/dark mode and default focused placement',
        'Computed text sizes doubled in the browser for text stress cases',
      ],
      realPreferenceWrites: 0,
      realAppOrHostWrites: 0,
    },
    release: null,
    settings: [],
    stores: [],
    shortFocus: [],
    assets: {},
    shadowPreferenceGets: 0,
    shadowPreferencePuts: 0,
    forwardedReads: {},
    blockedMutations: [],
    externalRequestsBlocked: 0,
    pageErrors: [],
    recordsUnchanged: false,
    cleanupFailures: [],
  };
  const verifyBuild = (build) => {
    assert.equal(build.version, release.tag, 'Published build tag mismatch');
    assert.equal(build.commit, release.commit, 'Published full commit mismatch');
    assert.equal(build.imageDigest, expectedDigest, 'Published image digest mismatch');
  };
  const read = async (endpoint) => {
    assert.ok(endpoint.startsWith('/api/') && !endpoint.includes('?') && !endpoint.includes('#'), 'Direct audit reads must use fixed API paths');
    const response = await reader.request.get(`${origin.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
    assert.ok(response.ok(), 'Authenticated live audit GET failed');
    return response.json();
  };
  const snapshotRecords = async () => {
    const installed = await read('/api/apps/installed');
    assert.ok(Array.isArray(installed.installed), 'Installed app response is malformed');
    const apps = {};
    for (const item of installed.installed) {
      const urn = item.info?.urn;
      assert.ok(typeof urn === 'string' && urn.includes(':') && !Object.hasOwn(apps, urn), 'Installed app identity is malformed or duplicated');
      apps[urn] = await read(`/api/apps/${encodeURIComponent(urn)}`);
      assert.equal(apps[urn].info?.urn, urn, 'Full app record identity mismatch');
    }
    return { preferences: await read('/api/desktop-preferences'), installed, apps, stores: await read('/api/marketplace/all') };
  };
  const withCase = async (kind, viewport, mode, textScale, inspect) => {
    verifyBuild(await read('/api/system/build'));
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    let shadowPreferences = { ...clone(before.preferences), mode, windows: {} };
    const assets = { documents: 0, scripts: 0, stylesheets: 0 };
    const assetJobs = [];
    const prefix = `${kind}-${viewport.width}x${viewport.height}-${mode}-text${textScale * 100}`;
    try {
      await context.addCookies(cookies);
      await context.addInitScript(
        ({ key, value, origin }) => {
          if (window === window.top && location.origin === origin) localStorage.setItem(key, JSON.stringify(value));
        },
        { key: preferenceKey, value: shadowPreferences, origin: origin.origin },
      );
      context.on('response', (response) => {
        const request = response.request();
        const target = new URL(request.url());
        const key = { document: 'documents', script: 'scripts', stylesheet: 'stylesheets' }[request.resourceType()];
        if (target.origin !== origin.origin || !key || !response.ok()) return;
        assets[key]++;
        assetJobs.push(
          response.body().then((body) => {
            const record = { resource: key, bytes: body.length, sha256: hash(body) };
            report.assets[`${target.pathname}:${record.sha256}`] = record;
          }),
        );
      });
      // This route is installed before creating the page. Only reads can reach the server.
      await context.route('**/*', async (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (target.origin !== origin.origin) {
          report.externalRequestsBlocked++;
          return route.abort('blockedbyclient');
        }
        const respond = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
        if (target.pathname === '/api/desktop-preferences') {
          if (request.method() === 'GET') {
            report.shadowPreferenceGets++;
            return respond(shadowPreferences);
          }
          if (request.method() === 'PUT') {
            const next = parsePrivate(request.postData() || '', 'Browser-local preferences');
            assert.equal(next.mode, mode, 'Controlled appearance must keep its requested mode');
            assert.equal(next.serverName, before.preferences.serverName, 'The audit must not rename the server');
            assert.equal(next.preset, before.preferences.preset, 'The audit must retain the real preset');
            shadowPreferences = next;
            report.shadowPreferencePuts++;
            return respond(shadowPreferences);
          }
        }
        if (!readMethods.has(request.method())) {
          report.blockedMutations.push({ case: prefix, method: request.method(), path: target.pathname });
          return route.abort('blockedbyclient');
        }
        if (target.pathname.startsWith('/api/')) report.forwardedReads[target.pathname] = (report.forwardedReads[target.pathname] || 0) + 1;
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => report.pageErrors.push({ case: prefix, type: error.name, messageHash: hash(error.message) }));
      const capture = async (suffix, clip) => {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const file = path.join(screenshotDir, `${prefix}-${suffix}.png`);
        temporaryOutput(file);
        await page.screenshot({ path: file, animations: 'disabled', fullPage: false, ...(clip ? { clip } : {}) });
        fs.chmodSync(file, 0o600);
      };
      let result;
      try {
        await page.goto(`${origin.origin}/settings?tab=${kind === 'stores' ? 'appstores' : 'appearance'}`, { waitUntil: 'domcontentloaded' });
        await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
        await page.locator('.desktop-settings').waitFor();
        if (kind === 'stores') {
          await page.getByRole('heading', { name: 'App Stores', exact: true }).waitFor();
          await page.getByRole('button', { name: 'Add app store', exact: true }).waitFor();
          await page.locator('.app-stores .table-responsive').waitFor();
          await page.waitForFunction(
            (expectedRows) => {
              const settings = document.querySelector('.desktop-settings');
              const body = settings?.querySelector('.card-body');
              const table = body?.querySelector('.app-stores-table');
              const heading = body?.querySelector('h2');
              const add = [...(body?.querySelectorAll('button') ?? [])].find((button) => button.textContent.trim() === 'Add app store');
              return (
                table?.querySelectorAll('tbody tr').length === expectedRows &&
                heading?.textContent.trim() === 'App Stores' &&
                heading.getBoundingClientRect().width > 0 &&
                table.getBoundingClientRect().width > 0 &&
                add?.getBoundingClientRect().width > 0
              );
            },
            before.stores.appStores.length,
            { timeout: 15000 },
          );
        } else {
          await page.getByRole('textbox', { name: 'Server name', exact: true }).waitFor();
          await page.locator('.appearance-note').waitFor();
          await page.locator('.appearance-section').first().waitFor();
        }
        await page.evaluate(() => document.fonts.ready);
        await settle(page);
        await scaleText(page, textScale);
        await settle(page);
        result = await inspect(page, capture);
      } catch (error) {
        await capture('failure').catch(() => undefined);
        throw error;
      }
      await Promise.all(assetJobs);
      assert.ok(assets.documents && assets.scripts && assets.stylesheets, 'Each case must load real published HTML, JavaScript and CSS');
      assert.equal(report.blockedMutations.length, 0, 'Unexpected browser mutations were blocked');
      assert.equal(report.pageErrors.length, 0, 'Browser page errors were recorded');
      return { viewport, mode, textScale, appearance: 'browser-local preferences; real preset retained', assets, ...result };
    } finally {
      await context.close();
    }
  };
  let cookies;
  try {
    assert.equal(process.env.ORBIS_ALLOW_RESPONSIVE_AUDIT, '1', 'Explicit responsive audit opt-in is required');
    assert.ok(
      releaseFile && cookieFile && expectedTag && expectedCommit && expectedDigest,
      'Release, owned cookie and independent tag/commit/digest pins are required',
    );
    assert.equal(cookieFile, ownedCookieFile, 'Only the exact owned rehearsal cookie file is allowed');
    assert.match(expectedTag, /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/, 'Expected release tag must be explicit');
    assert.match(expectedCommit, /^[a-f0-9]{40}$/, 'Expected commit must be a full SHA');
    assert.match(expectedDigest, /^sha256:[a-f0-9]{64}$/, 'Expected digest must be pinned');
    assert.ok(
      ['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.protocol === 'http:' && origin.port === '18080',
      'Only owned loopback HTTP port18080 is allowed',
    );
    assert.ok(!origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'Audit URL must be an origin');
    const rootStat = fs.lstatSync(installRoot);
    assert.ok(
      rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === process.getuid(),
      'Rehearsal install root must be an owned directory',
    );
    assert.equal(fs.realpathSync(installRoot), installRoot, 'Rehearsal install root must not redirect');
    release = parsePrivate(readOwnedInput(releaseFile), 'Release manifest');
    assert.equal(release.tag, expectedTag, 'Release manifest tag does not match the independent pin');
    assert.equal(release.commit, expectedCommit, 'Release manifest full commit does not match the independent pin');
    assert.equal(release.image, `ghcr.io/twentylines/orbis@${expectedDigest}`, 'Release image does not match the independent digest pin');
    cookies = parseCookies(readOwnedInput(cookieFile), origin.hostname);
    privateDirectory(output);
    privateDirectory(screenshotDir);
    outputReady = true;
    report.release = { tag: release.tag, commit: release.commit, image: release.image };
    verifyCore(release.image);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    stage = 'baseline';
    verifyBuild(await read('/api/system/build'));
    assert.equal((await read('/api/user-context')).isLoggedIn, true, 'Owned audit cookie must authenticate');
    const appContext = await read('/api/app-context');
    assert.equal(appContext.user?.hasSeenWelcome, true, 'Owned audit account must have completed onboarding');
    assert.equal(appContext.user?.locale, 'en', 'This read-only English-label audit requires the existing English account');
    before = await snapshotRecords();
    assert.ok(Array.isArray(before.stores.appStores) && before.stores.appStores.length > 0, 'Actual app-store rows are required');
    privateBaseline.before = before;
    privateBaseline.hostReads = { load: await read('/api/system/load'), containers: await read('/api/system/containers') };
    privateWrite(baselineFile, privateBaseline);
    const viewports = [
      { width: 1440, height: 1120 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 320, height: 800 },
      { width: 3840, height: 2160 },
    ];
    for (const viewport of viewports)
      for (const mode of ['light', 'dark'])
        for (const textScale of [1, 2]) {
          stage = `settings-${viewport.width}-${mode}-${textScale}`;
          report.settings.push(
            await withCase('settings', viewport, mode, textScale, async (page, capture) => {
              const alignment = await inspectSettingsAlignment(page);
              const initial = await pageGeometry(page);
              checkPageGeometry(initial, viewport);
              assert.ok(alignment.settings.width <= 1601, 'Settings body must remain bounded at ultra-wide sizes');
              await capture('viewport');
              if (viewport.width >= 1440) {
                const top = Math.max(0, initial.frame.top);
                const bottom = Math.min(viewport.height, alignment.section.bottom);
                await capture('heading-and-first-section', { x: initial.frame.left, y: top, width: initial.frame.width, height: bottom - top });
              }
              const content = page.locator('.desktop-window-content');
              const box = await content.boundingBox();
              await page.mouse.move(
                Math.min(viewport.width - 30, box.x + box.width / 2),
                Math.min(initial.dock.top - 20, Math.max(initial.bar.bottom + 20, box.y + 80)),
              );
              await page.mouse.wheel(0, 600);
              await page.waitForTimeout(400);
              const wheel = await pageGeometry(page);
              checkPageGeometry(wheel, viewport);
              if (initial.navigation === 'page') assert.ok(wheel.outerScroll > initial.outerScroll, 'Small Settings must wheel-scroll the document');
              else if (initial.content.scrollHeight > initial.content.clientHeight + 1)
                assert.ok(wheel.content.scrollTop > 0, 'Desktop Settings must scroll its content');
              await page.locator('.appearance button').last().focus();
              await settle(page);
              const lastFocus = await pageGeometry(page);
              checkFocus(lastFocus);
              await page.keyboard.press('Shift+Tab');
              await settle(page);
              const reverseFocus = await pageGeometry(page);
              checkFocus(reverseFocus);
              assert.equal(
                await page.evaluate(() => document.activeElement.textContent.trim()),
                'Import settings',
                'Reverse navigation must reach the previous real control',
              );
              return { alignment, initial, wheel, lastFocus, reverseFocus };
            }),
          );
        }
    for (const viewport of viewports.filter((viewport) => [390, 320].includes(viewport.width)))
      for (const mode of ['light', 'dark'])
        for (const textScale of [1, 2]) {
          stage = `stores-${viewport.width}-${mode}-${textScale}`;
          report.stores.push(
            await withCase('stores', viewport, mode, textScale, async (page, capture) => {
              const alignment = await inspectStoreAlignment(page);
              for (const key of ['headingIcon', 'nav', 'bodyHeading', 'table'])
                assert.ok(Math.abs(alignment[key].left - alignment.settings.left) <= 1, 'Real store sections must share the left gutter');
              for (const key of ['nav', 'table'])
                assert.ok(Math.abs(alignment[key].right - alignment.settings.right) <= 1, 'Real store sections must share the right gutter');
              assert.ok(alignment.divider.y - alignment.lastTabBottom >= 8, 'Real store tab divider must clear every tab row');
              assert.equal(alignment.rowCount, before.stores.appStores.length, 'Rendered app stores must come from the actual baseline');
              assert.ok(['auto', 'scroll'].includes(alignment.table.overflowX), 'Wide actual store rows must retain contained horizontal scrolling');
              const initial = await pageGeometry(page);
              checkPageGeometry(initial, viewport);
              await capture('viewport');
              await page.getByRole('button', { name: 'Add app store', exact: true }).focus();
              await settle(page);
              const focus = await pageGeometry(page);
              checkFocus(focus);
              await capture('add-focus');
              return { source: 'Actual app-store GET; no catalogue or mutation fixtures', alignment, initial, focus };
            }),
          );
        }
    for (const mode of ['light', 'dark']) {
      const viewport = { width: 320, height: 400 };
      stage = `short-focus-${mode}`;
      report.shortFocus.push(
        await withCase('short-focus', viewport, mode, 2, async (page, capture) => {
          const alignment = await inspectSettingsAlignment(page);
          await page.locator('.appearance button').last().focus();
          await settle(page);
          const last = await pageGeometry(page);
          checkPageGeometry(last, viewport);
          checkFocus(last);
          await capture('last-focus');
          await page.keyboard.press('Shift+Tab');
          await settle(page);
          const reverse = await pageGeometry(page);
          checkPageGeometry(reverse, viewport);
          checkFocus(reverse);
          assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Import settings');
          await capture('shift-tab-focus');
          return { alignment, last, reverse };
        }),
      );
    }
    assert.equal(report.settings.length, 20, 'All requested Settings width/mode/text groups must run');
    assert.equal(report.stores.length, 8, 'Actual phone store rows must run in both modes and text sizes');
    assert.equal(report.shortFocus.length, 2, 'Both short-screen modes must run');
    stage = 'final-records';
    privateBaseline.after = await snapshotRecords();
    samePrivate(privateBaseline.after, before, 'Actual preferences, installed apps, full app records or stores changed during the read-only audit');
    report.recordsUnchanged = true;
    verifyBuild(await read('/api/system/build'));
    verifyCore(release.image);
    assert.equal(report.blockedMutations.length, 0, 'Unexpected mutation attempts were blocked');
    assert.equal(report.pageErrors.length, 0, 'Browser page errors were recorded');
    assert.ok(report.shadowPreferenceGets >= 30, 'Each case must consume browser-local appearance');
    report.passed = true;
  } catch (error) {
    failure = error;
    report.failure = { stage, type: error.name, message: String(error.message), messageHash: hash(String(error.message)) };
  } finally {
    if (reader && before) {
      try {
        privateBaseline.after = await snapshotRecords();
        samePrivate(privateBaseline.after, before, 'Final read-only record comparison failed');
        report.recordsUnchanged = true;
      } catch {
        report.recordsUnchanged = false;
        report.cleanupFailures.push('actual-record-comparison-failed');
      }
    }
    try {
      await reader?.close();
    } catch {
      report.cleanupFailures.push('reader-context-close-failed');
    }
    try {
      await browser?.close();
    } catch {
      report.cleanupFailures.push('browser-close-failed');
    }
    if (report.cleanupFailures.length) report.passed = false;
    if (outputReady) {
      privateWrite(baselineFile, privateBaseline);
      privateWrite(reportFile, report);
    }
  }
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, version: report.release?.tag, settingsGroups: report.settings.length, storeGroups: report.stores.length, shortFocusGroups: report.shortFocus.length, recordsUnchanged: report.recordsUnchanged, pageErrors: report.pageErrors.length, blockedMutations: report.blockedMutations.length, stage: failure ? stage : 'complete', reportFile: outputReady ? reportFile : undefined })}\n`,
  );
  if (failure || !report.passed) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('Published responsive audit could not complete; no cookies, credentials or app records were printed.\n');
  process.exitCode = 1;
});
