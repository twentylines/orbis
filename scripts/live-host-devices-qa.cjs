// Published HostDevices acceptance uses actual API bodies and requires explicit release pins.
// Actual response bodies are unchanged; no browser mutation is forwarded.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');
const { dom } = require('./host-devices-checks.cjs');

const installRoot = process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install';
const ownedCookieFile = `${installRoot}/test-cookies.txt`;
const dockerContext = 'colima-runtipi-test';
const expectedTag = process.env.ORBIS_AUDIT_EXPECTED_TAG;
const readMethods = new Set(['GET', 'HEAD']);
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
  assert.ok(['ps', 'inspect'].includes(args[0]), 'Only read-only Docker inspection is permitted');
  const result = spawnSync('docker', ['--context', dockerContext, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.ok(!result.error && result.status === 0, 'Owned Docker inspection failed');
  return result.stdout;
}

function verifyCore(image) {
  const ids = readDocker(['ps', '-q', '--filter', 'label=com.docker.compose.service=runtipi']).trim().split('\n').filter(Boolean);
  assert.equal(ids.length, 1, 'Exactly one running core is required in the owned Docker context');
  const format =
    '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}';
  const core = parsePrivate(readDocker(['inspect', '--format', format, ids[0]]), 'Owned core inspection');
  assert.equal(core.image, image, 'Owned core image differs from the expected published image');
  assert.match(core.imageId, /^sha256:[a-f0-9]{64}$/, 'Owned core image identity is invalid');
  const imageDigests = parsePrivate(
    readDocker(['inspect', '--type', 'image', '--format', '{{json .RepoDigests}}', core.imageId]),
    'Owned image digests',
  );
  assert.ok(Array.isArray(imageDigests) && imageDigests.includes(image), 'Running image does not contain the pinned published digest');
  assert.ok(core.running && !core.paused && core.health === 'healthy', 'Owned core must be running, unpaused and healthy');
  const loopbackBinds = Object.values(core.ports || {})
    .flat()
    .filter((binding) => binding?.HostPort === '18080');
  assert.ok(
    loopbackBinds.length > 0 && loopbackBinds.every((binding) => ['127.0.0.1', '::1'].includes(binding.HostIp)),
    'Owned HTTP binding must remain loopback18080',
  );
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
  assert.equal(
    core.mounts.filter((mount) => /^\/(?:data\/(?:apps|repos|user-config|state)|app-data)\//.test(mount.Destination)).length,
    0,
    'Unexpected owned-tree mount override',
  );
  return { idHash: hash(ids[0]), image: core.image, imageId: core.imageId, healthy: true, ownedBinds: true };
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

const endpoint = '/api/system/host-telemetry';
const releasePath = '/tmp/orbis-beta42-release-check.json';
const pinnedDigest = 'sha256:3a0435e87402e3dd74c8d3ea2fff06cc2cf3e74d0a85dfbd4dfdfa35e02eac0f';
const groups = [
  { width: 1440, height: 1120, textScale: 1 },
  { width: 768, height: 1024, textScale: 1 },
  { width: 390, height: 844, textScale: 1 },
  { width: 320, height: 800, textScale: 1 },
  { width: 320, height: 800, textScale: 2 },
];

function counts(data) {
  assert.ok(
    data?.available && Array.isArray(data.filesystems) && Array.isArray(data.network) && Array.isArray(data.disks),
    'Actual host sample must be ready',
  );
  return { filesystems: data.filesystems.length, network: data.network.length, disks: data.disks.length };
}

function sanitizedMetrics(metrics) {
  const safe = structuredClone(metrics);
  safe.words = safe.words.map((issue) => ({
    reason: issue.reason,
    textHash: hash(issue.text),
    length: issue.text.length,
    naturalWidth: issue.naturalWidth,
    available: issue.available,
  }));
  for (const section of safe.sections)
    for (const card of section.cards) {
      card.identifier = {
        sha256: hash(card.identifier.text),
        length: card.identifier.text.length,
        fullTitleMatches: card.identifier.title === card.identifier.text,
        ink: card.identifier.ink,
        segmentCount: card.identifier.segmentCount,
        ellipses: card.identifier.ellipses.map((item) => ({
          box: item.box,
          singleLine: item.singleLine,
          overflowX: item.overflowX,
          textOverflow: item.textOverflow,
          fullTextRetained: item.title === item.text || card.identifier.title.includes(item.text),
        })),
      };
    }
  return safe;
}

async function warmup(read) {
  const began = Date.now();
  let attempts = 0;
  let sample;
  do {
    sample = await read(endpoint);
    attempts++;
    if (sample.available && !sample.stale) return { sample, attempts, elapsed: Date.now() - began };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() - began < 30000);
  throw new Error('Actual host sample did not become fresh within the bounded warmup');
}

async function assertActualRows(page, sample) {
  const expected = [
    ...sample.filesystems.map((item) => item.mount),
    ...sample.network.map((item) => item.interface),
    ...sample.disks.map((item) => item.device),
  ];
  await page.waitForFunction((identifiers) => {
    const actual = [...document.querySelectorAll('.desktop-host-devices .host-device-identifier')].map((element) => element.textContent);
    return actual.length === identifiers.length && actual.every((value, index) => value === identifiers[index]);
  }, expected);
  samePrivate(await page.locator('.host-device-identifier').allTextContents(), expected, 'Actual API identifiers and rendered records differ');
  for (const [id, expectedCount] of Object.entries({
    'host-storage-title': sample.filesystems.length,
    'host-network-title': sample.network.length,
    'host-disk-activity-title': sample.disks.length,
  }))
    assert.equal(
      await page.locator(`.host-device-sections > section[aria-labelledby="${id}"] .host-device`).count(),
      expectedCount,
      'Actual API row count differs from rendering',
    );
}

async function main() {
  process.umask(0o077);
  const expectedCommit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
  const expectedDigest = process.env.ORBIS_AUDIT_EXPECTED_DIGEST;
  const output = process.env.ORBIS_AUDIT_OUTPUT_DIR || '/tmp/orbis-live-beta42-host-devices-r1';
  const reportFile = path.join(output, 'report.json');
  const baselineFile = path.join(output, 'private-baseline.json');
  const errorFile = path.join(output, 'private-errors.json');
  const screenshots = path.join(output, 'screenshots');
  const report = {
    passed: false,
    release: null,
    groups: [],
    assets: {},
    forwardedReads: {},
    coreChecks: [],
    source: {
      live: [
        'Actual published HTML, JavaScript, stylesheets, images and authenticated API reads',
        'Actual HostDevices response bodies and existing Dark/Frost preferences',
      ],
      controlled: ['One 320px doubled-computed-text group', 'Browser-only same-origin CSP header adjustment; response bodies unchanged'],
      telemetrySubstitutions: 0,
      preferenceShadows: 0,
      realWrites: 0,
      captures: 'Native viewport and actual focused/wheel reading positions; no scroll reset',
    },
    blockedMutations: [],
    blockedRedirects: [],
    externalRequestsBlocked: 0,
    readFailures: [],
    assetFailures: [],
    pageErrors: [],
    recordsUnchanged: false,
    cleanupFailures: [],
    cleanup: { groupContextsClosed: 0, readerClosed: false, anonymousClosed: false, browserClosed: false },
  };
  const baseline = { hostSamples: [] };
  const rawErrors = [];
  let browser;
  let reader;
  let anonymous;
  let activeContext;
  let activePage;
  let origin;
  let release;
  let before;
  let outputReady = false;
  let stage = 'preflight';
  let cookieValues = [];
  const fail = (error) => {
    let message = String(error.stack || error.message || error);
    for (const value of cookieValues) message = message.replaceAll(value, '[private]');
    message = message
      .split('\n')
      .filter((line) => !/\b(?:cookie|authorization|headers)\b/i.test(line) && !/^\s*-?\s*[a-z][a-z0-9-]*:\s*/i.test(line))
      .join('\n');
    rawErrors.push({ stage, type: error.name || 'Error', redactedTrace: message });
    report.failure = { stage, code: 'PUBLISHED_HOST_UI_AUDIT_FAILED', messageHash: hash(message) };
  };
  const read = async (target) => {
    assert.ok(target.startsWith('/api/') && !/[?#\r\n]/.test(target), 'Direct API reads require fixed owned paths');
    const response = await reader.request.get(`${origin.origin}${target}`, { maxRedirects: 0, timeout: 15000 });
    assert.equal(response.status(), 200, 'Owned authenticated GET must return200');
    return response.json();
  };
  const buildExact = async () => {
    const build = await read('/api/system/build');
    assert.ok(
      build.version === expectedTag && build.commit === expectedCommit && build.imageDigest === expectedDigest,
      'Actual build differs from exact release pins',
    );
  };
  const snapshot = async () => {
    const installed = await read('/api/apps/installed');
    assert.ok(Array.isArray(installed.installed), 'Installed records must be available');
    const apps = {};
    for (const item of installed.installed) {
      const urn = item.info?.urn;
      assert.ok(typeof urn === 'string' && urn.includes(':') && !Object.hasOwn(apps, urn), 'Installed app identity must be valid and unique');
      apps[urn] = await read(`/api/apps/${encodeURIComponent(urn)}`);
      assert.ok(apps[urn].info?.urn === urn, 'Full installed record identity differs');
    }
    return { preferences: await read('/api/desktop-preferences'), installed, apps, stores: await read('/api/marketplace/all') };
  };
  const save = () => {
    privateWrite(baselineFile, baseline);
    privateWrite(errorFile, rawErrors);
    privateWrite(reportFile, { ...report, stage });
  };
  try {
    assert.deepEqual(process.argv.slice(2), ['--allow-owned-published-host-devices'], 'Explicit owned published audit argument is required');
    assert.equal(process.env.ORBIS_ALLOW_LIVE_HOST_DEVICES_AUDIT, '1', 'Explicit published audit opt-in is required');
    assert.equal(expectedTag, 'v0.1.0-beta.42', 'Only reviewed beta42 is permitted');
    assert.match(expectedCommit || '', /^9adb1d18[a-f0-9]{32}$/, 'Full reviewed commit pin is required');
    assert.equal(expectedDigest, pinnedDigest, 'Exact reviewed image digest is required');
    assert.equal(process.env.ORBIS_AUDIT_COOKIE_FILE, ownedCookieFile, 'Only the owned private cookie jar is permitted');
    assert.equal(process.env.ORBIS_AUDIT_RELEASE_FILE, releasePath, 'Only the reviewed release manifest is permitted');
    origin = new URL(process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080');
    assert.ok(origin.href === 'http://127.0.0.1:18080/' && !origin.username && !origin.password, 'Only owned loopback18080 is permitted');
    const stat = fs.lstatSync(installRoot);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && fs.realpathSync(installRoot) === installRoot,
      'Owned installation root differs',
    );
    release = parsePrivate(readOwnedInput(releasePath), 'Release manifest');
    assert.ok(
      release.tag === expectedTag && release.commit === expectedCommit && release.image === `ghcr.io/twentylines/orbis@${expectedDigest}`,
      'Release manifest and exact pins differ',
    );
    const cookies = parseCookies(readOwnedInput(ownedCookieFile), origin.hostname);
    cookieValues = cookies.map((cookie) => cookie.value);
    temporaryOutput(output);
    assert.ok(!fs.existsSync(output), 'Use a new private evidence directory');
    privateDirectory(output);
    privateDirectory(screenshots);
    outputReady = true;
    report.release = { tag: expectedTag, commit: expectedCommit, digest: expectedDigest };
    const core = verifyCore(release.image);
    const architecture = parsePrivate(
      readDocker(['inspect', '--type', 'image', '--format', '{{json .Architecture}}', core.imageId]),
      'Owned image architecture',
    );
    assert.equal(architecture, 'arm64', 'The owned running image must be arm64');
    report.coreChecks.push({ ...core, architecture });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    await buildExact();
    assert.equal((await read('/api/user-context')).isLoggedIn, true, 'Owned session must authenticate');
    const appContext = await read('/api/app-context');
    assert.ok(appContext.user?.hasSeenWelcome && appContext.user?.locale === 'en', 'Existing English account onboarding must be complete');
    before = await snapshot();
    baseline.before = before;
    assert.ok(
      before.preferences.mode === 'dark' && before.preferences.preset === 'frost',
      'Existing real Dark/Frost preferences are required; this audit will not change them',
    );
    anonymous = await browser.newContext({ serviceWorkers: 'block' });
    const unauthenticated = await anonymous.request.get(`${origin.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
    assert.equal(unauthenticated.status(), 401, 'Unauthenticated HostDevices GET must return401');
    report.unauthenticatedStatus = unauthenticated.status();
    await anonymous.close();
    anonymous = undefined;
    report.cleanup.anonymousClosed = true;
    stage = 'actual-host-warmup';
    const warmed = await warmup(read);
    report.warmup = { attempts: warmed.attempts, elapsed: warmed.elapsed, counts: counts(warmed.sample), fresh: !warmed.sample.stale };
    baseline.hostSamples.push(warmed.sample);
    save();
    for (const group of groups) {
      stage = `${group.width}x${group.height}-text${group.textScale}`;
      const result = {
        ...group,
        passed: false,
        actualHostReads: 0,
        captures: [],
        cleanup: { textRestored: false, viewportRestored: false, pageClosed: false, routesRestored: false, contextClosed: false },
      };
      report.groups.push(result);
      await buildExact();
      activeContext = await browser.newContext({
        viewport: { width: group.width, height: group.height },
        colorScheme: 'dark',
        serviceWorkers: 'block',
      });
      await activeContext.addCookies(cookies);
      const jobs = [];
      const hostResponses = [];
      let closing = false;
      const failed = (request) => {
        const target = new URL(request.url());
        if (!closing && target.origin === origin.origin && ['document', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType()))
          report.assetFailures.push({
            group: stage,
            path: target.pathname,
            kind: request.resourceType(),
            messageHash: hash(request.failure()?.errorText || 'Asset failed'),
          });
      };
      const responded = (response) => {
        const request = response.request();
        const target = new URL(request.url());
        if (target.origin !== origin.origin) return;
        if (!response.ok() && response.status() !== 304) report.readFailures.push({ group: stage, path: target.pathname, status: response.status() });
        if (target.pathname === endpoint && response.ok())
          jobs.push(
            response
              .json()
              .then((body) => {
                hostResponses.push({ at: Date.now(), body });
                baseline.hostSamples.push(body);
                result.actualHostReads++;
              })
              .catch((error) => {
                if (!closing) report.readFailures.push({ group: stage, path: endpoint, messageHash: hash(error.message) });
              }),
          );
        const kind = request.resourceType();
        if (!response.ok() || !['document', 'script', 'stylesheet', 'image', 'font'].includes(kind)) return;
        jobs.push(
          response
            .body()
            .then((body) => {
              report.assets[`${target.pathname}:${hash(body)}`] = { kind, bytes: body.length, sha256: hash(body) };
            })
            .catch((error) => {
              if (!closing) report.assetFailures.push({ group: stage, path: target.pathname, kind, messageHash: hash(error.message) });
            }),
        );
      };
      const handler = async (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (target.origin !== origin.origin) {
          report.externalRequestsBlocked++;
          return route.abort('blockedbyclient');
        }
        if (
          !readMethods.has(request.method()) ||
          /^\/api\/auth\//.test(target.pathname) ||
          /\/(?:refresh|restart|reboot|shutdown|install|uninstall|logout)(?:\/|$)/.test(target.pathname)
        ) {
          report.blockedMutations.push({ group: stage, method: request.method(), path: target.pathname });
          return route.abort('blockedbyclient');
        }
        if (target.pathname.startsWith('/api/')) report.forwardedReads[target.pathname] = (report.forwardedReads[target.pathname] || 0) + 1;
        if (target.pathname === '/api/sse/app' && !target.search) return route.continue();
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
          if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) {
            report.blockedRedirects.push({ group: stage, path: target.pathname, status: response.status() });
            return route.abort('blockedbyclient');
          }
          const headers = response.headers();
          if (request.resourceType() === 'document')
            headers['content-security-policy'] = headers['content-security-policy']
              ? `${headers['content-security-policy']}, connect-src 'self'`
              : "connect-src 'self'";
          return route.fulfill({ response, headers });
        } catch (error) {
          if (!closing) report.readFailures.push({ group: stage, path: target.pathname, messageHash: hash(error.message) });
          return route.abort('failed').catch(() => undefined);
        }
      };
      activeContext.on('requestfailed', failed);
      activeContext.on('response', responded);
      await activeContext.route('**/*', handler);
      activePage = await activeContext.newPage();
      activePage.on('pageerror', (error) => report.pageErrors.push({ group: stage, type: error.name, messageHash: hash(error.message) }));
      const shot = async (name) => {
        const file = path.join(screenshots, `${stage}-${name}-actual-viewport.png`);
        temporaryOutput(file);
        await activePage.screenshot({ path: file, fullPage: false });
        fs.chmodSync(file, 0o600);
        result.captures.push(path.basename(file));
      };
      try {
        const hostResponse = activePage.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.status() === 200);
        await activePage.goto(`${origin.origin}/monitor`, { waitUntil: 'domcontentloaded' });
        const actual = await (await hostResponse).json();
        assert.ok(actual.available, 'Actual published host telemetry must be available');
        assert.equal(actual.stale, false, 'Actual host sample must stay fresh after warmup');
        await activePage.locator('.desktop[data-desktop-mode="dark"][data-desktop-preset="frost"] .host-device-sections').waitFor();
        await assertActualRows(activePage, actual);
        await dom.settle(activePage);
        await dom.scaleText(activePage, group.textScale);
        const initial = await dom.inspect(activePage);
        dom.check(initial);
        result.counts = counts(actual);
        result.sampleFresh = !actual.stale;
        result.metrics = sanitizedMetrics(initial);
        const expectedIds = [
          ...actual.filesystems.map((item) => item.mount),
          ...actual.network.map((item) => item.interface),
          ...actual.disks.map((item) => item.device),
        ];
        result.identifiers = expectedIds.map((identifier) => ({ sha256: hash(identifier), length: identifier.length }));
        await shot('initial');
        const heading = activePage.locator('#host-devices-title');
        await heading.focus();
        result.headingFocus = await dom.focusMetrics(activePage);
        assert.ok(
          result.headingFocus.top >= result.headingFocus.chromeBottom + 3 && result.headingFocus.bottom <= result.headingFocus.dockTop - 3,
          'Actual Host devices focus must clear chrome',
        );
        const cpu = activePage.getByRole('slider', { name: 'Inspect CPU utilisation history', exact: true });
        const memory = activePage.getByRole('slider', { name: 'Inspect Host memory used history', exact: true });
        if ((await cpu.getAttribute('tabindex')) === '0' && (await memory.getAttribute('tabindex')) === '0') {
          await cpu.focus();
          await activePage.keyboard.press('Tab');
          assert.equal(await memory.evaluate((element) => element === document.activeElement), true, 'Actual native Tab must reach memory history');
          result.nativeTabFocus = await dom.focusMetrics(activePage);
          assert.ok(
            result.nativeTabFocus.top >= result.nativeTabFocus.chromeBottom + 3 && result.nativeTabFocus.bottom <= result.nativeTabFocus.dockTop - 3,
            'Actual native chart focus must clear chrome',
          );
          await heading.focus();
          await dom.focusMetrics(activePage);
        } else result.nativeTabFocus = { omitted: 'Actual history has no selectable samples' };
        await dom.wheelTo(activePage, '.host-devices-heading');
        await shot('heading');
        await dom.wheelTo(activePage, '#host-network-title');
        await shot('network');
        const beforeScroll = await dom.reading(activePage);
        const prior = hostResponses.at(-1);
        assert.ok(prior?.body.available, 'A preceding actual host response is required for polling proof');
        const polled = await activePage.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.status() === 200, {
          timeout: 15000,
        });
        let nextSample = await polled.json();
        let refreshResponses = 1;
        const responseAt = Date.now();
        assert.ok(nextSample.available, 'Actual polled host sample must remain available');
        await dom.settle(activePage);
        const afterScroll = await dom.reading(activePage);
        samePrivate(afterScroll, beforeScroll, 'Actual HostDevices refresh must preserve native reading position exactly');
        assert.equal(nextSample.stale, false, 'Actual polled host readings must remain fresh');
        if (prior?.body.sampledAt === nextSample.sampledAt) {
          const additional = await activePage.waitForResponse(
            (response) => new URL(response.url()).pathname === endpoint && response.status() === 200,
            { timeout: 15000 },
          );
          nextSample = await additional.json();
          refreshResponses++;
          await dom.settle(activePage);
          samePrivate(await dom.reading(activePage), beforeScroll, 'A second actual refresh must preserve reading position');
        }
        assert.ok(
          nextSample.available && !nextSample.stale && prior?.body.sampledAt !== nextSample.sampledAt,
          'Actual sampler must provide a distinct fresh host sample',
        );
        await assertActualRows(activePage, nextSample);
        result.refresh = {
          before: beforeScroll,
          after: afterScroll,
          actualResponse200: true,
          distinctSample: prior?.body.sampledAt !== nextSample.sampledAt,
          actualResponses: refreshResponses,
          intervalFromPriorResponse: prior ? responseAt - prior.at : null,
          passed: true,
        };
        const refreshed = await dom.inspect(activePage);
        dom.check(refreshed);
        result.refreshedMetrics = sanitizedMetrics(refreshed);
        await dom.wheelTo(activePage, '#host-disk-activity-title');
        await shot('disks');
        result.images = await activePage.evaluate(() =>
          [...document.images].map((image) => ({
            visible: Boolean(image.getClientRects().length),
            complete: image.complete,
            loaded: image.naturalWidth > 0,
          })),
        );
        assert.ok(
          result.images.every((image) => !image.visible || (image.complete && image.loaded)),
          'Actual visible images must load',
        );
        assert.equal(await activePage.locator('.orbis-error-panel').count(), 0, 'Published Monitor must not show fallback');
        result.passed = true;
      } catch (error) {
        await shot('failure').catch(() => {
          result.failureCaptureUnavailable = true;
        });
        throw error;
      } finally {
        const attempt = async (key, action) => {
          try {
            await action();
            result.cleanup[key] = true;
          } catch (error) {
            report.cleanupFailures.push(`${stage}:${key}`);
            fail(error);
          }
        };
        await attempt('textRestored', () => dom.restoreText(activePage));
        await attempt('viewportRestored', () => activePage.setViewportSize({ width: group.width, height: group.height }));
        closing = true;
        await Promise.all(jobs);
        await attempt('pageClosed', () => activePage.close());
        activePage = undefined;
        await attempt('routesRestored', () => activeContext.unroute('**/*', handler));
        activeContext.off('requestfailed', failed);
        activeContext.off('response', responded);
        await attempt('contextClosed', () => activeContext.close());
        activeContext = undefined;
        if (result.cleanup.contextClosed) report.cleanup.groupContextsClosed++;
        if (!Object.values(result.cleanup).every(Boolean)) result.passed = false;
        save();
      }
    }
    stage = 'final-records';
    baseline.after = await snapshot();
    samePrivate(baseline.after, before, 'Actual preferences/app/store records changed');
    report.recordsUnchanged = true;
    await buildExact();
    report.coreChecks.push(verifyCore(release.image));
    assert.equal(report.groups.length, 5);
    assert.ok(report.groups.every((group) => group.passed));
    report.passed = true;
  } catch (error) {
    fail(error);
  } finally {
    if (reader && before)
      try {
        baseline.after = await snapshot();
        samePrivate(baseline.after, before, 'Final actual records changed');
        report.recordsUnchanged = true;
      } catch (error) {
        report.recordsUnchanged = false;
        report.cleanupFailures.push('final-record-comparison-failed');
        fail(error);
      }
    if (activePage)
      await activePage.close().catch((error) => {
        report.cleanupFailures.push('active-page-close-failed');
        fail(error);
      });
    if (activeContext)
      await activeContext.close().catch((error) => {
        report.cleanupFailures.push('active-context-close-failed');
        fail(error);
      });
    if (anonymous)
      await anonymous
        .close()
        .then(() => {
          report.cleanup.anonymousClosed = true;
        })
        .catch((error) => {
          report.cleanupFailures.push('anonymous-close-failed');
          fail(error);
        });
    if (reader)
      await reader
        .close()
        .then(() => {
          report.cleanup.readerClosed = true;
        })
        .catch((error) => {
          report.cleanupFailures.push('reader-close-failed');
          fail(error);
        });
    if (browser)
      await browser
        .close()
        .then(() => {
          report.cleanup.browserClosed = true;
        })
        .catch((error) => {
          report.cleanupFailures.push('browser-close-failed');
          fail(error);
        });
    if (
      !report.recordsUnchanged ||
      !report.cleanup.readerClosed ||
      !report.cleanup.anonymousClosed ||
      !report.cleanup.browserClosed ||
      report.cleanup.groupContextsClosed !== 5 ||
      report.cleanupFailures.length ||
      report.blockedMutations.length ||
      report.blockedRedirects.length ||
      report.externalRequestsBlocked ||
      report.readFailures.length ||
      report.assetFailures.length ||
      report.pageErrors.length
    )
      report.passed = false;
    if (outputReady) save();
  }
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, code: report.passed ? 'PUBLISHED_HOST_UI_AUDIT_PASSED' : 'PUBLISHED_HOST_UI_AUDIT_FAILED', groups: report.groups.length, recordsUnchanged: report.recordsUnchanged, browserClosed: report.cleanup.browserClosed, reportFile: outputReady ? reportFile : null })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}
if (require.main === module)
  main().catch(() => {
    process.stderr.write('PUBLISHED_HOST_UI_AUDIT_FAILED\n');
    process.exitCode = 1;
  });
module.exports = { main };
