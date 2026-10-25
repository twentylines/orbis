// Published HostProcesses acceptance uses actual API bodies and requires explicit release pins.
// Actual response bodies are unchanged; no browser mutation is forwarded.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');
const { dom } = require('./host-devices-checks.cjs');
const { dom: processDom } = require('./host-processes-checks.cjs');

const installRoot = (process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install');
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
    assert.equal(stat.mode & 0o077, 0, 'Release manifest must remain private');
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

const endpoint = '/api/system/host-processes';
const releasePath = '/tmp/orbis-beta43-release-check.json';
const pinnedCommit = 'aa7cb6afa15abe5e56075fc4ca2d6a8f5ccc3722';
const groups = [
  { width: 1440, height: 1120, textScale: 1 },
  { width: 768, height: 1024, textScale: 1 },
  { width: 390, height: 844, textScale: 1 },
  { width: 320, height: 800, textScale: 1 },
  { width: 320, height: 800, textScale: 2 },
];
const bytes = (value) => {
  const index = Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
};
const safePath = (value) => (/^\/api\/apps\/(?!installed$)/.test(value) ? `/api/apps/[${hash(value).slice(0, 16)}]` : value);

function counts(sample) {
  assert.ok(sample?.available && Array.isArray(sample.byCpu) && Array.isArray(sample.byMemory), 'Actual process sample must be available');
  for (const field of ['scanned', 'readable', 'unreadable', 'compared'])
    assert.ok(Number.isSafeInteger(sample[field]) && sample[field] >= 0, 'Actual process counts must be nonnegative integers');
  assert.ok(
    sample.scanned <= 8192 && sample.readable <= sample.scanned && sample.compared <= sample.readable,
    'Actual process counts must respect the published bounds',
  );
  assert.equal(sample.byCpu.length, Math.min(20, sample.compared), 'Actual CPU ranking length must match comparable processes');
  assert.equal(sample.byMemory.length, Math.min(20, sample.readable), 'Actual memory ranking length must match readable processes');
  for (const [key, metric] of [
    ['byCpu', 'cpuPercent'],
    ['byMemory', 'memoryBytes'],
  ]) {
    const rows = sample[key];
    const unique = new Set();
    for (const [index, row] of rows.entries()) {
      assert.ok(
        Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid <= 2147483647 && !unique.has(row.pid),
        'Actual process identities must be unique and valid',
      );
      unique.add(row.pid);
      assert.ok(typeof row.name === 'string' && [...row.name].length <= 64 && row.name.length > 0, 'Actual process names must be bounded');
      assert.ok(Number.isSafeInteger(row.memoryBytes) && row.memoryBytes >= 0, 'Actual RSS must be a nonnegative integer');
      assert.ok(row.cpuPercent === null || (Number.isFinite(row.cpuPercent) && row.cpuPercent >= 0), 'Actual CPU readings must be finite or pending');
      if (key === 'byCpu') assert.notEqual(row.cpuPercent, null, 'CPU rank requires a comparable sample');
      if (index)
        assert.ok(
          rows[index - 1][metric] > row[metric] || (rows[index - 1][metric] === row[metric] && rows[index - 1].pid < row.pid),
          'Actual rank must sort metric descending and PID ascending',
        );
    }
  }
  return {
    scanned: sample.scanned,
    readable: sample.readable,
    unreadable: sample.unreadable,
    compared: sample.compared,
    cpuRows: sample.byCpu.length,
    memoryRows: sample.byMemory.length,
    limited: sample.limited,
  };
}

function sanitizedMetrics(metrics) {
  const safe = structuredClone(metrics);
  safe.words = safe.words.map((issue) => ({ wordHash: hash(issue.text), wordLength: issue.text.length, contextHash: hash(issue.context || '') }));
  safe.overflowInk = safe.overflowInk.map(({ text, ...geometry }) => ({ ...geometry, textHash: hash(text), textLength: text.length }));
  safe.notice = safe.notice ? { sha256: hash(safe.notice), length: safe.notice.length } : null;
  for (const row of safe.rows) {
    row.pidHash = hash(String(row.pid));
    delete row.pid;
    row.name = {
      sha256: hash(row.name.text),
      length: [...row.name.text].length,
      titleMatches: row.name.title === row.name.text,
      bdi: row.name.bdi,
      box: row.name.box,
      ellipsis: row.name.ellipsis,
      overflow: row.name.overflow,
      whiteSpace: row.name.whiteSpace,
      textOverflow: row.name.textOverflow,
    };
    for (const fact of row.facts) {
      fact.valueHash = hash(fact.text);
      fact.valueLength = fact.text.length;
      delete fact.text;
    }
  }
  return safe;
}

async function warmup(read) {
  const began = Date.now();
  let attempts = 0;
  do {
    const sample = await read(endpoint);
    attempts++;
    if (sample.available && !sample.stale && sample.compared > 0) return { sample, attempts, elapsed: Date.now() - began };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() - began < 30000);
  throw new Error('Actual process CPU comparisons did not become fresh within the bounded warmup');
}

async function assertRows(page, sample, sort) {
  counts(sample);
  const rows = sort === 'cpuPercent' ? sample.byCpu : sample.byMemory;
  const expected = rows.map((row) => ({
    pid: row.pid,
    name: row.name,
    values: [row.cpuPercent === null ? 'Pending' : `${row.cpuPercent.toFixed(1)}%`, bytes(row.memoryBytes)],
  }));
  await page.waitForFunction(
    (expected) => {
      const rows = [...document.querySelectorAll('.host-process-list > li')];
      return (
        rows.length === expected.length &&
        rows.every(
          (row, index) =>
            Number(row.dataset.processPid) === expected[index].pid &&
            row.querySelector('strong')?.textContent === expected[index].name &&
            [...row.querySelectorAll('dd')].map((value) => value.textContent).join('\n') === expected[index].values.join('\n'),
        )
      );
    },
    expected,
    { timeout: 3500 },
  );
  for (const [index, row] of rows.entries()) {
    const name = page.locator('.host-process-identity strong').nth(index);
    samePrivate(await name.textContent(), row.name, 'Actual accessible process name differs from the API');
    samePrivate(await name.getAttribute('title'), row.name, 'Actual full process title differs from the API');
    assert.equal(await name.locator('bdi').count(), 1, 'Actual name must retain bidirectional isolation');
  }
  return {
    rows: rows.length,
    rankHash: hash(JSON.stringify(rows.map((row) => row.pid))),
    sampleHash: hash(JSON.stringify(sample)),
    exactApiOrderAndValues: true,
    fullAccessibleNames: true,
  };
}

async function latestRows(page, responses, sort) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prior = responses.at(-1);
    assert.ok(prior?.body.available, 'A preceding actual API response is required');
    try {
      const proof = await assertRows(page, prior.body, sort);
      if (responses.at(-1) === prior) return { ...proof, responseAt: prior.at, sampledAt: prior.body.sampledAt };
    } catch (error) {
      if (responses.at(-1) === prior) throw error;
    }
  }
  throw new Error('Actual process ranking changed too frequently to establish rendered correspondence');
}

async function wheelToRow(page) {
  const rows = page.locator('.host-process-list > li');
  const target = rows.nth(Math.min(2, (await rows.count()) - 1));
  for (let attempt = 0; attempt < 40; attempt++) {
    const geometry = await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const frame = element.closest('.desktop-route-window');
      const desktop = frame.dataset.windowNavigation === 'desktop';
      const top = Math.max(
        document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
        desktop ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0,
      );
      const bottom = Math.min(
        document.querySelector('.desktop-dock').getBoundingClientRect().top,
        desktop ? frame.querySelector('.desktop-window-content').getBoundingClientRect().bottom : innerHeight,
      );
      return { top, bottom, targetTop: rect.top, x: Math.min(innerWidth - 50, rect.left + 70), y: Math.min(bottom - 40, top + 100) };
    });
    if (geometry.targetTop >= geometry.top + 16 && geometry.targetTop <= geometry.top + 90) {
      await dom.focusMetrics(page);
      return;
    }
    await page.mouse.move(geometry.x, geometry.y);
    await page.mouse.wheel(0, Math.max(-900, Math.min(900, geometry.targetTop - geometry.top - 24)));
    await page.waitForTimeout(100);
  }
  throw new Error('Actual process row could not be reached with native wheel scrolling');
}

async function main() {
  process.umask(0o077);
  const expectedCommit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
  const expectedDigest = process.env.ORBIS_AUDIT_EXPECTED_DIGEST;
  const output = process.env.ORBIS_AUDIT_OUTPUT_DIR || '/tmp/orbis-live-beta43-host-processes-r1';
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
        'Actual published HTML, JavaScript, stylesheets, images and authenticated GET responses',
        'Actual HostProcesses CPU/memory rows, values and names; existing Dark/Frost preferences',
      ],
      controlled: ['One320px doubled-computed-text group', 'Browser-only same-origin CSP header adjustment; all response bodies unchanged'],
      responseSubstitutions: 0,
      preferenceShadows: 0,
      realWrites: 0,
      captures: 'Private native viewport captures at actual focused/wheel reading positions; no scroll reset',
      privacy: 'Raw process names/PIDs/samples and account baseline remain in0600 private files; public metrics contain hashes',
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
  const baseline = { processSamples: [] };
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
    report.failure = { stage, code: 'PUBLISHED_HOST_PROCESS_UI_AUDIT_FAILED', messageHash: hash(message) };
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
      assert.ok(typeof urn === 'string' && urn.includes(':') && !Object.hasOwn(apps, urn), 'Installed identity must be valid and unique');
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
    assert.deepEqual(process.argv.slice(2), ['--allow-owned-published-host-processes'], 'Explicit owned published audit argument is required');
    assert.equal(process.env.ORBIS_ALLOW_LIVE_HOST_PROCESSES_AUDIT, '1', 'Explicit published process audit opt-in is required');
    assert.equal(expectedTag, 'v0.1.0-beta.43', 'Only reviewed beta43 is permitted');
    assert.equal(expectedCommit, pinnedCommit, 'Exact reviewed full commit is required');
    assert.match(expectedDigest || '', /^sha256:[a-f0-9]{64}$/, 'Exact reviewed published digest is required');
    assert.equal(process.env.ORBIS_AUDIT_COOKIE_FILE, ownedCookieFile, 'Only the owned private cookie jar is permitted');
    assert.equal(process.env.ORBIS_AUDIT_RELEASE_FILE, releasePath, 'Only the reviewed private release manifest is permitted');
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
      'Existing real Dark/Frost preferences required; audit will not change them',
    );
    anonymous = await browser.newContext({ serviceWorkers: 'block' });
    const unauthenticated = await anonymous.request.get(`${origin.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
    assert.equal(unauthenticated.status(), 401, 'Unauthenticated process GET must return401');
    report.unauthenticatedStatus = unauthenticated.status();
    await anonymous.close();
    anonymous = undefined;
    report.cleanup.anonymousClosed = true;
    stage = 'actual-process-warmup';
    const warmed = await warmup(read);
    report.warmup = {
      attempts: warmed.attempts,
      elapsed: warmed.elapsed,
      counts: counts(warmed.sample),
      fresh: !warmed.sample.stale,
      cpuComparisons: true,
    };
    baseline.processSamples.push(warmed.sample);
    save();
    for (const group of groups) {
      stage = `${group.width}x${group.height}-text${group.textScale}`;
      const result = {
        ...group,
        passed: false,
        actualProcessReads: 0,
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
      const responses = [];
      let closing = false;
      const failed = (request) => {
        const target = new URL(request.url());
        if (!closing && target.origin === origin.origin && ['document', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType()))
          report.assetFailures.push({
            group: stage,
            path: safePath(target.pathname),
            kind: request.resourceType(),
            messageHash: hash(request.failure()?.errorText || 'Asset failed'),
          });
      };
      const responded = (response) => {
        const request = response.request();
        const target = new URL(request.url());
        if (target.origin !== origin.origin) return;
        if (!response.ok() && response.status() !== 304)
          report.readFailures.push({ group: stage, path: safePath(target.pathname), status: response.status() });
        if (target.pathname === endpoint && response.ok())
          jobs.push(
            response
              .json()
              .then((body) => {
                responses.push({ at: Date.now(), body });
                baseline.processSamples.push(body);
                result.actualProcessReads++;
              })
              .catch((error) => {
                if (!closing) report.readFailures.push({ group: stage, path: endpoint, messageHash: hash(error.message) });
              }),
          );
        const kind = request.resourceType();
        if (response.ok() && ['document', 'script', 'stylesheet', 'image', 'font'].includes(kind))
          jobs.push(
            response
              .body()
              .then((body) => {
                report.assets[`${safePath(target.pathname)}:${hash(body)}`] = { kind, bytes: body.length, sha256: hash(body) };
              })
              .catch((error) => {
                if (!closing) report.assetFailures.push({ group: stage, path: safePath(target.pathname), kind, messageHash: hash(error.message) });
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
          report.blockedMutations.push({ group: stage, method: request.method(), path: safePath(target.pathname) });
          return route.abort('blockedbyclient');
        }
        if (target.pathname.startsWith('/api/'))
          report.forwardedReads[safePath(target.pathname)] = (report.forwardedReads[safePath(target.pathname)] || 0) + 1;
        if (target.pathname === '/api/sse/app' && !target.search) return route.continue();
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
          if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) {
            report.blockedRedirects.push({ group: stage, path: safePath(target.pathname), status: response.status() });
            return route.abort('blockedbyclient');
          }
          const headers = response.headers();
          if (request.resourceType() === 'document')
            headers['content-security-policy'] = headers['content-security-policy']
              ? `${headers['content-security-policy']}, connect-src 'self'`
              : "connect-src 'self'";
          return route.fulfill({ response, headers });
        } catch (error) {
          if (!closing) report.readFailures.push({ group: stage, path: safePath(target.pathname), messageHash: hash(error.message) });
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
      const rank = (name) => activePage.getByRole('group', { name: 'Rank host processes by' }).getByRole('button', { name, exact: true });
      const focusClear = async () => {
        const metrics = await dom.focusMetrics(activePage);
        assert.ok(metrics.top >= metrics.chromeBottom + 3 && metrics.bottom <= metrics.dockTop - 3, 'Actual native focus must clear chrome');
        assert.ok(!metrics.outline.startsWith('0px') || metrics.shadow !== 'none', 'Actual focus must have a visible marker');
        const { text, ...publicFocus } = metrics;
        return { ...publicFocus, textHash: hash(text), textLength: text.length };
      };
      try {
        const initialResponse = activePage.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.status() === 200);
        void initialResponse.catch(() => undefined);
        await activePage.goto(`${origin.origin}/monitor`, { waitUntil: 'domcontentloaded' });
        const initialSample = await (await initialResponse).json();
        counts(initialSample);
        assert.ok(!initialSample.stale && initialSample.compared > 0, 'Actual published CPU comparisons must stay fresh after warmup');
        await activePage.locator('.desktop[data-desktop-mode="dark"][data-desktop-preset="frost"] .host-processes').waitFor();
        await Promise.all(jobs);
        result.cpu = await latestRows(activePage, responses, 'cpuPercent');
        await dom.settle(activePage);
        await dom.scaleText(activePage, group.textScale);
        const initial = await processDom.inspect(activePage);
        processDom.check(initial);
        result.initialMetrics = sanitizedMetrics(initial);
        result.counts = counts(initialSample);
        await shot('initial');
        await rank('CPU').focus();
        await activePage.keyboard.press('Tab');
        assert.equal(await rank('Memory').evaluate((element) => element === document.activeElement), true, 'Actual native Tab reaches Memory');
        result.nativeTabFocus = await focusClear();
        await activePage.keyboard.press('Space');
        await activePage.waitForFunction(() => document.querySelectorAll('.host-processes-sort button')[1]?.getAttribute('aria-pressed') === 'true');
        await Promise.all(jobs);
        result.memory = await latestRows(activePage, responses, 'memoryBytes');
        const memoryMetrics = await processDom.inspect(activePage);
        processDom.check(memoryMetrics);
        result.memoryMetrics = sanitizedMetrics(memoryMetrics);
        await wheelToRow(activePage);
        await shot('memory');
        await activePage.keyboard.press('Shift+Tab');
        assert.equal(await rank('CPU').evaluate((element) => element === document.activeElement), true, 'Actual reverse Tab returns to CPU');
        await activePage.keyboard.press('Enter');
        await activePage.waitForFunction(() => document.querySelectorAll('.host-processes-sort button')[0]?.getAttribute('aria-pressed') === 'true');
        await Promise.all(jobs);
        result.cpuRestored = await latestRows(activePage, responses, 'cpuPercent');
        await activePage.keyboard.press('Tab');
        assert.equal(await rank('Memory').evaluate((element) => element === document.activeElement), true);
        await focusClear();
        await wheelToRow(activePage);
        await shot('cpu-reading');
        const beforeScroll = await dom.reading(activePage);
        const prior = responses.at(-1);
        assert.ok(prior?.body.available, 'Preceding actual process response required for polling proof');
        result.refresh = { before: beforeScroll, checkpoints: [], passed: false };
        let distinct = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          const previous = responses.at(-1);
          const nextResponse = await activePage.waitForResponse(
            (response) => new URL(response.url()).pathname === endpoint && response.status() === 200,
            { timeout: 15000 },
          );
          const nextSample = await nextResponse.json();
          const receivedAt = Date.now();
          counts(nextSample);
          const receiptInterval = receivedAt - previous.at;
          assert.ok(receiptInterval >= 9000 && receiptInterval <= 12500, 'Actual process polling must use the10-second ready cadence');
          assert.ok(!nextSample.stale && nextSample.compared > 0, 'Actual process refresh must remain fresh and comparable');
          await dom.settle(activePage);
          await Promise.all(jobs);
          const afterScroll = await dom.reading(activePage);
          samePrivate(afterScroll, beforeScroll, 'Actual ranking refresh must preserve exact reading position');
          assert.equal(
            await rank('Memory').evaluate((element) => element === document.activeElement),
            true,
            'Actual refresh preserves the focused sort control',
          );
          const proof = await latestRows(activePage, responses, 'cpuPercent');
          const metrics = await processDom.inspect(activePage);
          processDom.check(metrics);
          result.refresh.checkpoints.push({
            actualResponse200: true,
            intervalFromPriorReceipt: receiptInterval,
            before: beforeScroll,
            after: afterScroll,
            proof,
            metrics: sanitizedMetrics(metrics),
          });
          distinct = nextSample.sampledAt !== prior.body.sampledAt;
          if (distinct) break;
        }
        assert.ok(distinct, 'Actual sampler must provide a distinct sample within two10-second polls');
        result.refresh.distinctSample = distinct;
        result.refresh.passed = true;
        await shot('cpu-refreshed');
        result.images = await activePage.evaluate(() =>
          [...document.images].map((image) => ({
            visible: Boolean(image.getClientRects().length),
            complete: image.complete,
            loaded: image.naturalWidth > 0,
          })),
        );
        assert.ok(
          result.images.every((image) => !image.visible || (image.complete && image.loaded)),
          'All actual visible images must load',
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
    const afterCore = verifyCore(release.image);
    report.coreChecks.push(afterCore);
    assert.equal(afterCore.imageId, report.coreChecks[0].imageId, 'Actual image identity changed during audit');
    assert.equal(afterCore.idHash, report.coreChecks[0].idHash, 'Actual core container identity changed during audit');
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
    `${JSON.stringify({ passed: report.passed, code: report.passed ? 'PUBLISHED_HOST_PROCESS_UI_AUDIT_PASSED' : 'PUBLISHED_HOST_PROCESS_UI_AUDIT_FAILED', groups: report.groups.length, recordsUnchanged: report.recordsUnchanged, browserClosed: report.cleanup.browserClosed, reportFile: outputReady ? reportFile : null })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}
if (require.main === module)
  main().catch(() => {
    process.stderr.write('PUBLISHED_HOST_PROCESS_UI_AUDIT_FAILED\n');
    process.exitCode = 1;
  });
module.exports = { main };
