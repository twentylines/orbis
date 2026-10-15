const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');

const installRoot = '/Users/sai/.codex/tmp/orbis-stock-20261015';
const ownedCookieFile = `${installRoot}/test-cookies.txt`;
const dockerContext = 'colima-runtipi-test';
const urn = 'rehearsal-app:orbis-qa';
const base = new URL(process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080');
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const expectedTag = process.env.ORBIS_AUDIT_EXPECTED_TAG;
const expectedCommit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
const screenshotDir = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || '/tmp/orbis-live-beta30-text-comfort';
const reportFile = process.env.ORBIS_AUDIT_REPORT_FILE || '/tmp/orbis-beta30-text-comfort.json';
const preferenceKey = 'server-desktop-preferences-v1';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const samePrivate = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);
const parsePrivate = (value, label) => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
};
const readOwnedInput = (file) => {
  assert.ok(path.isAbsolute(file), 'Audit inputs must be absolute paths');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Audit inputs must be owned regular files');
  if (file === ownedCookieFile) assert.equal(stat.mode & 0o077, 0, 'Fixture cookies must remain private');
  const real = fs.realpathSync(file);
  assert.ok(
    file === ownedCookieFile ? real === file : file.startsWith('/tmp/') && real.startsWith(`${fs.realpathSync('/tmp')}/`),
    'Audit inputs must remain in their authorized locations',
  );
  return fs.readFileSync(file, 'utf8');
};
const temporaryOutput = (file) => {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file && file.startsWith('/tmp/'), 'Audit output must remain under /tmp');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink() && stat.uid === process.getuid(), 'Audit output must be owned and must not be a symlink');
  }
  let parent = file;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = fs.realpathSync(parent);
  const temporaryRoot = fs.realpathSync('/tmp');
  assert.ok(real === temporaryRoot || real.startsWith(`${temporaryRoot}/`), 'Audit output must not redirect outside the temporary directory');
};
const readDocker = (args) => {
  const result = spawnSync('docker', ['--context', dockerContext, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.ok(!result.error && result.status === 0, 'Owned Docker inspection failed');
  return result.stdout;
};
const verifyCore = (image) => {
  const ids = readDocker(['ps', '-q', '--filter', 'label=com.docker.compose.service=runtipi']).trim().split('\n').filter(Boolean);
  assert.equal(ids.length, 1, 'Exactly one running core is required in the owned Docker context');
  const format =
    '{"image":{{json .Config.Image}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"mounts":{{json .Mounts}}}';
  const core = parsePrivate(readDocker(['inspect', '--format', format, ids[0]]), 'Owned core inspection');
  assert.equal(core.image, image, 'Owned core image differs from the target release');
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
      'Core bind ownership does not match the owned fixture',
    );
  }
};
const verifyBuild = (build, release) => {
  assert.equal(build.version, release.tag, 'Published build tag mismatch');
  assert.equal(build.commit, release.commit, 'Published build commit mismatch');
  assert.equal(build.imageDigest, release.image.split('@')[1], 'Published build digest mismatch');
};

const scaleText = (page, scale) =>
  page.evaluate((factor) => {
    if (factor === 1) return;
    const baseline = [...document.querySelectorAll('body,body *')]
      .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'META', 'LINK'].includes(element.tagName))
      .map((element) => ({
        element,
        font: Number.parseFloat(getComputedStyle(element).fontSize),
        line: Number.parseFloat(getComputedStyle(element).lineHeight),
      }));
    for (const { element, font, line } of baseline) {
      if (Number.isFinite(font)) element.style.setProperty('font-size', `${font * factor}px`, 'important');
      if (Number.isFinite(line)) element.style.setProperty('line-height', `${line * factor}px`, 'important');
    }
  }, scale);

const inspectWords = (locator, allowedToken = '', allowUnfitTokens = false) =>
  locator.evaluate(
    (root, { allowed, unfit }) => {
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const bounds = box(root);
      let words = 0;
      let fractures = 0;
      let paintOutside = 0;
      let ordinaryEllipses = 0;
      let boundedTokens = 0;
      let boundedOperationNames = 0;
      let invalidOperationNames = 0;
      const acceptedTokens = new Set();
      for (const name of root.querySelectorAll('.workspace-recent-tasks .workspace-recent-app-name')) {
        if (name.scrollWidth <= name.clientWidth + 1) continue;
        const style = getComputedStyle(name);
        const link = name.closest('a');
        const strong = name.closest('strong');
        const status = link?.querySelector('b[data-status]')?.textContent.replace(/\s+/g, ' ').trim();
        const time = link?.querySelector('small')?.textContent.replace(/\s+/g, ' ').trim();
        const fullTitle = strong?.textContent.replace(/\s+/g, ' ').trim();
        const fullName = name.textContent.replace(/\s+/g, ' ').trim();
        const action = fullTitle?.slice(0, -fullName.length).trim();
        const label = link?.getAttribute('aria-label')?.replace(/\s+/g, ' ').trim();
        const nameBox = box(name);
        const linkBox = link ? box(link) : null;
        const valid =
          style.overflowX === 'hidden' &&
          style.textOverflow === 'ellipsis' &&
          style.whiteSpace === 'nowrap' &&
          nameBox.width > 0 &&
          linkBox &&
          nameBox.x >= linkBox.x - 1 &&
          nameBox.right <= linkBox.right + 1 &&
          nameBox.y >= linkBox.y - 1 &&
          nameBox.bottom <= linkBox.bottom + 1 &&
          nameBox.x >= bounds.x - 1 &&
          nameBox.right <= bounds.right + 1 &&
          action &&
          fullName &&
          status &&
          time &&
          link.title.replace(/\s+/g, ' ').trim() === fullTitle &&
          label === `${fullTitle}, ${status}, ${time}`;
        if (valid) {
          acceptedTokens.add(name);
          boundedOperationNames++;
        } else invalidOperationNames++;
      }
      for (const word of root.querySelectorAll('.orbis-whole-word')) {
        if (word.scrollWidth <= word.clientWidth + 1) continue;
        const style = getComputedStyle(word);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const fullWidth = context.measureText(word.textContent).width;
        const hasFullName = word.closest('[role="option"]')?.getAttribute('aria-label') && word.closest('[title]')?.title;
        if (style.textOverflow === 'ellipsis' && fullWidth > word.clientWidth + 1 && (word.textContent === allowed || (unfit && hasFullName))) {
          boundedTokens++;
          acceptedTokens.add(word);
        } else ordinaryEllipses++;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!node.textContent.trim() || !parent.getBoundingClientRect().width || parent.closest('svg,pre,code,.cm-editor,.visually-hidden,[hidden]'))
          continue;
        const bounded = parent.closest('.orbis-whole-word,.workspace-recent-app-name');
        if (acceptedTokens.has(bounded)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) if (rect.width && (rect.x < bounds.x - 1 || rect.right > bounds.right + 1)) paintOutside++;
        for (const match of node.textContent.matchAll(/[A-Za-z]{4,}/g)) {
          words++;
          if (match[0] === allowed) continue;
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          if (new Set([...range.getClientRects()].filter((rect) => rect.width).map((rect) => Math.round(rect.y * 10))).size > 1) fractures++;
        }
      }
      return {
        words,
        fractures,
        paintOutside,
        ordinaryEllipses,
        boundedTokens,
        boundedOperationNames,
        invalidOperationNames,
        documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      };
    },
    { allowed: allowedToken, unfit: allowUnfitTokens },
  );
const checkWords = (geometry) => {
  assert.ok(
    !geometry.fractures && !geometry.paintOutside && !geometry.ordinaryEllipses && !geometry.invalidOperationNames && !geometry.documentOverflow,
    'Visible ordinary text must fit and remain whole',
  );
};

async function main() {
  let browser;
  let reader;
  let before;
  let release;
  let stage = 'preflight';
  const report = {
    passed: false,
    source:
      'Published beta30 HTML/assets and live read-only health APIs. Long metadata, transient connection events, log lines, install state and appearance are browser-controlled fixtures.',
    release: null,
    widths: [],
    mockedPreferenceWrites: 0,
    blockedMutations: [],
    externalRequestsBlocked: 0,
    realNonReadRequests: 0,
    pageErrors: [],
    recordsUnchanged: false,
    cleanupFailures: [],
  };
  const compareRecords = async () => {
    for (const [key, endpoint] of Object.entries({
      app: `/api/apps/${encodeURIComponent(urn)}`,
      installed: '/api/apps/installed',
      preferences: '/api/desktop-preferences',
    })) {
      const response = await reader.request.get(`${base.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
      assert.ok(response.ok(), 'Final authenticated GET failed');
      samePrivate(await response.json(), before[key], 'Actual server records changed during the read-only audit');
    }
    report.recordsUnchanged = true;
  };
  try {
    assert.ok(releaseFile && cookieFile && expectedTag && expectedCommit, 'Explicit release, cookie, expected tag and expected commit are required');
    assert.equal(expectedTag, 'v0.1.0-beta.30', 'This driver verifies beta30 only');
    assert.match(expectedCommit, /^[a-f0-9]{40}$/, 'Expected commit must be a complete commit ID');
    assert.equal(cookieFile, ownedCookieFile, 'Only the owned fixture cookie file is allowed');
    assert.ok(
      ['127.0.0.1', 'localhost'].includes(base.hostname) &&
        base.protocol === 'http:' &&
        base.port === '18080' &&
        base.pathname === '/' &&
        !base.username &&
        !base.password &&
        !base.search &&
        !base.hash,
      'Only the owned loopback HTTP origin on port 18080 is allowed',
    );
    assert.equal(fs.realpathSync(installRoot), installRoot, 'Owned install root must not be redirected');
    release = parsePrivate(readOwnedInput(releaseFile), 'Release checker manifest');
    assert.ok(release.tag === expectedTag && release.commit === expectedCommit, 'Release checker manifest differs from explicit target guards');
    assert.match(release.image || '', /^ghcr\.io\/twentylines\/orbis@sha256:[a-f0-9]{64}$/);
    report.release = { tag: release.tag, commit: release.commit, image: release.image };
    const cookies = readOwnedInput(cookieFile)
      .split('\n')
      .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
      .map((line) => {
        const fields = line.split('\t');
        assert.equal(fields.length, 7, 'Cookie entry is malformed');
        const [rawDomain, , cookiePath, secure, expires, name, value] = fields;
        const domain = rawDomain.replace(/^#HttpOnly_/, '');
        assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(domain), 'Only loopback cookies are allowed');
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
      cookies.some((cookie) => cookie.name === 'runtipi-sid' && cookie.domain === base.hostname),
      'Matching fixture session cookie is required',
    );
    temporaryOutput(screenshotDir);
    temporaryOutput(reportFile);
    assert.ok(fs.existsSync(path.dirname(reportFile)), 'Report parent must already exist');
    fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
    verifyCore(release.image);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    const read = async (endpoint) => {
      assert.ok(endpoint.startsWith('/api/') && !endpoint.includes('?'), 'Direct reads must use a fixed API path');
      const response = await reader.request.get(`${base.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
      assert.ok(response.ok(), 'Authenticated audit GET failed');
      return response.json();
    };
    stage = 'baseline';
    verifyBuild(await read('/api/system/build'), release);
    before = {
      app: await read(`/api/apps/${encodeURIComponent(urn)}`),
      installed: await read('/api/apps/installed'),
      preferences: await read('/api/desktop-preferences'),
    };
    const appContext = await read('/api/app-context');
    assert.ok(
      (await read('/api/user-context')).isLoggedIn && appContext.user?.hasSeenWelcome,
      'The audit account must be authenticated and onboarded',
    );
    assert.ok(
      before.app.info?.urn === urn && before.app.info?.id === 'rehearsal-app' && ['stopped', 'running'].includes(before.app.app?.status),
      'Expected installed idle fixture app is required',
    );
    assert.equal(before.app.app.appStore?.url, 'http://orbis-qa-git:9418/orbis-qa.git', 'Unexpected fixture store');
    const address = appContext.userSettings?.internalIp;
    assert.ok(typeof address === 'string' && address.length > 0, 'A configured server address is required');
    const technicalToken = 'HomeAssistantCommunityAddonsSynchronizationSupervisor';
    const names = [
      'Jellyfin Media Library and Transcoding Server',
      'Nextcloud Collaborative Library and Private File Synchronization',
      'Paperless Library Archive and Optical Character Recognition',
    ];
    const descriptions = [
      'Media and entertainment · Private streaming and collection management',
      'Collaboration and productivity · Library synchronization and document processing',
      'Documents and information · Searchable library archive and character recognition',
    ];
    const installed = names.map((name, index) => ({
      info: { urn: index ? `text${index}:orbis-qa` : urn, name, short_desc: descriptions[index], available: true },
      app: { id: index + 1000, status: 'stopped', version: 1, ignoredVersion: null },
      metadata: { latestVersion: 1 },
    }));
    const catalogue = [
      ...names.map((name, index) => ({
        id: `text${index}`,
        urn: `text${index}:orbis-qa`,
        name: `${name} Community Edition`,
        short_desc: descriptions[index],
        available: true,
        categories: ['utilities'],
        created_at: 0,
      })),
      {
        id: 'technical',
        urn: 'technical:orbis-qa',
        name: technicalToken,
        short_desc: 'Library infrastructure · An intentionally oversized single identifier',
        available: true,
        categories: ['utilities'],
        created_at: 0,
      },
    ];
    const controlledApp = clone(before.app);
    Object.assign(controlledApp.info, {
      name: names[0],
      short_desc: descriptions[0],
      description: 'Browser-controlled text metadata. No installed application files are changed.',
      form_fields: [
        { type: 'text', label: 'Document processing service label', env_variable: 'SERVICE_LABEL', required: true, default: 'Private library' },
      ],
    });
    // Static suites cover the full matrix; this samples published assets and the missed header breakpoint.
    for (const width of [1440, 768, 320]) {
      stage = `visual-${width}`;
      verifyBuild(await read('/api/system/build'), release);
      const context = await browser.newContext({
        viewport: { width, height: width === 1440 ? 1120 : width === 768 ? 1024 : 800 },
        serviceWorkers: 'block',
      });
      const result = { width, realConnection: false, assets: { documents: 0, scripts: 0, stylesheets: 0 }, forwardedReads: {}, samples: [] };
      report.widths.push(result);
      let preferences = { ...clone(before.preferences), mode: 'light', serverName: 'Hades Media and Automation Server', windows: {} };
      let installState = false;
      let preferenceAttempts = 0;
      let preferenceResponses = 0;
      try {
        await context.addCookies(cookies);
        await context.addInitScript(
          ({ origin, key, value }) => {
            if (window === window.top && location.origin === origin) localStorage.setItem(key, JSON.stringify(value));
          },
          { origin: base.origin, key: preferenceKey, value: preferences },
        );
        context.on('page', (page) =>
          page.on('pageerror', (error) => report.pageErrors.push({ width, type: error.name, messageHash: hash(error.message) })),
        );
        context.on('request', (request) => {
          if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && new URL(request.url()).pathname === '/api/desktop-preferences')
            preferenceAttempts++;
        });
        context.on('response', (response) => {
          const target = new URL(response.url());
          if (target.origin !== base.origin || target.pathname.startsWith('/api/') || !response.ok()) return;
          const key = { document: 'documents', script: 'scripts', stylesheet: 'stylesheets' }[response.request().resourceType()];
          if (key) result.assets[key]++;
        });
        await context.route('**/*', async (route) => {
          const request = route.request();
          const target = new URL(request.url());
          const respond = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
          if (target.origin !== base.origin) {
            report.externalRequestsBlocked++;
            return route.abort('blockedbyclient');
          }
          if (target.pathname === '/api/desktop-preferences') {
            if (request.method() === 'GET') return respond(preferences);
            if (request.method() === 'PUT') {
              preferences = parsePrivate(request.postData() || '', 'Browser appearance fixture');
              preferenceResponses++;
              report.mockedPreferenceWrites++;
              return respond(preferences);
            }
          }
          if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
            report.blockedMutations.push({ width, method: request.method(), path: target.pathname });
            return route.abort('blockedbyclient');
          }
          const endpoint = decodeURIComponent(target.pathname);
          if (endpoint === '/api/app-context') {
            const value = clone(appContext);
            value.user.username = 'fixture@example.test';
            Object.assign(value.userSettings, { advancedSettings: true, timeZone: 'America/Argentina/Buenos_Aires', logLevel: 'info' });
            return respond(value);
          }
          if (endpoint === '/api/apps/installed') return respond({ installed });
          if (endpoint === `/api/apps/${urn}`) return respond({ ...controlledApp, app: installState ? null : controlledApp.app });
          if (endpoint === '/api/apps/random-port') return respond({ port: 8123 });
          if (['/api/sse/runtipi-logs', '/api/sse/app-logs'].includes(endpoint))
            return route.fulfill({
              status: 200,
              contentType: 'text/event-stream',
              body: 'data: {"lines":["Browser-controlled comfort audit log line."]}\n\n',
            });
          if (endpoint.startsWith('/api/marketplace/apps/search')) {
            const query = (target.searchParams.get('search') || '').toLowerCase();
            const data = catalogue.filter((item) => `${item.name} ${item.short_desc}`.toLowerCase().includes(query));
            return respond({ data, total: data.length, currentPage: 1, lastPage: 1 });
          }
          assert.ok(['GET', 'HEAD', 'OPTIONS'].includes(request.method()), 'Only reads may reach the real server');
          result.forwardedReads[target.pathname] = (result.forwardedReads[target.pathname] || 0) + 1;
          return route.continue();
        });
        const page = await context.newPage();
        const capture = async (name) => {
          const file = path.join(screenshotDir, `${width}-${name}.png`);
          temporaryOutput(file);
          await page.screenshot({ path: file, animations: 'disabled' });
        };
        const open = async (route, ready, mode) => {
          stage = `visual-${width}-${mode}-${route}`;
          installState = route.startsWith('/app-store/');
          await page.goto(`${base.origin}${route}`, { waitUntil: 'domcontentloaded' });
          await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
          await page.locator(ready).first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(700);
        };
        await open('/dashboard', '.workspace h1', 'light');
        await page.locator('.desktop-connection-dot.is-connected').waitFor();
        assert.equal(await page.locator('.desktop-connection-label').innerText(), address, 'Real SSE must show exactly the configured address');
        result.realConnection = true;
        await capture('live-connected-native');
        // Only later navigations replace streams; the first connected check uses the live endpoint.
        await context.addInitScript((origin) => {
          if (window !== window.top || location.origin !== origin) return;
          const sources = [];
          class TextEventSource extends EventTarget {
            static CONNECTING = 0;
            static OPEN = 1;
            static CLOSED = 2;
            CONNECTING = 0;
            OPEN = 1;
            CLOSED = 2;
            readyState = 0;
            onopen = null;
            onmessage = null;
            onerror = null;
            constructor(url) {
              super();
              this.url = new URL(url, location.origin).href;
              sources.push(this);
              if (new URL(this.url).pathname !== '/api/sse/app')
                this.timer = setTimeout(() => {
                  if (this.readyState === 2) return;
                  this.readyState = 1;
                  this.onopen?.(new Event('open'));
                  this.onmessage?.(
                    new MessageEvent('message', {
                      data: JSON.stringify({ lines: ['Browser-controlled comfort audit log line. No real log content is read.'] }),
                    }),
                  );
                }, 0);
            }
            close() {
              clearTimeout(this.timer);
              this.readyState = 2;
            }
          }
          window.EventSource = TextEventSource;
          window.__orbisTextStreams = {
            open: () => {
              const source = sources.filter((item) => new URL(item.url).pathname === '/api/sse/app' && item.readyState !== 2).at(-1);
              if (!source) return false;
              source.readyState = 1;
              source.onopen?.(new Event('open'));
              return true;
            },
            fail: () => {
              const source = sources.filter((item) => new URL(item.url).pathname === '/api/sse/app' && item.readyState === 1).at(-1);
              if (!source) return false;
              source.onerror?.(new Event('error'));
              return true;
            },
          };
        }, base.origin);
        const cases =
          width === 1440
            ? [{ mode: 'light', scale: 1 }]
            : [
                { mode: 'light', scale: 1 },
                { mode: 'dark', scale: 2 },
              ];
        for (const { mode, scale } of cases) {
          preferences = { ...clone(before.preferences), mode, serverName: 'Hades Media and Automation Server', windows: {} };
          const prefix = `${mode}-text${scale}`;
          await open('/dashboard', '.workspace h1', mode);
          await scaleText(page, scale);
          await page.waitForTimeout(150);
          const home = await inspectWords(page.locator('.workspace-heading'));
          checkWords(home);
          checkWords(await inspectWords(page.locator('.workspace-activity')));
          const operations = (await page.locator('.workspace-operations').count()) ? await inspectWords(page.locator('.workspace-operations')) : null;
          if (operations) checkWords(operations);
          const headerStates = [];
          for (const state of ['connecting', 'connected', 'reconnecting']) {
            if (state === 'connected') assert.ok(await page.evaluate(() => window.__orbisTextStreams.open()), 'Controlled app stream must exist');
            if (state === 'reconnecting')
              assert.ok(await page.evaluate(() => window.__orbisTextStreams.fail()), 'Controlled app stream must be connected');
            const text = state === 'connected' ? address : state === 'connecting' ? 'Connecting' : 'Reconnecting';
            await page.waitForFunction((value) => document.querySelector('.desktop-connection-label')?.textContent === value, text);
            const header = await page.locator('.desktop-system-bar').evaluate((bar) => {
              const box = (element) => {
                const r = element.getBoundingClientRect();
                return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
              };
              const connection = bar.querySelector('.desktop-connection');
              const label = connection.querySelector('.desktop-connection-label');
              const dot = connection.querySelector('.desktop-connection-dot');
              const style = getComputedStyle(label);
              const bounds = box(bar);
              const textBox = box(label);
              const dotBox = box(dot);
              const controls = [...bar.querySelectorAll('.desktop-task-trigger,.desktop-mode-toggle,.desktop-search-trigger,.desktop-icon-button')]
                .filter((element) => element.getBoundingClientRect().width)
                .map(box);
              const overlap = controls.some(
                (control) =>
                  control.x < textBox.right - 1 && control.right > textBox.x + 1 && control.y < textBox.bottom - 1 && control.bottom > textBox.y + 1,
              );
              return {
                kind: connection.dataset.connectionKind,
                font: style.fontSize,
                line: style.lineHeight,
                labelCount: connection.querySelectorAll('.desktop-connection-label').length,
                extraSmall: connection.querySelectorAll('small').length,
                clipped: label.scrollWidth > label.clientWidth + 1,
                overlap,
                contained: textBox.x >= bounds.x && textBox.right <= bounds.right && textBox.y >= bounds.y && textBox.bottom <= bounds.bottom,
                centreDelta: Math.abs(dotBox.y + dotBox.height / 2 - textBox.y - textBox.height / 2),
                controlsAligned: controls.every((control) => Math.abs(control.y - controls[0].y) < 1),
                documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
              };
            });
            assert.ok(
              header.labelCount === 1 &&
                !header.extraSmall &&
                !header.overlap &&
                header.contained &&
                header.centreDelta <= 0.6 &&
                header.controlsAligned &&
                !header.documentOverflow,
              'Header label and controls must stay aligned and separate',
            );
            assert.equal(
              header.kind,
              state === 'connected' ? 'address' : 'status',
              'Header kind must distinguish configured addresses from transient status',
            );
            if (state !== 'connected') assert.equal(header.clipped, false, 'Transient connection words must remain fully visible');
            if (headerStates.length)
              assert.ok(
                header.font === headerStates[0].font && header.line === headerStates[0].line,
                'Connection state changes must retain typography',
              );
            headerStates.push({ state, ...header });
            await capture(`${prefix}-home-${state}-controlled-events`);
          }
          result.samples.push({ mode, scale, surface: 'home-header', home, operations, headerStates });
          if (width > 390) continue;
          await open('/dashboard', '.workspace h1', mode);
          await page.getByRole('button', { name: 'Search apps and settings', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Search Orbis', exact: true });
          const input = dialog.getByRole('searchbox', { name: 'Search apps and settings', exact: true });
          await input.fill('library');
          await dialog.locator('[data-search-result]').nth(6).waitFor();
          await scaleText(page, scale);
          await dialog.evaluate(async (root) =>
            Promise.all(root.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined))),
          );
          const search = await inspectWords(dialog, technicalToken);
          checkWords(search);
          const searchInput = await input.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const close = element.closest('[role="dialog"]').querySelector('.desktop-search-close').getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              lineFits:
                box.height >= Number.parseFloat(style.lineHeight) + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) - 1,
              controlsFit: close.width >= 44 && close.height >= 44 && close.left - box.right >= 8,
              centreDelta: Math.abs(box.y + box.height / 2 - close.y - close.height / 2),
              queryRetained: element.value === 'library',
            };
          });
          assert.ok(
            searchInput.lineFits && searchInput.controlsFit && searchInput.centreDelta < 1 && searchInput.queryRetained,
            'Search query and close control need readable separate space',
          );
          for (const item of [...installed.map((entry) => ({ name: entry.info.name, short_desc: entry.info.short_desc })), ...catalogue])
            assert.equal(
              await dialog.getByRole('button', { name: `${item.name}, ${item.short_desc}`, exact: true }).count(),
              1,
              'Search results need full accessible names',
            );
          await input.focus();
          await input.press('ArrowDown');
          await page.keyboard.press('End');
          assert.ok(
            await dialog
              .locator('[data-search-result]')
              .last()
              .evaluate((element) => element === document.activeElement),
            'Search End must reach the last result',
          );
          await page.keyboard.press('Home');
          assert.ok(
            await dialog
              .locator('[data-search-result]')
              .first()
              .evaluate((element) => element === document.activeElement),
            'Search Home must reach the first result',
          );
          await dialog.locator('strong[title="Nextcloud Collaborative Library and Private File Synchronization"]').first().scrollIntoViewIfNeeded();
          await capture(`${prefix}-search-synchronization-controlled-metadata`);
          await dialog.locator(`strong[title="${technicalToken}"]`).scrollIntoViewIfNeeded();
          await capture(`${prefix}-search-identifier-controlled-metadata`);
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
          await page.waitForFunction(() => document.activeElement === document.querySelector('.desktop-search-trigger'));
          result.samples.push({ mode, scale, surface: 'search', ...search, searchInput, keyboard: true, fullAccessibleNames: 7 });
          await open('/settings?tab=settings', 'button[role="combobox"]', mode);
          const timezone = page.getByRole('combobox', { name: 'Timezone', exact: true });
          await timezone.scrollIntoViewIfNeeded();
          await timezone.click();
          await page.getByRole('listbox').waitFor();
          await scaleText(page, scale);
          await page.waitForTimeout(200);
          const select = await inspectWords(page.getByRole('listbox'), '', true);
          checkWords(select);
          const selectControls = await page.getByRole('listbox').evaluate((root) => {
            const r = root.getBoundingClientRect();
            return {
              contained: r.left >= 15 && r.right <= innerWidth - 15 && r.top >= 15 && r.bottom <= innerHeight - 15,
              options: [...root.querySelectorAll('[role="option"]')].every((option) => {
                const text = option.querySelector('.orbis-select-item-text').getBoundingClientRect();
                const indicator = option.querySelector('.orbis-select-item-indicator').getBoundingClientRect();
                return (
                  text.right + 7 <= indicator.left &&
                  option.getAttribute('aria-label')?.replace(/\s+/g, ' ').trim() === option.textContent.replace(/\s+/g, ' ').trim()
                );
              }),
            };
          });
          assert.ok(selectControls.contained && selectControls.options, 'Select options need full names and reserved indicator space');
          await capture(`${prefix}-timezone-controlled-context`);
          await page.keyboard.press('Escape');
          await page.waitForFunction((trigger) => document.activeElement === trigger, await timezone.elementHandle());
          result.samples.push({ mode, scale, surface: 'select', ...select, ...selectControls });
          await open('/settings?tab=logs', '#log-terminal', mode);
          const limit = page.getByRole('spinbutton', { name: 'Max lines:', exact: true });
          await limit.fill('1000');
          await scaleText(page, scale);
          await limit.scrollIntoViewIfNeeded();
          const logs = await inspectWords(page.locator('.log-terminal-controls'));
          checkWords(logs);
          const numeric = await limit.evaluate((element) => {
            const style = getComputedStyle(element);
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            return {
              fits:
                element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) >=
                context.measureText(element.value).width + 14,
              value: element.value,
            };
          });
          assert.ok(numeric.fits && numeric.value === '1000', 'Four log limit digits need usable control space');
          for (const name of ['Follow logs', 'Wrap lines'])
            assert.equal(await page.getByRole('checkbox', { name, exact: true }).count(), 1, 'Log toggles need individual labels');
          await capture(`${prefix}-logs-controlled-lines`);
          result.samples.push({ mode, scale, surface: 'logs-controls', ...logs, numericFits: numeric.fits });
          await open('/settings?tab=security', 'input[name="currentPassword"]', mode);
          await scaleText(page, scale);
          await page.locator('input[name="currentPassword"]').scrollIntoViewIfNeeded();
          const security = await inspectWords(page.locator('.settings-security'));
          checkWords(security);
          for (const name of ['currentPassword', 'newPassword', 'newPasswordConfirm'])
            assert.ok(
              await page.locator(`input[name="${name}"]`).evaluate((element) => [...element.labels].some((label) => label.textContent.trim())),
              'Security fields need permanent visible labels',
            );
          await capture(`${prefix}-security-controls`);
          result.samples.push({ mode, scale, surface: 'security-controls', ...security });
          await open('/app-store/orbis-qa/rehearsal-app', '.app-actions', mode);
          await page.locator('.app-actions').getByRole('button', { name: 'Install', exact: true }).click();
          const install = page.getByRole('dialog');
          await install.waitFor();
          await page.waitForTimeout(300);
          await scaleText(page, scale);
          const title = await inspectWords(install.locator('.modal-header'));
          checkWords(title);
          const fields = await inspectWords(install.locator('.modal-body'));
          checkWords(fields);
          const titleControls = await install.evaluate((root) => {
            const title = root.querySelector('.modal-title');
            const close = root.querySelector('button.btn-close').getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(title);
            return {
              closeTarget: close.width >= 44 && close.height >= 44,
              noOverlap: [...range.getClientRects()].every(
                (rect) => rect.right <= close.left || rect.left >= close.right || rect.bottom <= close.top || rect.top >= close.bottom,
              ),
            };
          });
          assert.ok(titleControls.closeTarget && titleControls.noOverlap, 'Install title must reserve a separate close target');
          await capture(`${prefix}-install-controlled-metadata`);
          await install.getByRole('button', { name: 'Close dialog', exact: true }).click();
          result.samples.push({ mode, scale, surface: 'install-title-and-fields', title, fields, titleControls });
          await open('/apps/create', '.service-form-sidebar-header', mode);
          await page.getByRole('button', { name: 'Environment', exact: true }).click();
          await scaleText(page, scale);
          const sidebar = await inspectWords(page.locator('.service-form-sidebar-header'));
          checkWords(sidebar);
          const environment = await inspectWords(page.locator('.service-config-toolbar:visible'));
          checkWords(environment);
          const serviceGap = await page.locator('.service-form-sidebar-header').evaluate((root) => {
            const title = root.firstElementChild.getBoundingClientRect();
            const button = root.querySelector('button').getBoundingClientRect();
            return title.bottom <= button.top ? button.top - title.bottom : button.left - title.right;
          });
          assert.ok(serviceGap >= 8, 'Services heading and Add service need breathing room');
          await page.getByRole('button', { name: 'Add Variable', exact: true }).scrollIntoViewIfNeeded();
          await capture(`${prefix}-compose-environment-controls`);
          const footer = await inspectWords(page.locator('.service-form-footer'));
          checkWords(footer);
          await page.getByRole('button', { name: 'YAML Editor', exact: true }).scrollIntoViewIfNeeded();
          await capture(`${prefix}-compose-footer-controls`);
          result.samples.push({ mode, scale, surface: 'compose-controls', sidebar, environment, footer, serviceGap });
        }
        assert.equal(preferenceAttempts, preferenceResponses, 'Every appearance write must be fulfilled locally');
        assert.ok(
          result.assets.documents && result.assets.scripts && result.assets.stylesheets,
          'Published HTML, scripts and styles must all be exercised',
        );
        assert.ok(
          result.forwardedReads['/api/system/load'] && result.forwardedReads['/api/system/containers'],
          'Live load and container reads must come from the owned server',
        );
        assert.ok(!report.pageErrors.length && !report.blockedMutations.length, 'Unexpected browser errors or mutation attempts were recorded');
      } finally {
        await context.close();
      }
    }
    stage = 'final-records';
    await compareRecords();
    verifyBuild(await read('/api/system/build'), release);
    verifyCore(release.image);
    report.passed = true;
  } catch (error) {
    const location = String(error.stack).match(/live-text-comfort-qa\.cjs:(\d+):(\d+)/);
    report.failure = {
      stage,
      type: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error',
      messageHash: hash(String(error.message)),
      sourceLocation: location ? { line: Number(location[1]), column: Number(location[2]) } : null,
    };
  } finally {
    if (reader && before)
      try {
        await compareRecords();
      } catch {
        report.recordsUnchanged = false;
        report.cleanupFailures.push('record-comparison-failed');
      }
    try {
      await browser?.close();
    } catch {
      report.cleanupFailures.push('browser-close-failed');
    }
    if (report.cleanupFailures.length) report.passed = false;
    if (release) {
      temporaryOutput(reportFile);
      fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('Published text comfort audit could not complete; no credentials, configuration, or real log content was printed.\n');
  process.exitCode = 1;
});
