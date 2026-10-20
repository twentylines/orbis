// Actual published compact UI acceptance; every response body remains unchanged.
// Explicit pins, protected input proofs and owned loopback runtime are required before any browser starts.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual, stripVTControlCharacters } = require('node:util');
const { chromium } = require('@playwright/test');
const { dom } = require('./host-devices-checks.cjs');
const inspectSettingsAlignment = require('./settings-alignment-checks.cjs');
const compactCopy = require('./compact-copy-checks.cjs');

const installRoot = '/Users/sai/.codex/tmp/orbis-stock-20261015';
const ownedCookieFile = `${installRoot}/test-cookies.txt`;
const dockerContext = 'colima-runtipi-test';
const expectedTag = 'v0.1.0-beta.51';
const reviewedCommit = '07dec2e9e8769edf8a1471f48c2bd72ef27437a4';
const reviewedDigest = 'sha256:f85fd3e8d9ab565429e8340ba2a688941cc3ac0db563c7b8e4e99a4047abf7d7';
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
    const state = window.__orbisCompactTextScale;
    if (!state) return;
    state.observer.disconnect();
    for (const [element, value] of state.entries)
      for (const [name, original, priority] of value.original) {
        if (original) element.style.setProperty(name, original, priority);
        else element.style.removeProperty(name);
      }
    delete window.__orbisCompactTextScale;
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
    window.__orbisCompactTextScale = { factor, entries, observer };
  }, factor);
  await dom.settle(page);
}

const releasePath = '/tmp/orbis-beta51-release-check-20261020.json';
const baselinePath = '/tmp/orbis-beta51-after-ota-records.private.json';
const goPath = '/tmp/orbis-beta51-compact-ui-go.private.json';
const baseUrl = 'http://127.0.0.1:18080';
const recordKeys = ['preferences', 'installed', 'apps', 'stores', 'links', 'userContext', 'appContext'];
const groups = [
  { width: 1440, height: 1120, textScale: 1, refresh: true },
  { width: 768, height: 1024, textScale: 1 },
  { width: 390, height: 844, textScale: 1, anonymous: true },
  { width: 320, height: 800, textScale: 1 },
  { width: 320, height: 800, textScale: 2, anonymous: true },
];
const routes = [
  { name: 'home', path: '/dashboard', ready: '.workspace-heading', root: '.desktop-main' },
  { name: 'monitor', path: '/monitor', ready: '.desktop-host-overview', root: '.desktop-route-window' },
  { name: 'apps', path: '/apps', ready: '.desktop-installed-grid', root: '.desktop-route-window' },
  { name: 'store', path: '/app-store', ready: '.action-bar', root: '.desktop-route-window' },
  { name: 'updates', path: '/updates', ready: '.desktop-updates-card', root: '.desktop-route-window' },
  { name: 'appearance', path: '/settings?tab=appearance', ready: '.appearance-section', root: '.desktop-route-window' },
];
const anonymousRoutes = [
  { name: 'login', path: '/login', ready: '.desktop-auth input[name=email]', root: '.desktop-auth' },
  { name: 'reset', path: '/reset-password', ready: '.desktop-auth pre', root: '.desktop-auth' },
];
const publicPaths = new Set([
  ...routes.map((sample) => sample.path.split('?')[0]),
  ...anonymousRoutes.map((sample) => sample.path),
  '/api/user-context',
  '/api/app-context',
  '/api/system/build',
  '/api/desktop-preferences',
  '/api/apps/installed',
  '/api/marketplace/all',
  '/api/links',
  '/api/system/host-telemetry',
  '/api/system/host-history',
  '/api/system/host-processes',
  '/api/system/host-sensors',
  '/api/system/history',
  '/api/system/containers',
  '/api/sse/app',
  '/',
  '/favicon.ico',
]);
const safePath = (value) => (publicPaths.has(value) || value.startsWith('/assets/') ? value : `/[${hash(value).slice(0, 16)}]`);
function sanitized(value, key = '') {
  if (typeof value === 'string' && ['text', 'title', 'context', 'word', 'accessibleName', 'name'].includes(key))
    return { sha256: hash(value), length: value.length };
  if (Array.isArray(value)) return value.map((item) => sanitized(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitized(item, name)]));
  return value;
}
function safeDiagnosticText(value) {
  try {
    return String(value);
  } catch {
    return '[unprintable diagnostic value]';
  }
}
function originalError(error) {
  const result = {};
  for (const key of ['name', 'message', 'stack']) {
    try {
      const value = error?.[key];
      if (value !== undefined) result[key] = safeDiagnosticText(value);
    } catch {
      result[key] = '[unreadable error property]';
    }
  }
  if (!Object.keys(result).length) result.value = safeDiagnosticText(error);
  return result;
}
function diagnosticUrl(value) {
  const raw = safeDiagnosticText(value);
  try {
    const target = new URL(stripVTControlCharacters(raw));
    if (!['http:', 'https:'].includes(target.protocol)) return `[non-http-url:${hash(raw).slice(0, 16)}]`;
    return `${target.origin}${target.pathname}${target.search ? '?[redacted]' : ''}`;
  } catch {
    return `[invalid-url:${hash(raw).slice(0, 16)}]`;
  }
}
function diagnosticError(error, secrets = []) {
  const original = originalError(error);
  let value = stripVTControlCharacters(original.stack || original.message || original.value || '[unreadable error]');
  for (const secret of secrets) if (secret) value = value.replaceAll(secret, '[private]');
  return value
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => diagnosticUrl(url))
    .split('\n')
    .filter((line) => !/\b(?:cookie|authorization|headers)\b/i.test(line))
    .join('\n');
}

function validateOptions(env, argv, digest) {
  assert.match(digest || '', /^sha256:[a-f0-9]{64}$/, 'Reviewed beta51 digest is not pinned; live audit is disabled');
  assert.deepEqual(argv, ['--allow-owned-published-compact-ui'], 'Explicit owned published compact UI argument is required');
  assert.equal(env.ORBIS_ALLOW_LIVE_COMPACT_UI_AUDIT, '1', 'Explicit published compact UI opt-in is required');
  assert.equal(env.ORBIS_AUDIT_EXPECTED_TAG, expectedTag, 'Only reviewed beta51 is permitted');
  assert.match(env.ORBIS_AUDIT_EXPECTED_COMMIT || '', /^[a-f0-9]{40}$/, 'Exact reviewed full commit is required');
  assert.equal(env.ORBIS_AUDIT_EXPECTED_COMMIT, reviewedCommit, 'Only the immutable reviewed beta51 commit is permitted');
  assert.match(env.ORBIS_AUDIT_EXPECTED_DIGEST || '', /^sha256:[a-f0-9]{64}$/, 'Exact reviewed published digest is required');
  assert.equal(env.ORBIS_AUDIT_EXPECTED_DIGEST, digest, 'Only the independently verified beta51 image index is permitted');
  assert.equal(env.ORBIS_AUDIT_COOKIE_FILE, ownedCookieFile, 'Only the primary owned observer cookie jar is permitted');
  assert.equal(env.ORBIS_AUDIT_RELEASE_FILE, releasePath, 'Only the reviewed beta51 release manifest is permitted');
  assert.equal(env.ORBIS_AUDIT_BASELINE_FILE, baselinePath, 'Only the independently captured post-OTA baseline is permitted');
  assert.equal(env.ORBIS_AUDIT_GO_FILE, goPath, 'Independent post-OTA GO proof is required');
  const origin = new URL(env.ORBIS_AUDIT_URL || baseUrl);
  assert.equal(origin.href, `${baseUrl}/`, 'Only owned loopback18080 is permitted');
  assert.ok(!origin.username && !origin.password, 'Origin must not contain credentials');
  const output = env.ORBIS_AUDIT_OUTPUT_DIR || '';
  assert.ok(
    output.startsWith('/tmp/') && path.isAbsolute(output) && path.resolve(output) === output,
    'Explicit normalized fresh /tmp output is required',
  );
  return { origin, output, expectedCommit: env.ORBIS_AUDIT_EXPECTED_COMMIT, expectedDigest: env.ORBIS_AUDIT_EXPECTED_DIGEST };
}
function options(env, argv) {
  return validateOptions(env, argv, reviewedDigest);
}
function proofInputs(release, proof, priorText, config) {
  assert.equal(release.tag, expectedTag, 'Exact release tag differs');
  assert.equal(release.commit, config.expectedCommit, 'Exact release commit differs');
  assert.equal(release.image, `ghcr.io/twentylines/orbis@${config.expectedDigest}`, 'Exact release image differs');
  assert.equal(proof.schema, 'orbis.compact-ui-go.v1');
  assert.equal(proof.passed, true);
  samePrivate(proof.release, { tag: release.tag, commit: release.commit, image: release.image }, 'GO proof release differs');
  assert.equal(proof.dockerContext, dockerContext);
  assert.equal(proof.root, installRoot);
  assert.equal(proof.baseUrl, baseUrl);
  for (const name of ['reviewedOtaComplete', 'independentDataPreservationPassed'])
    assert.equal(proof.checks?.[name], true, 'Independent GO proof is incomplete');
  assert.equal(proof.recordBaselineSha256, hash(priorText), 'Post-OTA full-record baseline bytes differ');
  const prior = parsePrivate(priorText, 'Post-OTA API record baseline');
  assert.deepEqual(Object.keys(prior).sort(), [...recordKeys].sort(), 'Exact complete flat record baseline is required');
  assert.equal(prior.userContext?.isLoggedIn, true, 'Post-OTA baseline must authenticate');
  assert.ok(
    prior.appContext?.user?.hasSeenWelcome && prior.appContext?.user?.locale === 'en',
    'Existing English account must have completed Welcome',
  );
  assert.ok(['light', 'dark', 'system'].includes(prior.preferences?.mode), 'Actual saved colour mode is required');
  assert.ok(['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'].includes(prior.preferences?.preset), 'Actual saved preset is required');
  return prior;
}
function guardCore(core, image) {
  assert.equal(core.image, image, 'Owned core differs from the reviewed published image');
  assert.match(core.imageId || '', /^sha256:[a-f0-9]{64}$/);
  assert.ok(core.running && !core.paused && core.health === 'healthy', 'Owned core must be healthy, running and unpaused');
  assert.ok(Number.isFinite(Date.parse(core.startedAt)), 'Owned core start witness is required');
  const bindings = Object.entries(core.ports || {}).flatMap(([port, entries]) => (entries || []).map((entry) => ({ port, ...entry })));
  assert.ok(
    bindings.length > 0 &&
      bindings.every((entry) => entry.port === '3000/tcp' && entry.HostPort === '18080' && ['127.0.0.1', '::1'].includes(entry.HostIp)),
    'Only direct backend loopback18080 may be published',
  );
  for (const [destination, relative] of Object.entries({
    '/data/.env': '.env',
    '/data/apps': 'apps',
    '/data/repos': 'repos',
    '/data/user-config': 'user-config',
    '/data/state': 'state',
    '/app-data': 'app-data',
  })) {
    const found = core.mounts.filter((mount) => mount.Destination === destination);
    assert.ok(
      found.length === 1 && found[0].Type === 'bind' && found[0].Source === path.join(installRoot, relative),
      'Core binds differ from the owned installation',
    );
  }
  assert.equal(
    core.mounts.filter((mount) => /^\/(?:data\/(?:apps|repos|user-config|state)|app-data)\//.test(mount.Destination)).length,
    0,
    'Unexpected owned-tree mount override',
  );
}
function verifyCore(image) {
  const ids = readDocker(['ps', '-q', '--filter', 'label=com.docker.compose.service=runtipi']).trim().split('\n').filter(Boolean);
  assert.equal(ids.length, 1, 'Exactly one running core is required in the owned Docker context');
  const format =
    '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}';
  const core = parsePrivate(readDocker(['inspect', '--format', format, ids[0]]), 'Owned core inspection');
  guardCore(core, image);
  const digests = parsePrivate(readDocker(['inspect', '--type', 'image', '--format', '{{json .RepoDigests}}', core.imageId]), 'Owned image digests');
  assert.ok(Array.isArray(digests) && digests.includes(image), 'Running image does not contain the exact published digest');
  const architecture = parsePrivate(
    readDocker(['inspect', '--type', 'image', '--format', '{{json .Architecture}}', core.imageId]),
    'Owned image architecture',
  );
  assert.equal(architecture, 'arm64', 'Owned core must be the actual published arm64 image');
  return {
    idHash: hash(ids[0]),
    image: core.image,
    imageId: core.imageId,
    startedAt: core.startedAt,
    architecture,
    healthy: true,
    ownedBinds: true,
    ports: core.ports,
  };
}

async function settled(page) {
  await dom.settle(page);
  await page.evaluate(async () => {
    let prior = '';
    let stable = 0;
    for (let attempt = 0; attempt < 35; attempt++) {
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 65)));
      const r = document.activeElement.getBoundingClientRect();
      const value = [scrollX, scrollY, document.querySelector('.desktop-window-content')?.scrollTop || 0, r.top, r.bottom].join(',');
      stable = value === prior ? stable + 1 : 0;
      prior = value;
      if (stable >= 3) return;
    }
    throw new Error('Natural focus/scroll geometry did not settle');
  });
}
async function measure(page, rootSelector) {
  return page
    .locator(rootSelector)
    .first()
    .evaluate((root) => {
      const box = (element) => {
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, cy: (r.top + r.bottom) / 2 };
      };
      const visible = (element) =>
        element?.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== 'hidden' &&
        !element.closest('[aria-hidden=true],[hidden],.visually-hidden,.sr-only');
      const style = (element) => {
        if (!element) return null;
        const s = getComputedStyle(element);
        return {
          box: box(element),
          background: s.backgroundColor,
          image: s.backgroundImage,
          blur: s.backdropFilter || s.webkitBackdropFilter,
          shadow: s.boxShadow,
          border: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor],
          font: Number.parseFloat(s.fontSize),
          padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(Number.parseFloat),
          transition: s.viewTransitionName,
        };
      };
      const rects = (range) =>
        [...range.getClientRects()].filter((r) => r.width && r.height).map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }));
      const words = [];
      const hyphenated = [];
      const clipped = [];
      const ellipses = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!visible(parent) || parent.closest('svg,pre,code,textarea,input,.metric-chart-scale,.metric-chart-times,.metric-chart-tooltip')) continue;
        let ellipse = null;
        for (let item = parent; item && root.contains(item); item = item.parentElement) {
          const s = getComputedStyle(item);
          if (s.textOverflow === 'ellipsis' && s.overflowX === 'hidden' && s.whiteSpace === 'nowrap') {
            ellipse = item;
            break;
          }
        }
        if (ellipse && ellipse.scrollWidth > ellipse.clientWidth + 1) {
          const titled = ellipse.closest('[title]');
          ellipses.push({
            text: ellipse.textContent,
            title: titled?.title || '',
            accessible: Boolean(titled?.title?.includes(ellipse.textContent.trim())),
          });
          continue;
        }
        const boundary = parent.getBoundingClientRect();
        const allocation = parent.closest('.desktop-host-overview-copy,.desktop-updates-card');
        const allocationBox = allocation?.getBoundingClientRect();
        const allocationStyle = allocation ? getComputedStyle(allocation) : null;
        for (const match of node.textContent.matchAll(/[A-Za-z]{3,}/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const ink = rects(range);
          const lines = new Set(ink.map((r) => Math.round(r.top)));
          if (lines.size > 1) {
            const fragments = new Map();
            for (let offset = 0; offset < match[0].length; offset++) {
              const letter = document.createRange();
              letter.setStart(node, match.index + offset);
              letter.setEnd(node, match.index + offset + 1);
              const r = letter.getBoundingClientRect();
              const line = Math.round(r.top);
              fragments.set(line, (fragments.get(line) || '') + match[0][offset]);
            }
            const allowed = getComputedStyle(parent).hyphens === 'auto' && [...fragments.values()].every((fragment) => fragment.length >= 2);
            (allowed ? hyphenated : words).push({ word: match[0], context: parent.textContent, rects: ink, fragments: [...fragments.values()] });
          }
          for (const r of ink)
            if (r.left < boundary.left - 1 || r.right > boundary.right + 1)
              clipped.push({ word: match[0], context: parent.textContent, rect: r, bounds: box(parent) });
          if (allocationBox)
            for (const r of ink) {
              const bounds = {
                left: allocationBox.left + Number.parseFloat(allocationStyle.borderLeftWidth) + Number.parseFloat(allocationStyle.paddingLeft),
                right: allocationBox.right - Number.parseFloat(allocationStyle.borderRightWidth) - Number.parseFloat(allocationStyle.paddingRight),
              };
              if (r.left < bounds.left - 1 || r.right > bounds.right + 1)
                clipped.push({ word: match[0], context: parent.textContent, rect: r, allocatedAncestor: allocation.className, bounds });
            }
        }
      }
      const frame = root.matches('.desktop-route-window') ? root : root.querySelector('.desktop-route-window');
      const content = frame?.querySelector('.desktop-window-content');
      const bar = document.querySelector('.desktop-system-bar');
      const dock = document.querySelector('.desktop-dock');
      const heading = frame?.querySelector('.desktop-window-bar');
      const theme = document.querySelector('.orbis-theme');
      const active = document.activeElement;
      const activeStyle = getComputedStyle(active);
      const activeExtent =
        (activeStyle.outlineStyle === 'none'
          ? 0
          : Number.parseFloat(activeStyle.outlineWidth) + Math.max(0, Number.parseFloat(activeStyle.outlineOffset))) || 0;
      const controls = [
        ...root.querySelectorAll(
          'button:not([role=switch]),input:not([type=checkbox]):not([type=radio]):not([type=file]),select,[role=combobox],summary',
        ),
      ]
        .filter(visible)
        .map((element) => {
          const s = getComputedStyle(element);
          return {
            text: element.tagName === 'INPUT' ? element.getAttribute('name') : element.textContent.trim(),
            classes: String(element.className),
            box: box(element),
            font: Number.parseFloat(s.fontSize),
            padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(Number.parseFloat),
            excludedChrome: Boolean(element.closest('.desktop-window-controls,.desktop-window-resize,.desktop-system-bar,.desktop-dock')),
            legacy: element.matches('.container-resources-sort button')
              ? 36
              : element.matches('.monitor-history-ranges button')
                ? 38
                : element.matches('.desktop-auth input.form-control')
                  ? 36
                  : element.tagName === 'SUMMARY' && !element.matches('.monitor-history-info summary')
                    ? 'native-disclosure'
                    : null,
          };
        });
      const panels = [
        ...root.querySelectorAll(
          '.workspace-activity,.workspace-operations,.workspace-attention,.desktop-host-overview,.desktop-telemetry-grid > section,.host-sensors,.host-processes,.host-device-history,.desktop-updates-card,.desktop-auth .card-body',
        ),
      ]
        .filter(visible)
        .map(style);
      const fonts = [
        ...root.querySelectorAll('h1,h2,h3,.desktop-host-overview-readings strong,.workspace-status-copy > strong,.desktop-update-release-title'),
      ]
        .filter(visible)
        .map((element) => ({ id: element.id, tag: element.tagName, text: element.textContent.trim(), ...style(element) }));
      const criticalInk = [
        ...root.querySelectorAll(
          '.desktop-updates-card-head h2,.desktop-updates-card-head p,.desktop-update-app strong,.desktop-host-overview-readings span,.desktop-host-overview-readings strong',
        ),
      ]
        .filter(visible)
        .map((element) => {
          const allocation = element.closest('.desktop-host-overview-copy,.desktop-updates-card');
          const allocationBox = allocation.getBoundingClientRect();
          const allocationStyle = getComputedStyle(allocation);
          const elementStyle = getComputedStyle(element);
          const range = document.createRange();
          range.selectNodeContents(element);
          return {
            selector: element.id ? `#${element.id}` : element.tagName.toLowerCase(),
            text: element.textContent.trim(),
            local: box(element),
            bounds: {
              left: allocationBox.left + Number.parseFloat(allocationStyle.borderLeftWidth) + Number.parseFloat(allocationStyle.paddingLeft),
              right: allocationBox.right - Number.parseFloat(allocationStyle.borderRightWidth) - Number.parseFloat(allocationStyle.paddingRight),
            },
            ink: rects(range),
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            appName: element.matches('.desktop-update-app strong'),
            ellipsis: {
              whiteSpace: elementStyle.whiteSpace,
              textOverflow: elementStyle.textOverflow,
              overflow: elementStyle.overflowX,
              title: element.title,
            },
          };
        });
      const applicationCard = root.querySelector('[aria-labelledby="application-updates-title"]');
      const applicationAction = applicationCard?.querySelector('.desktop-update-link');
      const applicationStyle = applicationCard ? getComputedStyle(applicationCard) : null;
      const overview = root.querySelector('.desktop-host-overview');
      const overviewCopy = overview?.querySelector('.desktop-host-overview-copy');
      const machineFaces = overview
        ? [...overview.querySelectorAll('.desktop-host-machine-front,.desktop-host-machine-side,.desktop-host-machine-top')].map(box)
        : [];
      const action = [...root.querySelectorAll('.action-bar')].find(visible);
      const grid = root.querySelector('.desktop-installed-grid,.desktop-catalogue-grid');
      const cards = grid ? [...grid.children].filter(visible).map((item) => box(item.querySelector('.app-tile,.card') || item)) : [];
      const workspaceHeading = root.querySelector('.workspace-heading');
      const logout = bar?.querySelector('.desktop-icon-button');
      const headerControls = bar
        ? [...bar.querySelectorAll('.desktop-task-trigger,.desktop-mode-toggle,.desktop-search-trigger,.desktop-icon-button')]
            .filter(visible)
            .map(box)
        : [];
      return {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        documentWidth: document.documentElement.scrollWidth,
        scroll: { x: scrollX, y: scrollY, content: content?.scrollTop || 0, frame: frame?.scrollTop || 0 },
        theme: { mode: theme?.dataset.desktopMode, preset: theme?.dataset.desktopPreset },
        navigation: frame?.dataset.windowNavigation,
        words,
        hyphenated,
        clipped,
        ellipses,
        controls,
        panels,
        fonts,
        criticalInk,
        applicationCardFit:
          applicationCard && applicationAction
            ? {
                card: box(applicationCard),
                action: box(applicationAction),
                paddingBottom: Number.parseFloat(applicationStyle.paddingBottom),
                borderBottom: Number.parseFloat(applicationStyle.borderBottomWidth),
                actionMarginBottom: Number.parseFloat(getComputedStyle(applicationAction).marginBottom),
                extra:
                  box(applicationCard).bottom -
                  box(applicationAction).bottom -
                  Number.parseFloat(applicationStyle.paddingBottom) -
                  Number.parseFloat(applicationStyle.borderBottomWidth) -
                  Number.parseFloat(getComputedStyle(applicationAction).marginBottom),
              }
            : null,
        stackedMachineClearance:
          overviewCopy && machineFaces.length && getComputedStyle(overview).gridTemplateColumns.trim().split(/\s+/).length === 1
            ? {
                copy: box(overviewCopy),
                faces: machineFaces,
                gap: Math.min(...machineFaces.map((face) => face.top)) - box(overviewCopy).bottom,
              }
            : null,
        root: style(root),
        frame: style(frame),
        heading: style(heading),
        content: style(content),
        bar: style(bar),
        dock: style(dock),
        windowControls: frame?.querySelectorAll('.desktop-window-control,.desktop-window-resize,.desktop-window-resume').length || 0,
        titleAlignment: heading
          ? { icon: box(heading.querySelector('.desktop-window-icon')), label: box(heading.querySelector('.desktop-window-label')) }
          : null,
        action: action ? { box: box(action), fields: [...action.querySelectorAll('input,button,[role=combobox]')].filter(visible).map(box) } : null,
        grid: grid ? box(grid) : null,
        cards,
        workspace: workspaceHeading
          ? {
              heading: box(workspaceHeading),
              grid: box(root.querySelector('.workspace-grid')),
              brand: box(document.querySelector('.desktop-brand')),
              logout: box(logout),
            }
          : null,
        headerControls,
        logout: logout ? box(logout) : null,
        auth: root.matches('.desktop-auth')
          ? {
              card: style(root.querySelector('.card')),
              body: style(root.querySelector('.card-body')),
              toolbar: [...root.querySelectorAll('.desktop-auth-toolbar button')].filter(visible).map(box),
              inputsEmpty: [...root.querySelectorAll('input')].every((input) => !input.value),
              code: [...root.querySelectorAll('pre')].map((element) => ({
                ...style(element),
                complete: element.textContent === './runtipi-cli reset-password',
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
              })),
            }
          : null,
        active: {
          inRoot: root.contains(active),
          tag: active.tagName,
          box: box(active),
          extent: activeExtent,
          focused: active.matches(':focus-visible'),
          classes: String(active.className),
        },
        images: [...root.querySelectorAll('img')]
          .filter((element) => visible(element) && element.getBoundingClientRect().top < innerHeight && element.getBoundingClientRect().bottom > 0)
          .map((image) => ({ complete: image.complete, loaded: image.naturalWidth > 0 })),
      };
    });
}
function alpha(value) {
  if (value === 'transparent') return 0;
  const values = value.match(/[\d.]+/g)?.map(Number);
  assert.ok(values?.length >= 3, 'Browser colour must be a resolved RGB colour');
  return values.length === 4 ? values[3] : 1;
}
function horizontalFits(ink, bounds) {
  return ink.left >= bounds.left - 1 && ink.right <= bounds.right + 1;
}
function checkCriticalInk(items) {
  for (const item of items) {
    if (item.appName && item.scrollWidth > item.clientWidth + 1) {
      assert.notEqual(item.text, 'Backups', 'The previously cropped ordinary app name must remain complete');
      assert.equal(item.ellipsis.whiteSpace, 'nowrap');
      assert.equal(item.ellipsis.textOverflow, 'ellipsis');
      assert.equal(item.ellipsis.overflow, 'hidden');
      assert.equal(item.ellipsis.title, item.text, 'Ellipsized app names must retain their complete title');
      continue;
    }
    for (const ink of item.ink) {
      assert.ok(horizontalFits(ink, item.local), 'Complete heading/reading ink must fit its own text allocation');
      assert.ok(horizontalFits(ink, item.bounds), 'Complete heading/reading ink must fit its padded card/copy ancestor');
    }
  }
}
function checkRouteSpacing(value, sample) {
  checkCriticalInk(value.criticalInk);
  if (sample.name === 'updates') {
    const fit = value.applicationCardFit;
    assert.ok(fit, 'Actual Applications card and its final action must be measured');
    const extra = fit.card.bottom - fit.action.bottom - fit.paddingBottom - fit.borderBottom - fit.actionMarginBottom;
    fit.extra = extra;
    assert.ok(extra >= -1 && extra <= 2, 'Applications card must end at its final action plus normal padding');
  }
  if (sample.name === 'monitor' && value.viewport.width <= 900)
    assert.ok(value.stackedMachineClearance, 'Compact Monitor must expose the stacked copy and transformed model faces');
  if (value.stackedMachineClearance)
    assert.ok(value.stackedMachineClearance.gap >= 16, 'All transformed model faces must clear the full readings copy by16px');
}
function check(value, sample, group, appearance) {
  assert.ok(value.documentWidth <= group.width, 'Published page must not overflow horizontally');
  assert.deepEqual(value.words, [], 'Ordinary words must not fracture into orphan fragments');
  assert.deepEqual(value.clipped, [], 'Text must not paint beyond its allocated box');
  assert.ok(
    value.ellipses.every((item) => item.accessible),
    'Deliberate identifier ellipsis must retain complete title/DOM text',
  );
  assert.ok(
    value.images.every((image) => image.complete && image.loaded),
    'Actual visible images must load',
  );
  checkRouteSpacing(value, sample);
  assert.equal(value.theme.mode, appearance.mode, 'Rendered mode must match the actual saved selection');
  assert.equal(value.theme.preset, appearance.preset, 'Rendered preset must match actual saved preferences');
  if (value.frame) {
    const desktop = group.width >= 1100 && group.height >= 640;
    assert.equal(value.navigation, desktop ? 'desktop' : 'page');
    assert.ok(desktop ? value.windowControls >= 4 : value.windowControls === 0, 'Only eligible desktops may expose window controls');
    assert.ok(
      value.frame.border.every((color) => alpha(color) === 0),
      'Window outer borders must remain transparent',
    );
    assert.ok(!value.frame.shadow.includes('inset'), 'Window frame must not add inset white rims');
    if (desktop) {
      assert.equal(alpha(value.frame.background), 0, 'Desktop titlebar must not be backed by an opaque frame');
      assert.ok(
        value.frame.box.top >= value.bar.box.bottom + 19 && value.frame.box.bottom <= value.dock.box.top - 19,
        'Desktop tool frame must remain between bar/dock',
      );
      assert.ok(value.heading.blur.includes('blur(28px)'), 'Desktop titlebar must use shared28px glass');
      assert.ok(alpha(value.heading.background) > 0 && alpha(value.heading.background) < 1, 'Desktop titlebar must remain translucent');
    }
    if (value.titleAlignment?.icon && value.titleAlignment?.label)
      assert.ok(Math.abs(value.titleAlignment.icon.cy - value.titleAlignment.label.cy) <= 1, 'Page/title icon and label must share a centre');
  }
  for (const item of [value.bar, value.dock].filter(Boolean)) {
    assert.ok(item.blur.includes('blur(28px)'), 'System bar/dock must preserve shared28px blur');
    assert.ok(alpha(item.background) > 0 && alpha(item.background) < 1, 'System bar/dock must remain translucent');
    assert.ok(item.border.every((color) => alpha(color) === 0) && !item.shadow.includes('inset'), 'System chrome must have no white rim/inset sheen');
  }
  if (value.headerControls.length) {
    assert.ok(
      value.headerControls.every((item) => Math.abs(item.cy - value.headerControls[0].cy) <= 1),
      'System-bar controls must share one centre line',
    );
    const logout = value.logout;
    if (logout) {
      const gaps = [logout.top - value.bar.box.top, value.bar.box.right - logout.right, value.bar.box.bottom - logout.bottom];
      assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, 'Logout top/right/bottom clearances must match');
    }
  }
  if (value.workspace) {
    for (const item of [value.workspace.heading, value.workspace.grid].filter(Boolean)) {
      assert.ok(Math.abs(item.left - value.workspace.brand.left) <= 1, 'Home heading/grid must share the inner brand gutter');
      assert.ok(Math.abs(item.right - value.workspace.logout.right) <= 1, 'Home heading/grid right edge must share the inner logout gutter');
    }
  }
  if (value.auth) {
    assert.ok(value.auth.inputsEmpty, 'Anonymous inspection must never fill credentials');
    assert.ok(value.auth.card.box.left >= 12 && value.auth.card.box.right <= group.width - 12, 'Auth card must retain viewport gutters');
    assert.ok(value.auth.body.padding[1] >= 20 && value.auth.body.padding[3] >= 20, 'Auth form must retain20px side padding');
    assert.ok(
      value.auth.toolbar.every((control) => control.width >= 40 && control.height >= 40),
      'Auth toolbar controls must retain40px targets',
    );
    assert.ok(
      value.auth.toolbar.every((control) => Math.abs(control.cy - value.auth.toolbar[0].cy) <= 1),
      'Auth toolbar controls must share a centre line',
    );
    assert.ok(
      value.auth.code.every((item) => item.complete && item.scrollWidth <= item.clientWidth + 1),
      'Complete reset command must reflow without horizontal clipping',
    );
  }
  for (const panel of value.panels)
    assert.ok(panel.padding[1] >= 12 && panel.padding[3] >= 12, 'Panels must retain at least12px side breathing room');
  for (const control of value.controls) {
    if (control.excludedChrome || control.legacy === 'native-disclosure') continue;
    assert.ok(control.box.height >= (control.legacy || 40), 'Control targets must preserve40px or explicitly recorded legacy height');
  }
  if (value.action && value.grid && value.action.fields.length) {
    const left = Math.min(...value.action.fields.map((field) => field.left));
    assert.ok(Math.abs(left - value.grid.left) <= 1, 'Filter field and card grid must share the painted left edge');
  }
  if (value.grid) {
    const rows = [];
    for (const card of value.cards) {
      let row = rows.find((items) => Math.abs(items[0].top - card.top) <= 1);
      if (!row) {
        row = [];
        rows.push(row);
      }
      row.push(card);
    }
    for (const row of rows) {
      assert.ok(
        Math.abs(Math.min(...row.map((card) => card.left)) - value.grid.left) <= 1,
        'Each painted card row must start at the shared grid gutter',
      );
      if (row.length > 1)
        assert.ok(
          Math.max(...row.map((card) => card.bottom)) - Math.min(...row.map((card) => card.bottom)) <= 1,
          'Related painted card bottoms must align',
        );
    }
  }
  if (group.textScale === 1 && sample.name === 'home') {
    const title = value.fonts.find((item) => item.tag === 'H1');
    const maximum = group.width <= 380 ? 24 : group.width <= 760 ? 26 : group.width <= 1099 ? 32 : 80;
    assert.ok(title && title.font <= maximum + 0.1, 'Actual native Home title must use the compact screen scale');
  }
  if (group.textScale === 1 && group.width <= 760)
    for (const item of value.fonts.filter((item) => ['host-processes-title', 'host-sensors-title', 'host-device-history-title'].includes(item.id)))
      assert.ok(item.font <= 18.1, 'Native phone sections must share the compact scale');
}
function checkFocus(value) {
  assert.equal(value.active.inRoot, true, 'Native Tab focus must remain in the actual route');
  const extent = value.active.extent;
  const top = value.navigation === 'desktop' ? value.content.box.top : value.bar ? value.bar.box.bottom + 7.5 : 0;
  const bottom = value.navigation === 'desktop' ? value.content.box.bottom : value.dock ? value.dock.box.top - 7.5 : value.viewport.height;
  const r = value.active.box;
  assert.ok(
    r.top - extent >= top && r.bottom + extent <= bottom && r.left - extent >= 0 && r.right + extent <= value.viewport.width,
    'Complete native focus marker must clear real scroll/chrome clip edges',
  );
}
async function wheelVisible(page, locator) {
  for (let attempt = 0; attempt < 65; attempt++) {
    const value = await locator.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const frame = element.closest('.desktop-route-window');
      const content = frame?.querySelector('.desktop-window-content');
      const desktop = frame?.dataset.windowNavigation === 'desktop';
      const top = desktop
        ? content.getBoundingClientRect().top + 16
        : (document.querySelector('.desktop-system-bar')?.getBoundingClientRect().bottom || 0) + 16;
      const bottom = desktop
        ? content.getBoundingClientRect().bottom - 16
        : (document.querySelector('.desktop-dock')?.getBoundingClientRect().top || innerHeight) - 16;
      return {
        top: r.top,
        bottom: r.bottom,
        limitTop: top,
        limitBottom: bottom,
        x: Math.min(innerWidth - 30, r.left + 40),
        y: Math.min(bottom - 20, top + 80),
      };
    });
    if (value.top >= value.limitTop && value.bottom <= value.limitBottom) {
      await settled(page);
      return;
    }
    const delta = value.top < value.limitTop ? value.top - value.limitTop : value.bottom - value.limitBottom;
    await page.mouse.move(value.x, value.y);
    await page.mouse.wheel(0, Math.max(-700, Math.min(700, delta)));
    await page.waitForTimeout(90);
  }
  throw new Error('Native wheel could not reveal the complete fitting control');
}

async function nativeFocus(page, sample) {
  const choices =
    sample.name === 'appearance'
      ? '#desktop-server-name'
      : sample.name === 'login'
        ? 'input[name=email]'
        : sample.name === 'monitor'
          ? '.monitor-history-ranges button'
          : sample.name === 'store'
            ? '.action-bar input'
            : sample.name === 'apps'
              ? '.desktop-installed-grid a,.desktop-installed-grid button,.empty a,.empty button'
              : sample.name === 'updates'
                ? '.desktop-updates .desktop-update-link'
                : sample.name === 'home'
                  ? '.workspace-heading button,.workspace-heading a'
                  : 'button:not([disabled]),a[href]';
  const target = page.locator(sample.root).first().locator(choices).filter({ visible: true }).first();
  if (!(await target.count())) return { checked: false, reason: 'No matching route control in actual data' };
  assert.equal(
    await target.evaluate((element) => Boolean(element.closest('.desktop-window-bar,.desktop-window-controls,.desktop-window-resize'))),
    false,
    'Native route-content preparation must not select fixed window chrome',
  );
  await wheelVisible(page, target);
  await target.focus();
  await page.keyboard.press('Tab');
  await settled(page);
  const after = await measure(page, sample.root);
  checkFocus(after);
  return { checked: true, keyboard: 'Native Tab after one explicit route-control focus', after: sanitized(after.active), scroll: after.scroll };
}
async function homeUsage(page, shot) {
  const panel = page.locator('.container-resources.is-compact');
  const cpu = panel.getByRole('button', { name: 'CPU', exact: true });
  const memory = panel.getByRole('button', { name: 'Memory', exact: true });
  await wheelVisible(page, cpu);
  await cpu.focus();
  await page.keyboard.press('Tab');
  await settled(page);
  assert.equal(await memory.evaluate((element) => element === document.activeElement), true, 'Native Tab must reach Home Memory control');
  const memoryFocus = await measure(page, '.desktop-main');
  checkFocus(memoryFocus);
  await shot('usage-memory-focus');
  await page.keyboard.press('Shift+Tab');
  await settled(page);
  assert.equal(await cpu.evaluate((element) => element === document.activeElement), true, 'Native Shift+Tab must reach Home CPU control');
  const cpuFocus = await measure(page, '.desktop-main');
  checkFocus(cpuFocus);
  await shot('usage-cpu-focus');
  return { passed: true, naturalWheel: true, nativeTab: true, memory: sanitized(memoryFocus.active), cpu: sanitized(cpuFocus.active) };
}
async function inspectModel(page, sample, group, appearance, shot, save, item) {
  const visual = page.locator('.desktop-host-visual');
  await wheelVisible(page, visual);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(450);
  await settled(page);
  const rest = await measure(page, sample.root);
  item.model = { passed: false, rest: sanitized(rest) };
  save();
  await shot(`${sample.name}-model-rest`);
  check(rest, sample, group, appearance);
  const point = await visual.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  assert.ok(point.x > 0 && point.x < group.width && point.y > 0 && point.y < group.height, 'Model hover point must be in the viewport');
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(450);
  await settled(page);
  const hover = await measure(page, sample.root);
  item.model.hover = sanitized(hover);
  save();
  await shot(`${sample.name}-model-hover`);
  check(hover, sample, group, appearance);
  await page.mouse.move(1, 1);
  item.model.passed = true;
}
async function search(page, shot) {
  const trigger = page.locator('.desktop-search-trigger');
  await trigger.waitFor();
  const before = await measure(page, '.desktop-main');
  await trigger.click();
  await page.locator('.desktop-search-surface').waitFor();
  await settled(page);
  assert.equal(
    await page.locator('.desktop-search-input input').evaluate((element) => element === document.activeElement),
    true,
    'Search must focus the actual input',
  );
  const opened = await measure(page, '.desktop-search-surface');
  const placeholder = await compactCopy.placeholder(page);
  compactCopy.checkPlaceholder(placeholder);
  assert.deepEqual(opened.words, [], 'Search ordinary words must remain whole');
  assert.deepEqual(opened.clipped, [], 'Search text must fit its allocation');
  assert.ok(
    opened.root.box.left >= 8 &&
      opened.root.box.right <= opened.viewport.width - 8 &&
      opened.root.box.top >= 8 &&
      opened.root.box.bottom <= opened.viewport.height - 8,
    'Search must retain viewport clearance',
  );
  await shot('search-open');
  await page.keyboard.press('Escape');
  await page.locator('.desktop-search-surface').waitFor({ state: 'detached' });
  await settled(page);
  const after = await measure(page, '.desktop-main');
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true, 'Search Escape must restore its real trigger');
  for (const key of Object.keys(before.scroll))
    assert.ok(Math.abs(after.scroll[key] - before.scroll[key]) <= 1, 'Search close must preserve actual prior reading position');
  return {
    passed: true,
    opened: sanitized(opened),
    placeholder,
    before: before.scroll,
    after: after.scroll,
    nativeEscape: true,
    returnedToTrigger: true,
  };
}
function checkFocusIdentity(value) {
  assert.equal(value.connected, true, 'Refresh must preserve the original connected control node');
  assert.equal(value.sameActive, true, 'Refresh must keep that exact original DOM control focused');
}
async function refresh(page, shot, save, result) {
  const target = page.locator('.host-processes-sort button').first();
  await target.waitFor();
  await wheelVisible(page, target);
  await target.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await settled(page);
  const before = await measure(page, '.desktop-route-window');
  checkFocus(before);
  const control = await target.elementHandle();
  assert.ok(control, 'The exact CPU sort control must exist before refresh');
  result.refresh = { passed: false, before: sanitized(before), actualEndpoint: '/api/system/host-processes', controlHandleDisposed: false };
  let primaryError;
  try {
    result.refresh.beforeIdentity = await control.evaluate((element) => ({
      connected: element.isConnected,
      sameActive: element === document.activeElement,
    }));
    checkFocusIdentity(result.refresh.beforeIdentity);
    await shot('before-natural-refresh');
    save();
    const received = await page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/system/host-processes' && response.request().method() === 'GET' && response.status() === 200,
      { timeout: 13000 },
    );
    await received.finished();
    await settled(page);
    const after = await measure(page, '.desktop-route-window');
    Object.assign(result.refresh, {
      after: sanitized(after),
      rawScrollChanged: !isDeepStrictEqual(before.scroll, after.scroll),
      anchorDelta: { top: after.active.box.top - before.active.box.top, bottom: after.active.box.bottom - before.active.box.bottom },
      actual200: true,
      afterIdentity: await control.evaluate((element) => ({ connected: element.isConnected, sameActive: element === document.activeElement })),
    });
    save();
    await shot('after-natural-refresh');
    checkFocus(after);
    checkFocusIdentity(result.refresh.afterIdentity);
    assert.equal(after.active.classes, before.active.classes, 'Refresh must retain the focused control');
    assert.ok(
      Math.abs(after.active.box.top - before.active.box.top) <= 1 && Math.abs(after.active.box.bottom - before.active.box.bottom) <= 1,
      'Refresh must retain the visible reading/focus anchor within one CSS pixel',
    );
    result.refresh.passed = true;
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await control.dispose();
      result.refresh.controlHandleDisposed = true;
    } catch (error) {
      result.refresh.controlHandleCleanupErrorHash = hash(error.message);
      result.refresh.passed = false;
      primaryError ??= error;
    }
  }
  if (primaryError) throw primaryError;
}

async function main() {
  process.umask(0o077);
  const report = {
    passed: false,
    release: null,
    groups: [],
    anonymousGroups: [],
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
    matchedIndependentPostOtaBaseline: false,
    observerRetained: false,
    cleanupFailures: [],
    diagnosticFailures: [],
    cleanup: { groupContextsClosed: 0, anonymousContextsClosed: 0, readerClosed: false, browserClosed: false },
    scope: {
      live: 'Actual immutable beta51 HTML/JS/CSS/images/API bodies and saved account appearance;30 authenticated route compositions plus4 anonymous Login/Reset views.',
      controlled:
        'Browser OS colour media matches the saved fixed mode (light for system); one320 doubled-computed-text group; documents alone use route.fetch/fulfill for CSP connect-src adjustment. Assets and API GET/HEAD use native browser transport. No response body substitutions.',
      writes: 'Only GET/HEAD are forwarded. No login/logout, preference, reset, TOTP, refresh, installation or lifecycle mutations.',
      protocol: 'Owned isolated plain HTTP loopback18080; no HTTPS or production acceptance claim.',
      screenshots: 'Actual viewport at natural route arrival, wheel and native focus positions; no scroll resets.',
      sourceFixtureMatricesRepeated: false,
      otherPresetsOrModesVerified: false,
    },
  };
  const privateData = {};
  const network = [];
  const originalForwardErrors = [];
  const errors = [];
  let config;
  let release;
  let before;
  let browser;
  let reader;
  let context;
  let page;
  let outputReady = false;
  let secrets = [];
  let stage = 'preflight';
  const fail = (error) => {
    const original = originalError(error);
    let trace = diagnosticError(error, secrets);
    trace = trace
      .split('\n')
      .filter((line) => !/\b(?:cookie|authorization|headers)\b/i.test(line) && !/^\s*-?\s*[a-z][a-z0-9-]*:\s*/i.test(line))
      .join('\n');
    errors.push({ stage, type: original.name || 'Error', redactedTrace: trace });
    report.failure = { stage, code: 'PUBLISHED_COMPACT_UI_AUDIT_FAILED', messageHash: hash(trace) };
  };
  const save = () => {
    if (!outputReady) return;
    privateWrite(path.join(config.output, 'private-baseline.json'), privateData);
    privateWrite(path.join(config.output, 'private-network.json'), network);
    privateWrite(path.join(config.output, 'private-original-forward-errors.json'), originalForwardErrors);
    privateWrite(path.join(config.output, 'private-errors.json'), errors);
    privateWrite(path.join(config.output, 'report.json'), { ...report, stage });
  };
  const read = async (target) => {
    const address = new URL(target, config.origin);
    assert.ok(
      target.startsWith('/api/') && address.origin === config.origin.origin && !address.search && !address.hash && !/[\r\n]/.test(target),
      'Only fixed owned direct API reads are permitted',
    );
    assert.ok(
      [
        '/api/system/build',
        '/api/user-context',
        '/api/app-context',
        '/api/desktop-preferences',
        '/api/apps/installed',
        '/api/marketplace/all',
        '/api/links',
      ].includes(address.pathname) || /^\/api\/apps\/[^/]+$/.test(address.pathname),
      'Direct API path is not reviewed',
    );
    const response = await reader.request.get(address.href, { maxRedirects: 0, timeout: 15000 });
    report.directReads[safePath(address.pathname)] = (report.directReads[safePath(address.pathname)] || 0) + 1;
    assert.equal(response.status(), 200, 'Actual authenticated direct read must return200');
    return response.json();
  };
  const buildExact = async () => {
    const build = await read('/api/system/build');
    assert.ok(
      build.version === expectedTag && build.commit === config.expectedCommit && build.imageDigest === config.expectedDigest,
      'Actual build differs from the reviewed published pins',
    );
  };
  const snapshot = async () => {
    const installed = await read('/api/apps/installed');
    assert.ok(Array.isArray(installed.installed), 'Full installed records are required');
    const apps = {};
    for (const item of installed.installed) {
      const urn = item.info?.urn;
      assert.ok(typeof urn === 'string' && urn.includes(':') && !Object.hasOwn(apps, urn), 'Installed identity must be valid and unique');
      apps[urn] = await read(`/api/apps/${encodeURIComponent(urn)}`);
      assert.equal(apps[urn].info?.urn, urn, 'Full installed app identity differs');
    }
    return {
      preferences: await read('/api/desktop-preferences'),
      installed,
      apps,
      stores: await read('/api/marketplace/all'),
      links: await read('/api/links'),
      userContext: await read('/api/user-context'),
      appContext: await read('/api/app-context'),
    };
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
    const goText = readOwnedInput(goPath);
    release = parsePrivate(releaseText, 'Release manifest');
    const prior = proofInputs(release, parsePrivate(goText, 'Independent GO proof'), priorText, config);
    const cookies = parseCookies(readOwnedInput(ownedCookieFile), config.origin.hostname);
    secrets = cookies.map((cookie) => cookie.value);
    temporaryOutput(config.output);
    assert.ok(!fs.existsSync(config.output), 'Use a fresh private output directory');
    privateDirectory(config.output);
    privateDirectory(path.join(config.output, 'screenshots'));
    outputReady = true;
    report.release = { tag: expectedTag, commit: config.expectedCommit, digest: config.expectedDigest };
    report.inputProofs = { releaseSha256: hash(releaseText), postOtaBaselineSha256: hash(priorText), goProofSha256: hash(goText) };
    report.execution = {
      runnerSha256: hash(fs.readFileSync(__filename)),
      browserUtilitiesSha256: hash(fs.readFileSync(require.resolve('./host-devices-checks.cjs'))),
      settingsInspectorSha256: hash(fs.readFileSync(require.resolve('./settings-alignment-checks.cjs'))),
      compactCopyInspectorSha256: hash(fs.readFileSync(require.resolve('./compact-copy-checks.cjs'))),
    };
    report.coreChecks.push(verifyCore(release.image));
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    await buildExact();
    before = await snapshot();
    privateData.before = before;
    samePrivate(before, prior, 'Actual full records differ from the independent post-OTA baseline');
    report.matchedIndependentPostOtaBaseline = true;
    const appearance = { mode: before.preferences.mode === 'system' ? 'light' : before.preferences.mode, preset: before.preferences.preset };
    report.appearance = { rawMode: before.preferences.mode, resolvedMode: appearance.mode, preset: appearance.preset, changed: false };
    const runGroup = async (group, samples, anonymous) => {
      stage = `${group.width}x${group.height}-text${group.textScale}${anonymous ? '-anonymous' : ''}`;
      const groupName = stage;
      const result = {
        ...group,
        anonymous,
        passed: false,
        samples: [],
        captures: [],
        cleanup: {
          textRestored: false,
          viewportRestored: false,
          listenersRestored: false,
          pageClosed: false,
          routesRestored: false,
          contextClosed: false,
        },
      };
      (anonymous ? report.anonymousGroups : report.groups).push(result);
      context = await browser.newContext({
        viewport: { width: group.width, height: group.height },
        colorScheme: appearance.mode,
        serviceWorkers: 'block',
      });
      if (!anonymous) await context.addCookies(cookies);
      const jobs = [];
      let closing = false;
      let navigation = 0;
      let nextRequest = 0;
      const requestIds = new WeakMap();
      const requestDetails = new WeakMap();
      const pending = new Map();
      const requestId = (request) => {
        if (!requestIds.has(request)) requestIds.set(request, ++nextRequest);
        return requestIds.get(request);
      };
      const requested = (request) => {
        if (request.isNavigationRequest()) navigation++;
        const entry = {
          event: 'request',
          at: Date.now(),
          group: groupName,
          stage,
          navigation,
          id: requestId(request),
          method: request.method(),
          url: diagnosticUrl(request.url()),
          kind: request.resourceType(),
        };
        pending.set(entry.id, entry);
        requestDetails.set(request, entry);
        network.push(entry);
      };
      const finished = (request) => {
        pending.delete(requestId(request));
        network.push({
          event: 'finished',
          at: Date.now(),
          group: groupName,
          stage,
          navigation,
          id: requestId(request),
          url: diagnosticUrl(request.url()),
        });
      };
      const failed = (request) => {
        const target = new URL(request.url());
        pending.delete(requestId(request));
        network.push({
          event: 'requestfailed',
          at: Date.now(),
          group: groupName,
          stage,
          navigation,
          id: requestId(request),
          url: diagnosticUrl(request.url()),
          kind: request.resourceType(),
          error: diagnosticError(request.failure()?.errorText || 'Request failed', secrets),
          closing,
        });
        if (
          !closing &&
          target.origin === config.origin.origin &&
          ['document', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType())
        )
          report.assetFailures.push({
            group: groupName,
            at: Date.now(),
            requestId: requestId(request),
            requestedNavigation: requestDetails.get(request)?.navigation,
            failureNavigation: navigation,
            path: safePath(target.pathname),
            kind: request.resourceType(),
            messageHash: hash(request.failure()?.errorText || 'Asset failed'),
          });
      };
      const responded = (response) => {
        const request = response.request();
        const target = new URL(response.url());
        network.push({
          event: 'response',
          at: Date.now(),
          group: groupName,
          stage,
          navigation,
          id: requestId(request),
          url: diagnosticUrl(response.url()),
          status: response.status(),
        });
        if (target.origin !== config.origin.origin) return;
        if (!response.ok() && response.status() !== 304)
          report.readFailures.push({ group: groupName, path: safePath(target.pathname), status: response.status() });
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
                const detail = {
                  event: 'asset-body-observer-failed',
                  at: Date.now(),
                  group: groupName,
                  stage,
                  requestId: requestId(request),
                  requestedNavigation: requestDetails.get(request)?.navigation,
                  failureNavigation: navigation,
                  url: diagnosticUrl(response.url()),
                  error: diagnosticError(error, secrets),
                  closing,
                };
                network.push(detail);
                if (!closing)
                  report.assetFailures.push({
                    group: groupName,
                    at: detail.at,
                    requestId: detail.requestId,
                    requestedNavigation: detail.requestedNavigation,
                    failureNavigation: navigation,
                    path: safePath(target.pathname),
                    kind,
                    messageHash: hash(error.message),
                  });
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
          report.blockedMutations.push({ group: groupName, method: request.method(), path: safePath(target.pathname) });
          return route.abort('blockedbyclient');
        }
        if (target.pathname.startsWith('/api/'))
          report.forwardedReads[safePath(target.pathname)] = (report.forwardedReads[safePath(target.pathname)] || 0) + 1;
        if (request.resourceType() !== 'document') return route.continue();
        const began = Date.now();
        network.push({
          event: 'forward-start',
          at: began,
          group: groupName,
          stage,
          navigation,
          id: requestId(request),
          url: diagnosticUrl(request.url()),
        });
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
          network.push({
            event: 'forward-response',
            at: Date.now(),
            group: groupName,
            stage,
            navigation,
            id: requestId(request),
            url: diagnosticUrl(request.url()),
            status: response.status(),
            elapsedMs: Date.now() - began,
          });
          if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) {
            report.blockedRedirects.push({ group: groupName, path: safePath(target.pathname), status: response.status() });
            return route.abort('blockedbyclient');
          }
          const headers = response.headers();
          if (request.resourceType() === 'document')
            headers['content-security-policy'] = headers['content-security-policy']
              ? `${headers['content-security-policy']}, connect-src 'self'`
              : "connect-src 'self'";
          return route.fulfill({ response, headers });
        } catch (error) {
          const original = originalError(error);
          originalForwardErrors.push({
            at: Date.now(),
            group: groupName,
            stage,
            navigation,
            id: requestId(request),
            requestUrl: request.url(),
            original,
          });
          try {
            privateWrite(path.join(config.output, 'private-original-forward-errors.json'), originalForwardErrors);
          } catch (writeError) {
            report.diagnosticFailures.push({
              stage,
              operation: 'preserveOriginalForwardError',
              messageHash: hash(safeDiagnosticText(originalError(writeError).message)),
            });
          }
          network.push({
            event: 'forward-exception',
            at: Date.now(),
            group: groupName,
            stage,
            navigation,
            id: requestId(request),
            url: diagnosticUrl(request.url()),
            error: diagnosticError(error, secrets),
            elapsedMs: Date.now() - began,
            closing,
          });
          if (!closing)
            report.readFailures.push({
              group: groupName,
              path: safePath(target.pathname),
              messageHash: hash(safeDiagnosticText(original.message || original.value)),
            });
          return route.abort('failed').catch(() => undefined);
        }
      };
      context.on('requestfailed', failed);
      context.on('request', requested);
      context.on('requestfinished', finished);
      context.on('response', responded);
      await context.route('**/*', handler);
      page = await context.newPage();
      const onError = (error) => report.pageErrors.push({ group: groupName, type: error.name, messageHash: hash(error.message) });
      page.on('pageerror', onError);
      const shot = async (name) => {
        const file = path.join(config.output, 'screenshots', `${groupName}-${name}-actual-viewport.png`);
        temporaryOutput(file);
        await page.screenshot({ path: file, fullPage: false });
        fs.chmodSync(file, 0o600);
        result.captures.push(path.basename(file));
      };
      try {
        for (const sample of samples) {
          stage = `${groupName}-${sample.name}`;
          await restoreText(page);
          await page.goto(`${config.origin.origin}${sample.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.locator(sample.ready).first().waitFor({ timeout: 20000 });
          if (sample.name === 'updates') {
            for (const label of [
              'Reading installed Orbis build…',
              'Checking published Orbis releases…',
              'Checking the local host service…',
              'Reading the host package cache…',
            ])
              await page.getByText(label, { exact: true }).waitFor({ state: 'hidden', timeout: 45000 });
          }
          await settled(page);
          await scaleText(page, group.textScale);
          await settled(page);
          const item = { name: sample.name, path: sample.path, passed: false };
          result.samples.push(item);
          const metrics = await measure(page, sample.root);
          item.metrics = sanitized(metrics);
          item.legacyUnder40 = sanitized(metrics.controls.filter((control) => !control.excludedChrome && control.legacy && control.box.height < 40));
          await shot(`${sample.name}-arrival`);
          // Auth intentionally has no account preferences; verify its actual defaults independently.
          const actualAppearance = anonymous ? { mode: metrics.theme.mode, preset: metrics.theme.preset } : appearance;
          check(metrics, sample, group, actualAppearance);
          assert.equal(await page.locator('.orbis-error-panel').count(), 0, 'Published route must not show fallback');
          if (sample.name === 'appearance') item.sharedGutters = sanitized(await inspectSettingsAlignment(page));
          if (sample.name === 'updates') {
            assert.equal(await page.locator('.desktop-update-image').count(), 1, 'Published installed digest must have its bounded row');
            item.digest = await compactCopy.digest(page);
            compactCopy.checkDigest(item.digest, config.expectedDigest);
          }
          if (sample.name === 'reset')
            assert.equal(
              await page.locator('.desktop-auth pre').textContent(),
              './runtipi-cli reset-password',
              'Actual reset command must remain complete',
            );
          if (sample.name === 'monitor') await inspectModel(page, sample, group, actualAppearance, shot, save, item);
          item.focus = await nativeFocus(page, sample);
          if (item.focus.checked) await shot(`${sample.name}-native-focus`);
          if (sample.name === 'home') {
            item.usage = await homeUsage(page, (name) => shot(`${sample.name}-${name}`));
            result.search = await search(page, (name) => shot(`${sample.name}-${name}`));
          }
          if (sample.name === 'monitor') {
            const lower = page.locator('#host-sensors-title');
            await wheelVisible(page, lower);
            item.lowerAtNaturalWheel = sanitized(await measure(page, sample.root));
            await shot(`${sample.name}-lower-reading`);
            if (group.refresh) await refresh(page, (name) => shot(`${sample.name}-${name}`), save, result);
          }
          await page.waitForFunction(
            () =>
              [...document.images].every((image) => {
                const r = image.getBoundingClientRect();
                return !r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight || (image.complete && image.naturalWidth > 0);
              }),
            null,
            { timeout: 15000 },
          );
          const imageDeadline = Date.now() + 15000;
          while ([...pending.values()].some((request) => request.kind === 'image') && Date.now() < imageDeadline) await page.waitForTimeout(100);
          assert.equal(
            [...pending.values()].some((request) => request.kind === 'image'),
            false,
            'Retain route until every requested image finishes',
          );
          await Promise.all(jobs);
          item.imagesFinishedBeforeNavigation = true;
          item.passed = true;
          save();
        }
        await Promise.all(jobs);
        assert.equal(result.samples.length, samples.length);
        result.passed = result.samples.every((sample) => sample.passed);
      } catch (error) {
        network.push({
          event: 'primary-rejection',
          at: Date.now(),
          group: groupName,
          stage,
          navigation,
          error: diagnosticError(error, secrets),
          pending: [...pending.values()],
        });
        save();
        await shot('FIRST-FAILURE').catch(() => {
          result.failureCaptureUnavailable = true;
        });
        try {
          result.failureGeometry = sanitized(
            await measure(page, samples.find((sample) => stage.endsWith(`-${sample.name}`))?.root || '.desktop-main'),
          );
        } catch {
          result.failureGeometryUnavailable = true;
        }
        throw error;
      } finally {
        network.push({ event: 'pending-inventory', at: Date.now(), group: groupName, stage, navigation, pending: [...pending.values()] });
        const attempt = async (name, action) => {
          try {
            await action();
            result.cleanup[name] = true;
          } catch (error) {
            report.cleanupFailures.push(`${groupName}:${name}`);
            fail(error);
          }
        };
        await attempt('textRestored', () => restoreText(page));
        await attempt('viewportRestored', () => page.setViewportSize({ width: group.width, height: group.height }));
        closing = true;
        await Promise.all(jobs);
        await attempt('listenersRestored', async () => {
          context.off('requestfailed', failed);
          context.off('request', requested);
          context.off('requestfinished', finished);
          context.off('response', responded);
          page.off('pageerror', onError);
          assert.equal(context.listeners('requestfailed').includes(failed), false);
          assert.equal(context.listeners('request').includes(requested), false);
          assert.equal(context.listeners('requestfinished').includes(finished), false);
          assert.equal(context.listeners('response').includes(responded), false);
          assert.equal(page.listeners('pageerror').includes(onError), false);
        });
        await attempt('pageClosed', () => page.close());
        page = undefined;
        await attempt('routesRestored', () => context.unroute('**/*', handler));
        await attempt('contextClosed', () => context.close());
        context = undefined;
        if (result.cleanup.contextClosed) report.cleanup[anonymous ? 'anonymousContextsClosed' : 'groupContextsClosed']++;
        if (!Object.values(result.cleanup).every(Boolean)) result.passed = false;
        save();
      }
    };
    for (const group of groups) {
      await buildExact();
      await runGroup(group, routes, false);
    }
    for (const group of groups.filter((group) => group.anonymous)) await runGroup(group, anonymousRoutes, true);
    stage = 'final-records';
    privateData.after = await snapshot();
    samePrivate(privateData.after, before, 'Full account/app/store/link records changed during read-only audit');
    report.recordsUnchanged = true;
    report.observerRetained = privateData.after.userContext.isLoggedIn === true;
    await buildExact();
    const finalCore = verifyCore(release.image);
    report.coreChecks.push(finalCore);
    samePrivate(finalCore, report.coreChecks[0], 'Core identity/image/start/owned binds changed during audit');
    assert.equal(report.groups.length, 5);
    assert.equal(report.anonymousGroups.length, 2);
    assert.ok([...report.groups, ...report.anonymousGroups].every((group) => group.passed));
    assert.equal(report.groups.flatMap((group) => group.samples).length, 30);
    assert.equal(report.anonymousGroups.flatMap((group) => group.samples).length, 4);
    report.passed = true;
  } catch (error) {
    fail(error);
  } finally {
    if (reader && before) {
      try {
        privateData.after = await snapshot();
        samePrivate(privateData.after, before, 'Final full account/app/store/link records changed');
        report.recordsUnchanged = true;
        report.observerRetained = privateData.after.userContext.isLoggedIn === true;
      } catch (error) {
        fail(error);
        report.passed = false;
      }
    }
    if (page)
      try {
        await restoreText(page);
        await page.close();
      } catch (error) {
        fail(error);
        report.cleanupFailures.push('emergencyPageClose');
      }
    if (context)
      try {
        await context.close();
      } catch (error) {
        fail(error);
        report.cleanupFailures.push('emergencyContextClose');
      }
    if (reader)
      try {
        await reader.close();
        report.cleanup.readerClosed = true;
      } catch (error) {
        fail(error);
        report.cleanupFailures.push('readerClosed');
      }
    if (browser)
      try {
        await browser.close();
        report.cleanup.browserClosed = true;
      } catch (error) {
        fail(error);
        report.cleanupFailures.push('browserClosed');
      }
    for (const name of [
      'blockedMutations',
      'blockedRedirects',
      'readFailures',
      'assetFailures',
      'pageErrors',
      'cleanupFailures',
      'diagnosticFailures',
    ])
      if (report[name].length) report.passed = false;
    if (errors.length || report.externalRequestsBlocked || !report.recordsUnchanged || !report.observerRetained) report.passed = false;
    if (!report.cleanup.readerClosed || !report.cleanup.browserClosed) report.passed = false;
    report.counts = {
      authenticatedCompositions: report.groups.flatMap((group) => group.samples).filter((sample) => sample.passed).length,
      anonymousCompositions: report.anonymousGroups.flatMap((group) => group.samples).filter((sample) => sample.passed).length,
      realApiReads:
        Object.values(report.directReads).reduce((sum, value) => sum + value, 0) +
        Object.values(report.forwardedReads).reduce((sum, value) => sum + value, 0),
      publishedAssets: Object.keys(report.assets).length,
    };
    save();
    process.stdout.write(
      `${JSON.stringify({ passed: report.passed, stage, counts: report.counts, report: outputReady ? path.join(config.output, 'report.json') : null, code: report.failure?.code || null })}\n`,
    );
    if (!report.passed) process.exitCode = 1;
  }
  return report;
}

function selfCheck() {
  const digest = reviewedDigest || `sha256:${'a'.repeat(64)}`;
  const pureOptions = (env, argv) => validateOptions(env, argv, digest);
  const env = {
    ORBIS_ALLOW_LIVE_COMPACT_UI_AUDIT: '1',
    ORBIS_AUDIT_EXPECTED_TAG: expectedTag,
    ORBIS_AUDIT_EXPECTED_COMMIT: reviewedCommit,
    ORBIS_AUDIT_EXPECTED_DIGEST: digest,
    ORBIS_AUDIT_COOKIE_FILE: ownedCookieFile,
    ORBIS_AUDIT_RELEASE_FILE: releasePath,
    ORBIS_AUDIT_BASELINE_FILE: baselinePath,
    ORBIS_AUDIT_GO_FILE: goPath,
    ORBIS_AUDIT_OUTPUT_DIR: '/tmp/orbis-compact-self-check-output',
  };
  const config = pureOptions(env, ['--allow-owned-published-compact-ui']);
  if (!reviewedDigest) assert.throws(() => options(env, ['--allow-owned-published-compact-ui']), /not pinned/);
  const baseline = JSON.stringify({
    preferences: { mode: 'dark', preset: 'frost' },
    installed: {},
    apps: {},
    stores: {},
    links: {},
    userContext: { isLoggedIn: true },
    appContext: { user: { hasSeenWelcome: true, locale: 'en' } },
  });
  const release = { tag: expectedTag, commit: reviewedCommit, image: `ghcr.io/twentylines/orbis@${digest}` };
  const proof = {
    schema: 'orbis.compact-ui-go.v1',
    passed: true,
    release: { ...release },
    dockerContext,
    root: installRoot,
    baseUrl,
    checks: { reviewedOtaComplete: true, independentDataPreservationPassed: true },
    recordBaselineSha256: hash(baseline),
  };
  proofInputs(release, proof, baseline, config);
  const core = {
    image: release.image,
    imageId: digest,
    running: true,
    paused: false,
    health: 'healthy',
    startedAt: '2026-10-18T00:00:00Z',
    ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] },
    mounts: Object.entries({
      '/data/.env': '.env',
      '/data/apps': 'apps',
      '/data/repos': 'repos',
      '/data/user-config': 'user-config',
      '/data/state': 'state',
      '/app-data': 'app-data',
    }).map(([Destination, relative]) => ({ Type: 'bind', Source: path.join(installRoot, relative), Destination })),
  };
  guardCore(core, release.image);
  let negatives = 0;
  for (const [key, value] of [
    ['ORBIS_ALLOW_LIVE_COMPACT_UI_AUDIT', '0'],
    ['ORBIS_AUDIT_EXPECTED_TAG', 'v0.1.0-beta.46'],
    ['ORBIS_AUDIT_EXPECTED_COMMIT', 'b'.repeat(40)],
    ['ORBIS_AUDIT_EXPECTED_DIGEST', 'latest'],
    ['ORBIS_AUDIT_COOKIE_FILE', '/tmp/other'],
    ['ORBIS_AUDIT_BASELINE_FILE', '/tmp/other'],
    ['ORBIS_AUDIT_RELEASE_FILE', '/tmp/other'],
    ['ORBIS_AUDIT_GO_FILE', '/tmp/other'],
    ['ORBIS_AUDIT_URL', 'http://127.0.0.1:18082'],
    ['ORBIS_AUDIT_URL', 'http://localhost:18080'],
    ['ORBIS_AUDIT_OUTPUT_DIR', '/tmp/../private'],
  ]) {
    assert.throws(() => pureOptions({ ...env, [key]: value }, ['--allow-owned-published-compact-ui']));
    negatives++;
  }
  assert.throws(() => pureOptions(env, []));
  negatives++;
  for (const change of [
    (value) => {
      value.passed = false;
    },
    (value) => {
      value.recordBaselineSha256 = '0'.repeat(64);
    },
    (value) => {
      value.release.commit = 'b'.repeat(40);
    },
    (value) => {
      value.dockerContext = 'default';
    },
    (value) => {
      value.root = '/tmp/unowned';
    },
    (value) => {
      value.baseUrl = 'http://127.0.0.1:18082';
    },
    (value) => {
      value.checks.independentDataPreservationPassed = false;
    },
  ]) {
    const altered = structuredClone(proof);
    change(altered);
    assert.throws(() => proofInputs(release, altered, baseline, config));
    negatives++;
  }
  for (const change of [
    (value) => {
      value.ports['3000/tcp'][0].HostIp = '0.0.0.0';
    },
    (value) => {
      value.ports['3000/tcp'][0].HostPort = '18082';
    },
    (value) => {
      value.ports['80/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '18081' }];
    },
    (value) => {
      value.mounts[0].Source = '/tmp/unowned';
    },
    (value) => {
      value.mounts.push({ Type: 'bind', Source: '/tmp/unowned', Destination: '/data/state/override' });
    },
    (value) => {
      value.paused = true;
    },
    (value) => {
      value.health = 'unhealthy';
    },
    (value) => {
      value.image = 'ghcr.io/twentylines/orbis:latest';
    },
    (value) => {
      value.startedAt = '';
    },
  ]) {
    const altered = structuredClone(core);
    change(altered);
    assert.throws(() => guardCore(altered, release.image));
    negatives++;
  }
  assert.equal(alpha('rgba(0, 0, 0, 0)'), 0);
  assert.equal(alpha('rgba(17, 38, 36, 0.82)'), 0.82);
  assert.equal(groups.length * routes.length, 30);
  assert.equal(groups.filter((group) => group.anonymous).length * anonymousRoutes.length, 4);
  checkFocusIdentity({ connected: true, sameActive: true });
  assert.throws(() => checkFocusIdentity({ connected: false, sameActive: true }));
  assert.throws(() => checkFocusIdentity({ connected: true, sameActive: false }));
  const ansiOrigin = `${baseUrl}\u001b[22m`;
  assert.throws(() => new URL(ansiOrigin), { code: 'ERR_INVALID_URL' });
  assert.equal(diagnosticUrl(ansiOrigin), `${baseUrl}/`);
  const malformed = [
    'http://',
    'https://[',
    'http://127.0.0.1:invalid',
    '',
    null,
    undefined,
    {
      toString() {
        throw new Error('denied string conversion');
      },
    },
  ];
  for (const value of malformed) assert.doesNotThrow(() => diagnosticUrl(value));
  const raw = new Error(`route.fetch failed at ${ansiOrigin}/assets/file.js?token=private-probe`);
  const original = originalError(raw);
  assert.equal(original.message, raw.message);
  assert.equal(original.stack, raw.stack);
  const formatted = diagnosticError(raw, ['private-probe']);
  assert.ok(!formatted.includes('\u001b') && !formatted.includes('token=') && !formatted.includes('private-probe'));
  for (const value of [
    null,
    undefined,
    {
      get stack() {
        throw new Error('denied stack');
      },
    },
    {
      toString() {
        throw new Error('denied conversion');
      },
    },
  ])
    assert.doesNotThrow(() => diagnosticError(value));
  const priorEnlargedBoxes = [
    {
      text: 'Applications',
      local: { left: 96, right: 310.765625 },
      bounds: { left: 60, right: 260 },
      ink: [{ left: 96, right: 310.765625 }],
    },
    {
      text: 'Backups',
      local: { left: 124, right: 220 },
      bounds: { left: 60, right: 260 },
      ink: [{ left: 124, right: 234.40625 }],
    },
    {
      text: '37.5%',
      local: { left: 175.3125, right: 278.625 },
      bounds: { left: 62, right: 258 },
      ink: [{ left: 175.3125, right: 278.625 }],
    },
  ];
  for (const value of priorEnlargedBoxes) assert.throws(() => checkCriticalInk([value]));
  checkCriticalInk([
    { text: 'Applications', local: { left: 60, right: 260 }, bounds: { left: 60, right: 260 }, ink: [{ left: 60, right: 241.96875 }] },
  ]);
  const spacing = {
    viewport: { width: 768 },
    criticalInk: [],
    applicationCardFit: { card: { bottom: 500 }, action: { bottom: 485 }, paddingBottom: 14, borderBottom: 1, actionMarginBottom: 0 },
    stackedMachineClearance: { gap: 19.75439453125 },
  };
  checkRouteSpacing(spacing, { name: 'updates' });
  checkRouteSpacing(spacing, { name: 'monitor' });
  assert.throws(() =>
    checkRouteSpacing({ ...spacing, applicationCardFit: { ...spacing.applicationCardFit, card: { bottom: 688.5 } } }, { name: 'updates' }),
  );
  assert.throws(() => checkRouteSpacing({ ...spacing, stackedMachineClearance: { gap: -12.245635 } }, { name: 'monitor' }));
  return {
    passed: true,
    browserStarted: false,
    runtimeReads: 0,
    credentialsRead: false,
    positiveGuardFamilies: 3,
    rejectedUnsafeCases: negatives,
    authenticatedCompositions: 30,
    anonymousCompositions: 4,
    focusIdentityNegatives: 2,
    loggerMalformedUrlCases: malformed.length + 1,
    loggerErrorShapeCases: 4,
    originalLoggerAnsiNegativeReproduced: true,
    priorEnlargedBoxNegatives: priorEnlargedBoxes.length,
    routeSpacingNegatives: 2,
    releaseDigestPinned: Boolean(reviewedDigest),
    unpinnedLiveGuardChecked: !reviewedDigest,
  };
}
if (require.main === module) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--self-check') process.stdout.write(`${JSON.stringify(selfCheck())}\n`);
  else
    main().catch(() => {
      process.stderr.write('PUBLISHED_COMPACT_UI_AUDIT_FAILED\n');
      process.exitCode = 1;
    });
}
module.exports = { main, selfCheck };
