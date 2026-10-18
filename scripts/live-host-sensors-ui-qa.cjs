// Actual published Hardware sensors acceptance; every response body remains unchanged.
// Explicit pins, protected input proofs and owned loopback runtime are required before any browser starts.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');
const { dom } = require('./host-devices-checks.cjs');
const { dom: sensorDom } = require('./host-sensors-checks.cjs');

const installRoot = '/Users/sai/.codex/tmp/orbis-stock-20261015';
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

async function restoreText(page) {
  await page.evaluate(() => {
    const state = window.__orbisHostSensorsTextScale;
    if (!state) return;
    state.observer.disconnect();
    for (const [element, value] of state.entries)
      for (const [name, original, priority] of value.original) {
        if (original) element.style.setProperty(name, original, priority);
        else element.style.removeProperty(name);
      }
    delete window.__orbisHostSensorsTextScale;
  });
}

async function scaleText(page, factor) {
  await restoreText(page);
  if (factor === 1) return;
  await page.evaluate((factor) => {
    const entries = new Map();
    const suitable = (element) => element instanceof HTMLElement && !element.matches('script,style,link,meta');
    const remember = (elements) => {
      const values = elements.map((element) => {
        const style = getComputedStyle(element);
        return [
          element,
          {
            font: Number.parseFloat(style.fontSize),
            line: style.lineHeight,
            original: ['font-size', 'line-height'].map((name) => [
              name,
              element.style.getPropertyValue(name),
              element.style.getPropertyPriority(name),
            ]),
          },
        ];
      });
      for (const [element, value] of values) entries.set(element, value);
    };
    const apply = () => {
      for (const [element, value] of entries)
        if (element.isConnected) {
          if (Number.isFinite(value.font)) element.style.setProperty('font-size', `${value.font * factor}px`, 'important');
          if (value.line !== 'normal') element.style.setProperty('line-height', `${Number.parseFloat(value.line) * factor}px`, 'important');
        }
    };
    remember([...document.querySelectorAll('body,body *')].filter(suitable));
    apply();
    const observer = new MutationObserver((records) => {
      const added = new Set();
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (suitable(node) && node.isConnected && !entries.has(node)) added.add(node);
          for (const child of node.querySelectorAll('*')) if (suitable(child) && child.isConnected && !entries.has(child)) added.add(child);
        }
      if (!added.size) return;
      observer.disconnect();
      try {
        const pending = [...added];
        const roots = pending.filter((element) => {
          for (let parent = element.parentElement; parent; parent = parent.parentElement) if (added.has(parent)) return false;
          return true;
        });
        for (const root of roots) {
          const wrapper = document.createElement('div');
          wrapper.style.cssText = `position:fixed;left:-100000px;top:0;width:${innerWidth}px;visibility:hidden;pointer-events:none;contain:layout style paint;`;
          const chain = [];
          for (let ancestor = root.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement)
            chain.unshift(ancestor);
          let destination = wrapper;
          const restoreClone = (source, target) => {
            const value = entries.get(source);
            if (value)
              for (const [name, original, priority] of value.original) {
                if (original) target.style.setProperty(name, original, priority);
                else target.style.removeProperty(name);
              }
          };
          for (const ancestor of chain) {
            const copy = ancestor.cloneNode(false);
            restoreClone(ancestor, copy);
            destination.append(copy);
            destination = copy;
          }
          const subtree = root.cloneNode(true);
          const originalElements = [root, ...root.querySelectorAll('*')];
          const copyElements = [subtree, ...subtree.querySelectorAll('*')];
          for (const [index, source] of originalElements.entries()) if (source instanceof HTMLElement) restoreClone(source, copyElements[index]);
          destination.append(subtree);
          document.body.append(wrapper);
          try {
            for (const [index, element] of originalElements.entries())
              if (added.has(element)) {
                const style = getComputedStyle(copyElements[index]);
                entries.set(element, {
                  font: Number.parseFloat(style.fontSize),
                  line: style.lineHeight,
                  original: ['font-size', 'line-height'].map((name) => [
                    name,
                    element.style.getPropertyValue(name),
                    element.style.getPropertyPriority(name),
                  ]),
                });
              }
          } finally {
            wrapper.remove();
          }
        }
        for (const element of added) {
          const value = entries.get(element);
          if (Number.isFinite(value.font)) element.style.setProperty('font-size', `${value.font * factor}px`, 'important');
          if (value.line !== 'normal') element.style.setProperty('line-height', `${Number.parseFloat(value.line) * factor}px`, 'important');
        }
      } finally {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__orbisHostSensorsTextScale = { factor, entries, observer };
  }, factor);
  await dom.settle(page);
}

const endpoint = '/api/system/host-sensors';
const releasePath = '/tmp/orbis-beta46-release-check.json';
const baselinePath = '/tmp/orbis-beta46-before-records.json';
const helperProofPath = '/tmp/orbis-beta46-installed-sensors-proof.json';
const reviewedCommit = '762d7e0b5042e3993bb25fc65c3cff763be9579f';
const reviewedHelperHashes = {
  'orbis-host-service.py': '838986928ac7a9f98482adfd2d4fc2429cab018bda7616eb173b9ca2f25a6ac5',
  'orbis-host-sensors.py': '5b2455a30a22f401f732f9cfa2eaba431e53d8eb2b3391a812fb1f8d4dad9bed',
};
const groups = [
  { width: 1440, height: 1120, textScale: 1, poll: true },
  { width: 768, height: 1024, textScale: 1 },
  { width: 390, height: 844, textScale: 1 },
  { width: 320, height: 800, textScale: 1 },
  { width: 320, height: 800, textScale: 2 },
];
const publicPaths = new Set([
  '/api/user-context',
  '/api/app-context',
  '/api/desktop-preferences',
  '/api/apps/installed',
  '/api/marketplace/all',
  '/api/system/build',
  '/api/system/history',
  '/api/system/host-history',
  '/api/system/host-telemetry',
  '/api/system/host-processes',
  endpoint,
  '/api/system/containers',
  '/api/sse/app',
  '/',
  '/monitor',
  '/favicon.ico',
]);
const safePath = (value) => (publicPaths.has(value) || value.startsWith('/assets/') ? value : `/[${hash(value).slice(0, 16)}]`);
function sanitized(value, key = '') {
  if (typeof value === 'string' && ['text', 'title', 'context', 'accessibleName'].includes(key)) return { sha256: hash(value), length: value.length };
  if (Array.isArray(value)) return value.map((item) => sanitized(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitized(item, name)]));
  return value;
}
function options(env, argv) {
  assert.deepEqual(argv, ['--allow-owned-published-host-sensors'], 'Explicit owned published sensor audit argument is required');
  assert.equal(env.ORBIS_ALLOW_LIVE_HOST_SENSORS_AUDIT, '1', 'Explicit published sensor audit opt-in is required');
  assert.equal(env.ORBIS_AUDIT_EXPECTED_TAG, 'v0.1.0-beta.46', 'Only reviewed beta46 is permitted');
  assert.equal(env.ORBIS_AUDIT_EXPECTED_COMMIT, reviewedCommit, 'Only the reviewed full beta46 commit is permitted');
  assert.match(env.ORBIS_AUDIT_EXPECTED_DIGEST || '', /^sha256:[a-f0-9]{64}$/, 'Exact reviewed published digest is required');
  assert.equal(env.ORBIS_AUDIT_COOKIE_FILE, ownedCookieFile, 'Only the owned private cookie jar is permitted');
  assert.equal(env.ORBIS_AUDIT_RELEASE_FILE, releasePath, 'Only the reviewed private release manifest is permitted');
  assert.equal(env.ORBIS_AUDIT_BASELINE_FILE, baselinePath, 'Only the reviewed prior-record baseline is permitted');
  assert.equal(env.ORBIS_AUDIT_HELPER_PROOF_FILE, helperProofPath, 'Only the reviewed installed-helper proof is permitted');
  const origin = new URL(env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080');
  assert.equal(origin.href, 'http://127.0.0.1:18080/', 'Only owned loopback18080 is permitted');
  assert.ok(!origin.username && !origin.password, 'Origin must not contain credentials');
  const output = env.ORBIS_AUDIT_OUTPUT_DIR || '';
  assert.ok(
    output.startsWith('/tmp/') && path.isAbsolute(output) && path.resolve(output) === output,
    'Explicit normalized fresh /tmp output is required',
  );
  return { origin, output, expectedDigest: env.ORBIS_AUDIT_EXPECTED_DIGEST, expectedCommit: reviewedCommit };
}
function proofInputs(release, prior, helper, digest) {
  assert.ok(
    release.tag === 'v0.1.0-beta.46' && release.commit === reviewedCommit && release.image === `ghcr.io/twentylines/orbis@${digest}`,
    'Release manifest differs from exact pins',
  );
  assert.equal(prior.matchedPriorBeta45Records, true, 'Prior records must be independently matched to beta45');
  assert.ok(
    prior.records &&
      ['preferences', 'installed', 'apps', 'stores'].every((name) => Object.hasOwn(prior.records, name)) &&
      Object.hasOwn(prior, 'tasks'),
    'Complete prior record baseline is required',
  );
  for (const name of [
    'passed',
    'installedHelperVerified',
    'coreSocketReadMatchesHost',
    'existingTelemetryAndProcessesAvailable',
    'privateScriptDirectoryAndSocketModes',
    'serviceActive',
  ])
    assert.equal(helper[name], true, 'Independent installed-helper proof is incomplete');
  assert.equal(helper.macDockerContext, dockerContext, 'Independent proof must identify the owned Docker context');
  assert.equal(helper.unchangedCore?.image, release.image, 'Independent helper proof must be bound to the current image');
  assert.equal(helper.actualNumericHardwareRows, 0, 'This reviewed VM exposes no numeric hardware rows');
  samePrivate(
    helper.exposedKernelIdentitiesMatched,
    { temperatures: 0, fans: 0, gpus: 0 },
    'Independent actual kernel enumeration must match all empty sensor lists',
  );
  samePrivate(helper.sourceSha256, reviewedHelperHashes, 'Independent installed-helper hashes differ');
}
function validateEmpty(body) {
  assert.equal(body?.available, true, 'Actual sensor collector must be available');
  assert.ok(Number.isFinite(Date.parse(body.sampledAt)), 'Actual sample must carry a valid timestamp');
  assert.equal(body.stale, false, 'Actual sample must be fresh');
  for (const name of ['temperatures', 'fans', 'gpus']) {
    assert.ok(Array.isArray(body[name]), 'Actual sensor list must be an array');
    assert.equal(body[name].length, 0, 'Actual list differs from independent zero-hardware kernel enumeration');
  }
  samePrivate(body.omitted, { temperatures: 0, fans: 0, gpus: 0 }, 'Actual empty sample has no omitted hardware');
  samePrivate(body.unavailable, [], 'True empty sample must not conceal a failed hardware group');
  assert.equal(body.limited, false, 'True empty sample must not conceal a limited scan');
  assert.equal(body.unreadable, 0, 'True empty sample must not conceal unreadable attributes');
  return {
    available: true,
    sampledAt: body.sampledAt,
    stale: false,
    counts: { temperatures: 0, fans: 0, gpus: 0 },
    responseHash: hash(JSON.stringify(body)),
  };
}
async function warmup(read) {
  const began = Date.now();
  let attempts = 0;
  do {
    const body = await read(endpoint);
    attempts++;
    if (body.available && !body.stale) return { body, attempts, elapsed: Date.now() - began, proof: validateEmpty(body) };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() - began < 45000);
  throw new Error('Actual sensor sample did not become fresh during bounded warmup');
}
async function renderedEmpty(page) {
  await page.locator('.host-sensors-empty').waitFor();
  assert.equal(await page.locator('.host-sensors-empty').textContent(), 'This host exposes no temperature sensors, fans or GPUs.');
  assert.equal(
    await page.locator('.host-sensor-card,.host-sensor-groups,.host-sensors-notice,.host-sensors-stale').count(),
    0,
    'Actual true-empty state must not invent cards, readings or failures',
  );
  assert.equal(await page.locator('.host-sensors-state').textContent(), 'Updates every 30 seconds');
  assert.equal(await page.locator('#host-sensors-title').textContent(), 'Hardware sensors');
}
async function geometry(page, selector = '.host-sensors-about summary') {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await dom.settle(page);
  return page.locator(selector).evaluate((element) => {
    const frame = element.closest('.desktop-route-window');
    const content = frame.querySelector('.desktop-window-content');
    const desktop = frame.dataset.windowNavigation === 'desktop';
    const box = (target) => {
      const r = target.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
    };
    const rectangle = box(element);
    const style = getComputedStyle(element);
    const extent = style.outlineStyle === 'none' ? 0 : Number.parseFloat(style.outlineWidth) + Math.max(0, Number.parseFloat(style.outlineOffset));
    return {
      active: element === document.activeElement,
      box: rectangle,
      extent,
      focusTop: rectangle.top - extent,
      focusBottom: rectangle.bottom + extent,
      clip: {
        top: Math.max(
          document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
          desktop ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0,
        ),
        bottom: Math.min(
          document.querySelector('.desktop-dock').getBoundingClientRect().top,
          desktop ? content.getBoundingClientRect().bottom : innerHeight,
        ),
      },
      scroll: { x: scrollX, y: scrollY, frame: frame.scrollTop, content: content.scrollTop },
      scrollHeights: { document: document.scrollingElement.scrollHeight, frame: frame.scrollHeight, content: content.scrollHeight },
      root: box(document.querySelector('.host-sensors')),
      navigation: frame.dataset.windowNavigation,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(Number.parseFloat),
      glyph: element.querySelector('svg') ? box(element.querySelector('svg')) : null,
      lines: (() => {
        const range = document.createRange();
        range.selectNodeContents(element.querySelector('span') || element);
        return [...range.getClientRects()]
          .filter((r) => r.width && r.height)
          .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
      })(),
    };
  });
}
function fullVisible(value, focused = false) {
  if (focused) {
    assert.equal(value.active, true, 'Expected native control must retain focus');
    assert.ok(value.extent > 0, 'Native focus must have a painted outline');
  }
  assert.ok(
    value.focusTop >= value.clip.top && value.focusBottom <= value.clip.bottom,
    'Complete control/focus marker must remain inside physical clipping bounds',
  );
  assert.ok(value.focusTop >= value.clip.top + 3 && value.focusBottom <= value.clip.bottom - 3, 'Complete focus marker must have chrome clearance');
}
async function wheelVisible(page, selector) {
  for (let attempt = 0; attempt < 65; attempt++) {
    const value = await geometry(page, selector);
    const top = value.clip.top + 16;
    const bottom = value.clip.bottom - 16;
    assert.ok(value.box.height <= bottom - top, 'Requested fitting capture/control must fit the actual viewport');
    if (value.box.top >= top && value.box.bottom <= bottom) return value;
    const delta = value.box.top < top ? value.box.top - top : value.box.bottom - bottom;
    await page.mouse.move(Math.min((await page.viewportSize()).width - 40, value.box.left + 40), Math.min(bottom - 30, top + 80));
    await page.mouse.wheel(0, Math.max(-900, Math.min(900, delta)));
    await page.waitForTimeout(90);
  }
  throw new Error('Native wheel could not reveal fitting sensor control/state');
}
async function about(page, shot) {
  const selector = '.host-sensors-about summary';
  const summary = page.locator(selector);
  await wheelVisible(page, selector);
  await page.locator('#host-sensors-title').focus({ preventScroll: true });
  await page.keyboard.press('Tab');
  assert.equal(await summary.evaluate((element) => element === document.activeElement), true, 'Native Tab must reach About from sensor heading');
  const focused = await geometry(page);
  fullVisible(focused, true);
  assert.ok(
    focused.padding[0] >= 8 && focused.padding[2] >= 8 && focused.padding[1] >= 12 && focused.padding[3] >= 12,
    'About control keeps comfortable padding',
  );
  for (const line of focused.lines) {
    assert.ok(Math.abs(line.left - focused.lines[0].left) <= 0.5, 'Wrapped About label lines share a left edge');
    assert.ok(line.left >= focused.glyph.right + 8 && line.right <= focused.box.right - 12, 'About label clears glyph and edge');
  }
  await summary.locator('span').click();
  assert.equal(await summary.locator('..').getAttribute('open'), '', 'Actual About label click opens native details');
  await page.keyboard.press('Space');
  assert.equal(await summary.locator('..').getAttribute('open'), null, 'Native Space closes details');
  await page.keyboard.press('Space');
  await wheelVisible(page, '.host-sensors-about p:last-child');
  const finalParagraph = await geometry(page, '.host-sensors-about p:last-child');
  fullVisible(finalParagraph);
  await shot('about-reading');
  const metrics = await sensorDom.inspect(page);
  sensorDom.check(metrics);
  await wheelVisible(page, selector);
  await summary.click();
  assert.equal(await summary.locator('..').getAttribute('open'), null);
  await wheelVisible(page, selector);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const closed = await geometry(page);
  fullVisible(closed, true);
  await shot('about-focused');
  return { nativeTab: true, labelClickOpens: true, nativeSpaceCloses: true, openedText: sanitized(metrics), focused, closed, finalParagraph };
}
async function main() {
  process.umask(0o077);
  const report = {
    passed: false,
    release: null,
    groups: [],
    assets: {},
    directReads: {},
    forwardedReads: {},
    coreChecks: [],
    blockedMutations: [],
    blockedRedirects: [],
    externalRequestsBlocked: 0,
    readFailures: [],
    assetFailures: [],
    pageErrors: [],
    recordsUnchanged: false,
    matchedPriorBeta45Records: false,
    cleanupFailures: [],
    cleanup: { groupContextsClosed: 0, readerClosed: false, anonymousClosed: false, browserClosed: false },
    scope: {
      live: 'Actual published HTML/assets, unchanged authenticated GET bodies and existing Dark/Frost preferences; actual VM empty sensor lists matched to independent kernel proof.',
      controlled:
        'OS dark media setting, one320 doubled-computed-text group, browser-only document CSP connect-src adjustment. No response-body or preference substitutions.',
      numericHardwareReadingsVerified: false,
      sourceFixtureMatricesRepeated: false,
      realWrites: 0,
      screenshots: 'Actual native viewport at natural wheel/native focus position; no scroll reset.',
    },
  };
  const baseline = { sensorSamples: [] };
  const errors = [];
  let config;
  let release;
  let cookieValues = [];
  let outputReady = false;
  let browser;
  let reader;
  let anonymous;
  let activeContext;
  let activePage;
  let before;
  let stage = 'preflight';
  const fail = (error) => {
    let message = String(error.stack || error.message || error);
    for (const value of cookieValues) message = message.replaceAll(value, '[private]');
    message = message
      .split('\n')
      .filter((line) => !/\b(?:cookie|authorization|headers)\b/i.test(line) && !/^\s*-?\s*[a-z][a-z0-9-]*:\s*/i.test(line))
      .join('\n');
    errors.push({ stage, type: error.name || 'Error', redactedTrace: message });
    report.failure = { stage, code: 'PUBLISHED_HOST_SENSORS_UI_AUDIT_FAILED', messageHash: hash(message) };
  };
  const save = () => {
    if (!outputReady) return;
    privateWrite(path.join(config.output, 'private-baseline.json'), baseline);
    privateWrite(path.join(config.output, 'private-errors.json'), errors);
    privateWrite(path.join(config.output, 'report.json'), { ...report, stage });
  };
  const read = async (target) => {
    const address = new URL(target, config.origin);
    assert.ok(
      target.startsWith('/api/') && address.origin === config.origin.origin && !address.search && !address.hash && !/[\r\n]/.test(target),
      'Direct reads require fixed owned API paths',
    );
    assert.ok(
      [endpoint, '/api/user-context', '/api/app-context', '/api/system/build', '/api/desktop-preferences', '/api/marketplace/all'].includes(
        address.pathname,
      ) || /^\/api\/apps\/[^/]+$/.test(address.pathname),
      'Only reviewed read endpoints are permitted',
    );
    const response = await reader.request.get(address.href, { maxRedirects: 0, timeout: 15000 });
    report.directReads[safePath(address.pathname)] = (report.directReads[safePath(address.pathname)] || 0) + 1;
    if (response.status() !== 200) report.readFailures.push({ source: 'direct', path: safePath(address.pathname), status: response.status() });
    assert.equal(response.status(), 200, 'Actual authenticated GET must return200');
    return response.json();
  };
  const buildExact = async () => {
    const build = await read('/api/system/build');
    assert.ok(
      build.version === expectedTag && build.commit === config.expectedCommit && build.imageDigest === config.expectedDigest,
      'Actual build differs from exact published release pins',
    );
  };
  const snapshot = async () => {
    const installed = await read('/api/apps/installed');
    assert.ok(Array.isArray(installed.installed), 'Full installed records must be available');
    const apps = {};
    for (const item of installed.installed) {
      const urn = item.info?.urn;
      assert.ok(typeof urn === 'string' && urn.includes(':') && !Object.hasOwn(apps, urn), 'Installed identity must be valid and unique');
      apps[urn] = await read(`/api/apps/${encodeURIComponent(urn)}`);
      assert.equal(apps[urn].info?.urn, urn, 'Full installed record identity differs');
    }
    return { preferences: await read('/api/desktop-preferences'), installed, apps, stores: await read('/api/marketplace/all') };
  };
  try {
    config = options(process.env, process.argv.slice(2));
    const rootStat = fs.lstatSync(installRoot);
    assert.ok(
      rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === process.getuid() && fs.realpathSync(installRoot) === installRoot,
      'Owned installation root differs',
    );
    const releaseText = readOwnedInput(releasePath);
    const priorText = readOwnedInput(baselinePath);
    const helperText = readOwnedInput(helperProofPath);
    release = parsePrivate(releaseText, 'Release manifest');
    const prior = parsePrivate(priorText, 'Prior API record baseline');
    const helper = parsePrivate(helperText, 'Independent installed-helper proof');
    proofInputs(release, prior, helper, config.expectedDigest);
    const cookies = parseCookies(readOwnedInput(ownedCookieFile), config.origin.hostname);
    cookieValues = cookies.map((cookie) => cookie.value);
    temporaryOutput(config.output);
    assert.ok(!fs.existsSync(config.output), 'Use a fresh private output directory');
    privateDirectory(config.output);
    privateDirectory(path.join(config.output, 'screenshots'));
    outputReady = true;
    report.release = { tag: expectedTag, commit: config.expectedCommit, digest: config.expectedDigest };
    report.inputProofs = {
      releaseSha256: hash(releaseText),
      priorRecordsSha256: hash(priorText),
      installedProofSha256: hash(helperText),
      independentKernelCounts: helper.exposedKernelIdentitiesMatched,
      helperSourceSha256: reviewedHelperHashes,
    };
    report.execution = {
      runnerSha256: hash(fs.readFileSync(__filename)),
      pureSensorInspectorSha256: hash(fs.readFileSync(require.resolve('./host-sensors-checks.cjs'))),
      pureBrowserUtilitiesSha256: hash(fs.readFileSync(require.resolve('./host-devices-checks.cjs'))),
    };
    const core = verifyCore(release.image);
    const architecture = parsePrivate(
      readDocker(['inspect', '--type', 'image', '--format', '{{json .Architecture}}', core.imageId]),
      'Owned image architecture',
    );
    assert.equal(architecture, 'arm64', 'Owned published image must be arm64');
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
    assert.ok(appContext.user?.hasSeenWelcome && appContext.user?.locale === 'en', 'Existing English account must have completed onboarding');
    before = await snapshot();
    baseline.before = before;
    samePrivate(before, prior.records, 'Actual post-OTA records differ from the reviewed prior beta45 records');
    report.matchedPriorBeta45Records = true;
    assert.ok(
      before.preferences.mode === 'dark' && before.preferences.preset === 'frost',
      'Only the existing actual Dark/Frost appearance is audited; no preference edits are permitted',
    );
    anonymous = await browser.newContext({ serviceWorkers: 'block' });
    const unauthenticated = await anonymous.request.get(`${config.origin.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
    assert.equal(unauthenticated.status(), 401, 'Actual anonymous sensor GET must return401');
    report.unauthenticatedStatus = unauthenticated.status();
    await anonymous.close();
    anonymous = undefined;
    report.cleanup.anonymousClosed = true;
    stage = 'actual-sensor-warmup';
    const warmed = await warmup(read);
    baseline.sensorSamples.push(warmed.body);
    report.warmup = { attempts: warmed.attempts, elapsed: warmed.elapsed, actualSample: warmed.proof };
    save();
    for (const group of groups) {
      stage = `${group.width}x${group.height}-text${group.textScale}`;
      const result = {
        ...group,
        passed: false,
        actualSensorReads: 0,
        captures: [],
        cleanup: {
          textRestored: false,
          viewportRestored: false,
          pageClosed: false,
          routesRestored: false,
          listenersRestored: false,
          contextClosed: false,
        },
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
        if (
          !closing &&
          target.origin === config.origin.origin &&
          ['document', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType())
        )
          report.assetFailures.push({
            group: stage,
            path: safePath(target.pathname),
            kind: request.resourceType(),
            messageHash: hash(request.failure()?.errorText || 'Asset failed'),
          });
      };
      const responded = (response) => {
        const request = response.request();
        const target = new URL(response.url());
        if (target.origin !== config.origin.origin) return;
        if (!response.ok() && response.status() !== 304)
          report.readFailures.push({ group: stage, path: safePath(target.pathname), status: response.status() });
        if (target.pathname === endpoint && response.ok())
          jobs.push(
            response
              .json()
              .then((body) => {
                responses.push({ at: Date.now(), body });
                baseline.sensorSamples.push(body);
                result.actualSensorReads++;
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
                const sha256 = hash(body);
                report.assets[`${safePath(target.pathname)}:${sha256}`] = { kind, bytes: body.length, sha256 };
              })
              .catch((error) => {
                if (!closing) report.assetFailures.push({ group: stage, path: safePath(target.pathname), kind, messageHash: hash(error.message) });
              }),
          );
      };
      const handler = async (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (target.origin !== config.origin.origin) {
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
      const pageError = (error) => report.pageErrors.push({ group: stage, type: error.name, messageHash: hash(error.message) });
      activePage.on('pageerror', pageError);
      const shot = async (name) => {
        const file = path.join(config.output, 'screenshots', `${stage}-${name}-actual-viewport.png`);
        temporaryOutput(file);
        await activePage.screenshot({ path: file, fullPage: false });
        fs.chmodSync(file, 0o600);
        result.captures.push(path.basename(file));
      };
      try {
        await activePage.goto(`${config.origin.origin}/monitor`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await renderedEmpty(activePage);
        await dom.settle(activePage);
        await Promise.all(jobs);
        assert.ok(responses.length > 0, 'Published component must read the actual sensor endpoint');
        result.actualSample = validateEmpty(responses.at(-1).body);
        await activePage.locator('.desktop[data-desktop-mode="dark"][data-desktop-preset="frost"]').waitFor();
        if (group.width === 1440) await shot('initial-monitor-chrome');
        await scaleText(activePage, group.textScale);
        const rootGeometry = await geometry(activePage, '.host-sensors');
        if (rootGeometry.box.height <= rootGeometry.clip.bottom - rootGeometry.clip.top - 32) await wheelVisible(activePage, '.host-sensors');
        else await wheelVisible(activePage, '.host-sensors-heading');
        await shot('true-empty-reading');
        const metrics = await sensorDom.inspect(activePage);
        sensorDom.check(metrics);
        result.metrics = sanitized(metrics);
        result.navigation = result.metrics.chrome.navigation;
        assert.equal(
          result.navigation,
          group.width >= 1100 && group.height >= 640 ? 'desktop' : 'page',
          'Phones/tablets must use ordinary page navigation',
        );
        if (result.navigation === 'page')
          assert.equal(await activePage.locator('.desktop-window-controls').count(), 0, 'Ordinary page must not expose window controls');
        result.about = await about(activePage, shot);
        if (group.poll) {
          const beforePoll = await geometry(activePage);
          fullVisible(beforePoll, true);
          const priorReceipt = responses.at(-1).at;
          result.refresh = { passed: false, before: beforePoll, priorReceipt };
          await shot('before-thirty-second-poll');
          save();
          const response = await activePage.waitForResponse(
            (response) => new URL(response.url()).pathname === endpoint && response.request().method() === 'GET' && response.status() === 200,
            { timeout: 35000 },
          );
          const receivedAt = Date.now();
          const actual = await response.json();
          validateEmpty(actual);
          await dom.settle(activePage);
          await Promise.all(jobs);
          await renderedEmpty(activePage);
          const afterPoll = await geometry(activePage);
          Object.assign(result.refresh, {
            after: afterPoll,
            actualResponse200: true,
            response: validateEmpty(actual),
            receivedAt,
            actualPollIntervalMs: receivedAt - priorReceipt,
            rawScrollChanged: !isDeepStrictEqual(beforePoll.scroll, afterPoll.scroll),
            viewportDrift: { top: afterPoll.box.top - beforePoll.box.top, bottom: afterPoll.box.bottom - beforePoll.box.bottom },
            timestampChanged: actual.sampledAt !== result.actualSample.sampledAt,
          });
          save();
          await shot('after-thirty-second-poll');
          fullVisible(afterPoll, true);
          assert.ok(
            receivedAt - priorReceipt >= 28000 && receivedAt - priorReceipt <= 35000,
            'Actual sensor refetch retains the thirty-second cadence',
          );
          assert.ok(
            Math.abs(afterPoll.box.top - beforePoll.box.top) <= 1 && Math.abs(afterPoll.box.bottom - beforePoll.box.bottom) <= 1,
            'Actual polling must retain the visible focused About anchor within one CSS pixel',
          );
          result.refresh.passed = true;
        }
        result.images = await activePage.evaluate(() =>
          [...document.images].map((image) => ({
            visible: Boolean(image.getClientRects().length),
            complete: image.complete,
            loaded: image.naturalWidth > 0,
          })),
        );
        assert.ok(
          result.images.every((image) => !image.visible || (image.complete && image.loaded)),
          'Actual visible images must all load',
        );
        assert.equal(await activePage.locator('.orbis-error-panel').count(), 0, 'Actual published Monitor must not show fallback');
        result.passed = true;
      } catch (error) {
        await shot('failure').catch(() => {
          result.failureCaptureUnavailable = true;
        });
        throw error;
      } finally {
        const attempt = async (name, action) => {
          try {
            await action();
            result.cleanup[name] = true;
          } catch (error) {
            report.cleanupFailures.push(`${stage}:${name}`);
            fail(error);
          }
        };
        await attempt('textRestored', () => restoreText(activePage));
        await attempt('viewportRestored', () => activePage.setViewportSize({ width: group.width, height: group.height }));
        closing = true;
        await Promise.all(jobs);
        await attempt('listenersRestored', async () => {
          activeContext.off('requestfailed', failed);
          activeContext.off('response', responded);
          activePage.off('pageerror', pageError);
          assert.equal(activeContext.listeners('requestfailed').includes(failed), false);
          assert.equal(activeContext.listeners('response').includes(responded), false);
          assert.equal(activePage.listeners('pageerror').includes(pageError), false);
        });
        await attempt('pageClosed', () => activePage.close());
        activePage = undefined;
        await attempt('routesRestored', () => activeContext.unroute('**/*', handler));
        await attempt('contextClosed', () => activeContext.close());
        activeContext = undefined;
        if (result.cleanup.contextClosed) report.cleanup.groupContextsClosed++;
        if (!Object.values(result.cleanup).every(Boolean)) result.passed = false;
        save();
      }
    }
    stage = 'final-records';
    baseline.after = await snapshot();
    samePrivate(baseline.after, before, 'Actual account/app/store records changed during read-only audit');
    report.recordsUnchanged = true;
    await buildExact();
    const afterCore = verifyCore(release.image);
    report.coreChecks.push(afterCore);
    assert.equal(afterCore.imageId, report.coreChecks[0].imageId, 'Actual image identity changed during audit');
    assert.equal(afterCore.idHash, report.coreChecks[0].idHash, 'Actual core container identity changed during audit');
    assert.equal(report.groups.length, groups.length);
    assert.ok(report.groups.every((item) => item.passed));
    report.passed = true;
  } catch (error) {
    fail(error);
  } finally {
    if (reader && before)
      try {
        baseline.after = await snapshot();
        samePrivate(baseline.after, before, 'Final actual account/app/store records changed');
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
    for (const [resource, key] of [
      [anonymous, 'anonymousClosed'],
      [reader, 'readerClosed'],
      [browser, 'browserClosed'],
    ])
      if (resource)
        await resource
          .close()
          .then(() => {
            report.cleanup[key] = true;
          })
          .catch((error) => {
            report.cleanupFailures.push(`${key}-failed`);
            fail(error);
          });
    if (
      !report.recordsUnchanged ||
      !report.matchedPriorBeta45Records ||
      !report.cleanup.readerClosed ||
      !report.cleanup.anonymousClosed ||
      !report.cleanup.browserClosed ||
      report.cleanup.groupContextsClosed !== groups.length ||
      report.cleanupFailures.length ||
      report.blockedMutations.length ||
      report.blockedRedirects.length ||
      report.externalRequestsBlocked ||
      report.readFailures.length ||
      report.assetFailures.length ||
      report.pageErrors.length
    )
      report.passed = false;
    save();
  }
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, code: report.passed ? 'PUBLISHED_HOST_SENSORS_UI_AUDIT_PASSED' : 'PUBLISHED_HOST_SENSORS_UI_AUDIT_FAILED', groups: report.groups.length, recordsUnchanged: report.recordsUnchanged, browserClosed: report.cleanup.browserClosed, reportFile: outputReady ? path.join(config.output, 'report.json') : null })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}
function selfCheck() {
  const env = {
    ORBIS_ALLOW_LIVE_HOST_SENSORS_AUDIT: '1',
    ORBIS_AUDIT_EXPECTED_TAG: 'v0.1.0-beta.46',
    ORBIS_AUDIT_EXPECTED_COMMIT: reviewedCommit,
    ORBIS_AUDIT_EXPECTED_DIGEST: `sha256:${'a'.repeat(64)}`,
    ORBIS_AUDIT_COOKIE_FILE: ownedCookieFile,
    ORBIS_AUDIT_RELEASE_FILE: releasePath,
    ORBIS_AUDIT_BASELINE_FILE: baselinePath,
    ORBIS_AUDIT_HELPER_PROOF_FILE: helperProofPath,
    ORBIS_AUDIT_OUTPUT_DIR: '/tmp/orbis-sensors-guard-selfcheck',
  };
  const argv = ['--allow-owned-published-host-sensors'];
  assert.equal(options(env, argv).expectedCommit, reviewedCommit);
  for (const [name, value] of [
    ['ORBIS_ALLOW_LIVE_HOST_SENSORS_AUDIT', '0'],
    ['ORBIS_AUDIT_EXPECTED_TAG', 'v0.1.0-beta.45'],
    ['ORBIS_AUDIT_EXPECTED_COMMIT', 'b'.repeat(40)],
    ['ORBIS_AUDIT_EXPECTED_DIGEST', 'latest'],
    ['ORBIS_AUDIT_COOKIE_FILE', '/tmp/not-owned'],
    ['ORBIS_AUDIT_URL', 'http://example.com:18080'],
    ['ORBIS_AUDIT_URL', 'http://127.0.0.1:18080/monitor'],
    ['ORBIS_AUDIT_OUTPUT_DIR', '/Users/sai/no'],
    ['ORBIS_AUDIT_BASELINE_FILE', '/tmp/unreviewed.json'],
    ['ORBIS_AUDIT_HELPER_PROOF_FILE', '/tmp/unreviewed.json'],
  ])
    assert.throws(() => options({ ...env, [name]: value }, argv));
  assert.throws(() => options(env, []));
  const empty = {
    available: true,
    sampledAt: '2026-10-18T00:00:00.000Z',
    stale: false,
    temperatures: [],
    fans: [],
    gpus: [],
    omitted: { temperatures: 0, fans: 0, gpus: 0 },
    unavailable: [],
    limited: false,
    unreadable: 0,
  };
  validateEmpty(empty);
  for (const change of [
    { available: false },
    { stale: true },
    { limited: true },
    { unreadable: 1 },
    { unavailable: ['fans'] },
    { gpus: [{}] },
    { omitted: { temperatures: 0, fans: 1, gpus: 0 } },
  ])
    assert.throws(() => validateEmpty({ ...empty, ...change }));
  const release = { tag: 'v0.1.0-beta.46', commit: reviewedCommit, image: `ghcr.io/twentylines/orbis@${env.ORBIS_AUDIT_EXPECTED_DIGEST}` };
  const prior = { matchedPriorBeta45Records: true, records: { preferences: {}, installed: {}, apps: {}, stores: {} }, tasks: {} };
  const helper = {
    passed: true,
    installedHelperVerified: true,
    coreSocketReadMatchesHost: true,
    existingTelemetryAndProcessesAvailable: true,
    privateScriptDirectoryAndSocketModes: true,
    serviceActive: true,
    macDockerContext: dockerContext,
    unchangedCore: { image: release.image },
    actualNumericHardwareRows: 0,
    exposedKernelIdentitiesMatched: { temperatures: 0, fans: 0, gpus: 0 },
    sourceSha256: reviewedHelperHashes,
  };
  proofInputs(release, prior, helper, env.ORBIS_AUDIT_EXPECTED_DIGEST);
  assert.throws(() => proofInputs({ ...release, commit: 'b'.repeat(40) }, prior, helper, env.ORBIS_AUDIT_EXPECTED_DIGEST));
  assert.throws(() => proofInputs(release, { ...prior, matchedPriorBeta45Records: false }, helper, env.ORBIS_AUDIT_EXPECTED_DIGEST));
  for (const change of [
    { serviceActive: false },
    { sourceSha256: {} },
    { actualNumericHardwareRows: 1 },
    { exposedKernelIdentitiesMatched: { temperatures: 1, fans: 0, gpus: 0 } },
    { unchangedCore: { image: 'unreviewed' } },
  ])
    assert.throws(() => proofInputs(release, prior, { ...helper, ...change }, env.ORBIS_AUDIT_EXPECTED_DIGEST));
  process.stdout.write('PUBLISHED_HOST_SENSORS_GUARDS_PASSED (no files, cookies, browser or runtime accessed)\n');
}
if (require.main === module) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--self-check') selfCheck();
  else
    main().catch(() => {
      process.stderr.write('PUBLISHED_HOST_SENSORS_UI_AUDIT_FAILED\n');
      process.exitCode = 1;
    });
}
module.exports = { main, selfCheck };
