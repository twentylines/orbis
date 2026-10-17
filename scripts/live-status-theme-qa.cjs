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
  assert.ok(['ps', 'inspect'].includes(args[0]), 'Only read-only Docker inspection is permitted');
  const result = spawnSync('docker', ['--context', dockerContext, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.ok(!result.error && result.status === 0, 'Owned Docker inspection failed');
  return result.stdout;
}

function verifyCore(image) {
  const ids = readDocker(['ps', '-q', '--filter', 'label=com.docker.compose.service=runtipi']).trim().split('\n').filter(Boolean);
  assert.equal(ids.length, 1, 'Exactly one running core is required in the owned Docker context');
  const format =
    '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"mounts":{{json .Mounts}}}';
  const core = parsePrivate(readDocker(['inspect', '--format', format, ids[0]]), 'Owned core inspection');
  assert.equal(core.image, image, 'Owned core image differs from the expected published image');
  assert.match(core.imageId, /^sha256:[a-f0-9]{64}$/, 'Owned core image identity is invalid');
  const imageDigests = parsePrivate(
    readDocker(['inspect', '--type', 'image', '--format', '{{json .RepoDigests}}', core.imageId]),
    'Owned image digests',
  );
  assert.ok(Array.isArray(imageDigests) && imageDigests.includes(image), 'Running image does not contain the pinned published digest');
  assert.ok(core.running && !core.paused && core.health === 'healthy', 'Owned core must be running, unpaused and healthy');
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

const presets = ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'];
const viewports = [
  { width: 1440, height: 1120 },
  { width: 390, height: 844 },
];

async function settleNative(page, selector) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document.getAnimations().filter((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return timing && Number.isFinite(timing.endTime) && timing.endTime <= 4000 && animation.playState !== 'finished';
    });
    let timeout;
    try {
      await Promise.race([
        Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Finite navigation or machine animation did not finish')), 4500);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  });
  await page.evaluate(async (target) => {
    const surface = document.querySelector(target);
    let previous = '';
    let stable = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)));
      const box = surface.getBoundingClientRect();
      const machine = surface.querySelector('.desktop-host-machine')?.getBoundingClientRect();
      const frame = document.querySelector('.desktop-route-window');
      const content = frame?.querySelector('.desktop-window-content');
      const current = [
        scrollX,
        scrollY,
        frame?.scrollTop || 0,
        content?.scrollTop || 0,
        box.x,
        box.y,
        box.width,
        box.height,
        machine?.x || 0,
        machine?.y || 0,
        machine?.width || 0,
        machine?.height || 0,
      ]
        .map((number) => Math.round(number * 10) / 10)
        .join(',');
      stable = current === previous ? stable + 1 : 0;
      if (stable >= 3) return;
      previous = current;
    }
    throw new Error('Native status geometry did not settle');
  }, selector);
}

async function inspectSurface(page, surface) {
  return page.locator(surface === 'home' ? '.workspace-activity' : '.desktop-host-overview').evaluate((element, kind) => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const resolveColor = (property, variable) => {
      const probe = document.createElement('span');
      Object.assign(probe.style, { position: 'absolute', width: '0', height: '0', visibility: 'hidden' });
      probe.style.setProperty(property, `var(${variable})`);
      element.append(probe);
      const result = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return result;
    };
    const splitGradient = (value) => {
      const parts = [];
      let depth = 0;
      let start = 0;
      for (let index = 0; index < value.length; index++) {
        if (value[index] === '(') depth++;
        else if (value[index] === ')') depth--;
        else if (value[index] === ',' && depth === 0) {
          parts.push(value.slice(start, index).trim());
          start = index + 1;
        }
      }
      parts.push(value.slice(start).trim());
      return parts;
    };
    const luminance = (color) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const data = [...context.getImageData(0, 0, 1, 1).data];
      const linear = data.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return { color, rgba: data, luminance: linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 };
    };
    const style = getComputedStyle(element);
    const heading = element.querySelector('h2');
    const muted = element.querySelector(kind === 'home' ? '.workspace-section-heading p' : '.desktop-host-overview-readings span');
    const gradient = style.backgroundImage;
    const gradientBody = gradient.match(/^linear-gradient\((.*)\)$/)?.[1];
    const colors = gradientBody ? splitGradient(gradientBody).filter((value) => CSS.supports('color', value)) : [];
    const gradientColors = colors.map(luminance);
    const surfaceBox = box(element);
    const wordIssues = [];
    const paintIssues = [];
    let wordCount = 0;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest('[aria-hidden="true"],.visually-hidden,.sr-only,svg,script,style') || !parent.getClientRects().length) continue;
      const text = node.textContent;
      for (const match of text.matchAll(/[A-Za-z][A-Za-z'-]{3,}/g)) {
        wordCount++;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
        if (new Set(rects.map((rect) => Math.round(rect.y))).size > 1) wordIssues.push({ word: match[0], reason: 'fractured' });
        if (
          rects.some(
            (rect) =>
              rect.left < surfaceBox.left - 1 ||
              rect.right > surfaceBox.right + 1 ||
              rect.top < surfaceBox.top - 1 ||
              rect.bottom > surfaceBox.bottom + 1,
          )
        )
          paintIssues.push({ word: match[0], reason: 'outside-card' });
        const whole = parent.closest('.orbis-whole-word');
        if (whole && whole.scrollWidth > whole.clientWidth + 1) wordIssues.push({ word: match[0], reason: 'ellipsis' });
      }
    }
    const bar = document.querySelector('.desktop-system-bar');
    const dock = document.querySelector('.desktop-dock');
    const frame = element.closest('.desktop-route-window');
    const content = frame?.querySelector('.desktop-window-content');
    const windowBar = frame?.querySelector('.desktop-window-bar');
    const labels =
      kind === 'home'
        ? [
            ...element.querySelectorAll(
              '.workspace-gauge > span:last-child,.workspace-network-heading,.workspace-status-storage > span,.workspace-status-storage > small',
            ),
          ].map((node) => node.textContent.trim())
        : [...element.querySelectorAll('.desktop-host-overview-readings span')].map((node) => node.textContent.trim());
    const nodeOverflow = [
      ...element.querySelectorAll(
        'h2,p,strong,.workspace-gauge > span:last-child,.workspace-network-heading,.workspace-network-rate,.workspace-status-storage > span,.workspace-status-storage > small,.desktop-host-overview-readings span',
      ),
    ]
      .filter((node) => !node.closest('[aria-hidden="true"]') && node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({ tag: node.tagName, className: node.className }));
    return {
      surface: kind,
      card: surfaceBox,
      heading: heading.textContent.trim(),
      labels,
      wordCount,
      wordIssues,
      paintIssues,
      nodeOverflow,
      background: gradient,
      gradientColors,
      backgroundLuminance: gradientColors.length ? gradientColors.reduce((sum, item) => sum + item.luminance, 0) / gradientColors.length : null,
      colors: { ink: style.color, heading: getComputedStyle(heading).color, muted: getComputedStyle(muted).color, edge: style.borderTopColor },
      readingColors: [...element.querySelectorAll(kind === 'home' ? '.workspace-dial strong' : '.desktop-host-overview-readings strong')].map(
        (node) => getComputedStyle(node).color,
      ),
      expectedBackground: resolveColor('background-image', '--desktop-status-background'),
      expectedColors: {
        ink: resolveColor('color', '--desktop-ink'),
        muted: resolveColor('color', '--desktop-status-muted'),
        edge: resolveColor('color', '--desktop-edge'),
      },
      bar: box(bar),
      dock: box(dock),
      outerScroll: { x: scrollX, y: scrollY },
      documentWidth: document.documentElement.scrollWidth,
      frame: frame
        ? {
            ...box(frame),
            navigation: frame.dataset.windowNavigation,
            mode: frame.dataset.windowMode,
            scrollTop: frame.scrollTop,
            contentScrollTop: content.scrollTop,
            header: box(windowBar),
            headerScrollHeight: windowBar.scrollHeight,
            headerClientHeight: windowBar.clientHeight,
            transitionName: getComputedStyle(frame).viewTransitionName,
            contentTransitionName: getComputedStyle(content).viewTransitionName,
            background: getComputedStyle(frame).backgroundColor,
            filter: getComputedStyle(frame).backdropFilter,
            headerFilter: getComputedStyle(windowBar).backdropFilter,
            dockFilter: getComputedStyle(dock).backdropFilter,
            topFilter: getComputedStyle(bar).backdropFilter,
            border: getComputedStyle(frame).borderTopColor,
            controls: frame.querySelectorAll('.desktop-window-controls,.desktop-window-resize,.desktop-window-resume').length,
            toolbar: frame.querySelectorAll('[role="toolbar"]').length,
          }
        : null,
    };
  }, surface);
}

function checkSurface(metrics, viewport) {
  assert.equal(metrics.heading, 'System status', 'System status heading must be complete');
  assert.ok(metrics.wordCount > 0 && metrics.gradientColors.length >= 2, 'Real status text and resolved gradient colors are required');
  assert.equal(metrics.background, metrics.expectedBackground, 'Status background must use the active shared theme palette');
  samePrivate(metrics.wordIssues, [], 'An ordinary status word fractured or was ellipsized');
  samePrivate(metrics.paintIssues, [], 'Status text escaped its native card');
  samePrivate(metrics.nodeOverflow, [], 'Status labels or values overflow their own layout');
  assert.ok(metrics.documentWidth <= viewport.width + 1, 'Status view overflows the document');
  assert.ok(metrics.card.left >= 0 && metrics.card.right <= viewport.width + 1, 'Status card must fit horizontally');
  samePrivate(
    metrics.colors,
    { ink: metrics.expectedColors.ink, heading: metrics.expectedColors.ink, muted: metrics.expectedColors.muted, edge: metrics.expectedColors.edge },
    'Status ink, muted text or edge does not follow the active theme',
  );
  assert.ok(
    metrics.readingColors.length === 2 && metrics.readingColors.every((color) => color === metrics.expectedColors.ink),
    'Numeric status readings must use the active theme ink',
  );
  assert.ok(
    metrics.labels.includes('Host memory') && metrics.labels.some((label) => /^(Host|Core) CPU$/.test(label)),
    'Real CPU and memory labels must be complete',
  );
  if (metrics.surface === 'home') {
    for (const label of ['Core network', 'Storage', 'Orbis core filesystem'])
      assert.ok(metrics.labels.includes(label), 'Home status labels must be complete');
    assert.equal(metrics.frame, null, 'Home must remain the normal workspace');
  } else {
    assert.ok(metrics.frame, 'Monitor must use the actual tool frame');
    assert.equal(metrics.frame.scrollTop, 0, 'Monitor frame must start at its native top');
    assert.equal(metrics.frame.contentScrollTop, 0, 'Monitor content must start at its native top');
    assert.ok(
      metrics.frame.header.top >= metrics.frame.top - 1 &&
        metrics.frame.header.left >= metrics.frame.left - 1 &&
        metrics.frame.header.right <= metrics.frame.right + 1 &&
        metrics.frame.header.bottom <= metrics.frame.bottom + 1 &&
        metrics.frame.header.top >= metrics.bar.bottom + 8 &&
        metrics.frame.header.bottom <= metrics.dock.top,
      'Monitor header must remain complete and clear of fixed chrome',
    );
    assert.ok(metrics.frame.headerScrollHeight <= metrics.frame.headerClientHeight + 1, 'Monitor header content must not be clipped');
    if (viewport.width < 1100 || viewport.height < 640) {
      assert.equal(metrics.frame.navigation, 'page');
      assert.equal(metrics.frame.mode, 'page');
      assert.equal(metrics.frame.transitionName, 'orbis-section');
      assert.equal(metrics.frame.contentTransitionName, 'none');
      assert.equal(metrics.frame.controls, 0);
      assert.equal(metrics.frame.toolbar, 0);
    } else {
      assert.equal(metrics.frame.navigation, 'desktop');
      assert.equal(metrics.frame.mode, 'focused');
      assert.equal(metrics.frame.transitionName, 'none', 'Desktop frame must not isolate the glass header in a view-transition backdrop root');
      assert.equal(metrics.frame.contentTransitionName, 'orbis-section', 'Desktop section slides must remain on window content');
      assert.equal(metrics.frame.background, 'rgba(0, 0, 0, 0)', 'Desktop frame must not add a pale layer below the header');
      assert.equal(metrics.frame.filter, 'none', 'Desktop frame must not blur the entire window');
      assert.equal(metrics.frame.headerFilter, 'blur(28px) saturate(1.45)');
      assert.equal(metrics.frame.headerFilter, metrics.frame.dockFilter);
      assert.equal(metrics.frame.headerFilter, metrics.frame.topFilter);
    }
    assert.equal(metrics.frame.border, 'rgba(0, 0, 0, 0)', 'Tool frame must not have a bright rim');
  }
  assert.ok(
    metrics.bar.top >= 0 && metrics.bar.left >= 0 && metrics.bar.right <= viewport.width && metrics.bar.bottom < metrics.dock.top,
    'Published system bar must remain wholly inside the native viewport',
  );
  samePrivate(metrics.outerScroll, { x: 0, y: 0 }, 'Native capture must not reset or move document scroll');
}

async function main() {
  process.umask(0o077);
  let origin;
  let release;
  let before;
  let browser;
  let reader;
  let cookies;
  let outputReady = false;
  let stage = 'preflight';
  const expectedCommit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
  const expectedDigest = process.env.ORBIS_AUDIT_EXPECTED_DIGEST;
  const output = process.env.ORBIS_AUDIT_OUTPUT_DIR || '/tmp/orbis-live-status-theme';
  const screenshotDir = path.join(output, 'screenshots');
  const reportFile = path.join(output, 'report.json');
  const baselineFile = path.join(output, 'private-baseline.json');
  const baseline = {};
  const report = {
    passed: false,
    release: null,
    source: {
      live: [
        'Published authenticated HTML, JavaScript, CSS and actual API reads',
        'Actual account/server name, workspace, installed/full app records, stores and host telemetry',
      ],
      controlled: [
        'Browser-only preference GET/PUT shadow: requested mode/preset and empty desktop placement; actual serverName/workspace unchanged',
        'Browser-only restrictive connect-src self response header; published HTML/JS/CSS bodies remain unchanged, response headers are not claimed identical',
      ],
      realPreferenceWrites: 0,
      realAppHostOrSessionWrites: 0,
      capture: 'Native viewport captures at natural route top; Home adds separately labelled CDP full-card clips without scrolling',
    },
    compositions: [],
    assets: {},
    forwardedReads: {},
    shadowPreferenceGets: 0,
    shadowPreferencePuts: 0,
    externalRequestsBlocked: 0,
    blockedMutations: [],
    blockedRedirects: [],
    readFailures: [],
    assetFailures: [],
    pageErrors: [],
    coreChecks: [],
    recordsUnchanged: false,
    cleanupFailures: [],
  };
  const save = () => privateWrite(reportFile, { ...report, stage });
  const read = async (endpoint) => {
    assert.ok(endpoint.startsWith('/api/') && !endpoint.includes('?') && !endpoint.includes('#'), 'Only fixed authenticated API reads are permitted');
    const response = await reader.request.get(`${origin.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
    assert.ok(response.ok(), 'Authenticated status audit GET failed');
    return response.json();
  };
  const verifyBuild = (build) =>
    assert.ok(
      build.version === expectedTag && build.commit === expectedCommit && build.imageDigest === expectedDigest,
      'Actual published build differs from independent release pins',
    );
  const snapshot = async () => {
    const installed = await read('/api/apps/installed');
    assert.ok(Array.isArray(installed.installed), 'Actual installed app records are required');
    const apps = {};
    for (const item of installed.installed) {
      const urn = item.info?.urn;
      assert.ok(typeof urn === 'string' && urn.includes(':') && !Object.hasOwn(apps, urn), 'Installed identity is invalid or duplicated');
      apps[urn] = await read(`/api/apps/${encodeURIComponent(urn)}`);
      assert.equal(apps[urn].info?.urn, urn, 'Full app identity mismatch');
    }
    return { preferences: await read('/api/desktop-preferences'), installed, apps, stores: await read('/api/marketplace/all') };
  };
  try {
    assert.equal(process.env.ORBIS_ALLOW_STATUS_THEME_AUDIT, '1', 'Explicit read-only published status audit opt-in is required');
    const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
    const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
    assert.ok(cookieFile && releaseFile && expectedTag && expectedCommit && expectedDigest, 'Independent release pins and owned inputs are required');
    assert.equal(cookieFile, ownedCookieFile);
    assert.match(expectedTag, /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/);
    assert.match(expectedCommit, /^[a-f0-9]{40}$/);
    assert.match(expectedDigest, /^sha256:[a-f0-9]{64}$/);
    origin = new URL(process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080');
    assert.ok(
      ['127.0.0.1', 'localhost'].includes(origin.hostname) &&
        origin.protocol === 'http:' &&
        origin.port === '18080' &&
        origin.pathname === '/' &&
        !origin.username &&
        !origin.password &&
        !origin.search &&
        !origin.hash,
      'Only owned HTTP loopback18080 is permitted',
    );
    const stat = fs.lstatSync(installRoot);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && fs.realpathSync(installRoot) === installRoot,
      'Install root ownership mismatch',
    );
    release = parsePrivate(readOwnedInput(releaseFile), 'Release manifest');
    assert.ok(
      release.tag === expectedTag && release.commit === expectedCommit && release.image === `ghcr.io/twentylines/orbis@${expectedDigest}`,
      'Manifest differs from independent pins',
    );
    cookies = parseCookies(readOwnedInput(cookieFile), origin.hostname);
    privateDirectory(output);
    privateDirectory(screenshotDir);
    outputReady = true;
    report.release = { tag: release.tag, commit: release.commit, image: release.image };
    report.coreChecks.push(verifyCore(release.image));
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    verifyBuild(await read('/api/system/build'));
    assert.equal((await read('/api/user-context')).isLoggedIn, true, 'Private isolated session must authenticate');
    const appContext = await read('/api/app-context');
    assert.ok(appContext.user?.hasSeenWelcome && appContext.user?.locale === 'en', 'Existing English account onboarding must be complete');
    before = await snapshot();
    baseline.before = before;
    assert.ok(
      before.preferences.workspace && !before.preferences.workspace.hidden.includes('activity'),
      'Actual workspace must include System status; the audit will not change widget selection',
    );
    baseline.telemetryReadiness = { telemetry: await read('/api/system/telemetry'), containers: await read('/api/system/containers') };
    const telemetry = baseline.telemetryReadiness.telemetry;
    assert.ok(Number.isFinite(telemetry.cpu?.uptimeSeconds) && telemetry.memory?.totalBytes > 0, 'Real host telemetry must be ready');
    privateWrite(baselineFile, baseline);
    for (const viewport of viewports)
      for (const mode of ['light', 'dark'])
        for (const preset of presets) {
          const pairStage = `${viewport.width}-${mode}-${preset}`;
          stage = `${pairStage}-published-build`;
          verifyBuild(await read('/api/system/build'));
          const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
          let closing = false;
          let shadow = { ...clone(before.preferences), mode, preset, windows: {} };
          const jobs = [];
          const assetCounts = { documents: 0, scripts: 0, stylesheets: 0 };
          const readiness = {};
          const prefix = `${viewport.width}x${viewport.height}-${mode}-${preset}`;
          try {
            await context.addCookies(cookies);
            await context.addInitScript(
              ({ key, value, origin }) => {
                if (window === window.top && location.origin === origin) localStorage.setItem(key, JSON.stringify(value));
              },
              { key: preferenceKey, value: shadow, origin: origin.origin },
            );
            context.on('response', (response) => {
              const request = response.request();
              const target = new URL(request.url());
              if (target.origin !== origin.origin || !response.ok()) return;
              if (target.pathname.startsWith('/api/') && target.pathname !== '/api/desktop-preferences')
                readiness[target.pathname] = (readiness[target.pathname] || 0) + 1;
              const key = { document: 'documents', script: 'scripts', stylesheet: 'stylesheets' }[request.resourceType()];
              if (!key) return;
              jobs.push(
                response
                  .body()
                  .then((body) => {
                    assetCounts[key]++;
                    const record = { resource: key, bytes: body.length, sha256: hash(body) };
                    report.assets[`${target.pathname}:${record.sha256}`] = record;
                  })
                  .catch(() => report.assetFailures.push({ case: prefix, path: target.pathname, resource: key })),
              );
            });
            await context.route('**/*', async (route) => {
              const request = route.request();
              const target = new URL(request.url());
              if (target.origin !== origin.origin) {
                report.externalRequestsBlocked++;
                return route.abort('blockedbyclient');
              }
              const respond = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
              if (target.pathname === '/api/desktop-preferences') {
                if (target.search) {
                  report.blockedMutations.push({
                    case: prefix,
                    method: request.method(),
                    path: target.pathname,
                    reason: 'unexpected-preference-query',
                  });
                  return route.abort('blockedbyclient');
                }
                if (request.method() === 'GET') {
                  report.shadowPreferenceGets++;
                  return respond(shadow);
                }
                if (request.method() === 'PUT') {
                  try {
                    const next = parsePrivate(request.postData() || '', 'Browser-only preferences');
                    assert.ok(next.mode === mode && next.preset === preset, 'Shadow appearance differs from this requested composition');
                    samePrivate(next.windows, {}, 'Shadow placement must remain the native default');
                    samePrivate(
                      { ...next, mode: before.preferences.mode, preset: before.preferences.preset, windows: before.preferences.windows },
                      before.preferences,
                      'The audit must preserve actual serverName/workspace and other preference values',
                    );
                    shadow = next;
                    report.shadowPreferencePuts++;
                    return respond(shadow);
                  } catch {
                    report.blockedMutations.push({
                      case: prefix,
                      method: request.method(),
                      path: target.pathname,
                      reason: 'unexpected-shadow-values',
                    });
                    return route.abort('blockedbyclient');
                  }
                }
                report.blockedMutations.push({
                  case: prefix,
                  method: request.method(),
                  path: target.pathname,
                  reason: 'unexpected-preference-method',
                });
                return route.abort('blockedbyclient');
              }
              if (!readMethods.has(request.method())) {
                report.blockedMutations.push({ case: prefix, method: request.method(), path: target.pathname });
                return route.abort('blockedbyclient');
              }
              if (target.pathname.startsWith('/api/')) report.forwardedReads[target.pathname] = (report.forwardedReads[target.pathname] || 0) + 1;
              if (target.pathname === '/api/sse/app' && request.method() === 'GET' && !target.search) return route.continue();
              try {
                const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
                if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) {
                  report.blockedRedirects.push({ case: prefix, path: target.pathname, status: response.status() });
                  return route.fulfill({ status: 502, body: 'Redirect rejected by read-only audit' });
                }
                const headers = response.headers();
                if (request.resourceType() === 'document') {
                  const policy = "connect-src 'self'";
                  headers['content-security-policy'] = headers['content-security-policy']
                    ? `${headers['content-security-policy']}, ${policy}`
                    : policy;
                }
                return route.fulfill({ response, headers });
              } catch (error) {
                if (!closing) report.readFailures.push({ case: prefix, path: target.pathname, messageHash: hash(String(error.message)) });
                await route.abort('failed').catch(() => undefined);
              }
            });
            const page = await context.newPage();
            page.on('pageerror', (error) =>
              report.pageErrors.push({
                case: prefix,
                type: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error',
                messageHash: hash(error.message),
              }),
            );
            const viewportCapture = async (surface) => {
              const file = path.join(screenshotDir, `${prefix}-${surface}-native-viewport.png`);
              temporaryOutput(file);
              await page.screenshot({ path: file, fullPage: false });
              fs.chmodSync(file, 0o600);
              return { file, kind: 'native viewport; no scroll reset or viewport resize' };
            };
            try {
              stage = `${pairStage}-home-readiness`;
              await page.goto(`${origin.origin}/dashboard`, { waitUntil: 'domcontentloaded' });
              await page.locator(`.desktop[data-desktop-mode="${mode}"][data-desktop-preset="${preset}"]`).waitFor();
              await page.getByRole('heading', { name: before.preferences.serverName, exact: true }).waitFor();
              await page.locator('.desktop-connection-dot.is-connected').waitFor();
              await page
                .locator('.workspace-activity .workspace-section-heading p')
                .filter({ hasText: /^Uptime / })
                .waitFor();
              await page.waitForFunction(
                () =>
                  [...document.querySelectorAll('.workspace-gauge .workspace-dial strong')].length === 2 &&
                  [...document.querySelectorAll('.workspace-gauge .workspace-dial strong')].every((element) =>
                    /^\d+(?:\.\d+)?%$/.test(element.textContent.trim()),
                  ),
              );
              for (
                let attempt = 0;
                attempt < 60 &&
                !['/api/system/telemetry', '/api/system/containers', '/api/apps/installed', '/api/app-context'].every(
                  (endpoint) => readiness[endpoint],
                );
                attempt++
              )
                await page.waitForTimeout(100);
              assert.ok(
                ['/api/system/telemetry', '/api/system/containers', '/api/apps/installed', '/api/app-context'].every(
                  (endpoint) => readiness[endpoint],
                ),
                'Real account, host, Docker and installed app reads must complete',
              );
              stage = `${pairStage}-home-native-geometry`;
              await settleNative(page, '.workspace-activity');
              const home = await inspectSurface(page, 'home');
              checkSurface(home, viewport);
              stage = `${pairStage}-home-native-captures`;
              const homeViewport = await viewportCapture('home');
              const clipFile = path.join(screenshotDir, `${prefix}-home-native-full-card-clip.png`);
              temporaryOutput(clipFile);
              const cdp = await context.newCDPSession(page);
              try {
                const picture = await cdp.send('Page.captureScreenshot', {
                  format: 'png',
                  fromSurface: true,
                  captureBeyondViewport: true,
                  clip: { x: home.card.left, y: home.card.top, width: home.card.width, height: home.card.height, scale: 1 },
                });
                fs.writeFileSync(clipFile, Buffer.from(picture.data, 'base64'), { mode: 0o600 });
                fs.chmodSync(clipFile, 0o600);
              } finally {
                await cdp.detach();
              }
              samePrivate(
                await page.evaluate(() => ({ x: scrollX, y: scrollY })),
                home.outerScroll,
                'Native card clip must not scroll the workspace',
              );
              report.compositions.push({
                viewport,
                mode,
                preset,
                surface: 'home',
                metrics: home,
                captures: [
                  homeViewport,
                  { file: clipFile, kind: 'native CSS full-card clip via CDP captureBeyondViewport; not a viewport composition' },
                ],
              });
              stage = `${pairStage}-monitor-readiness`;
              await page.locator('.desktop-dock').getByRole('link', { name: 'Monitor', exact: true }).click();
              await page.locator('.desktop-host-overview').waitFor();
              await page
                .locator('.desktop-monitor-time')
                .filter({ hasText: /^Uptime / })
                .waitFor();
              await page.waitForFunction(
                () =>
                  [...document.querySelectorAll('.desktop-host-overview-readings strong')].length === 2 &&
                  [...document.querySelectorAll('.desktop-host-overview-readings strong')].every((element) =>
                    /^\d+(?:\.\d+)?%$/.test(element.textContent.trim()),
                  ),
              );
              stage = `${pairStage}-monitor-native-geometry`;
              await settleNative(page, '.desktop-host-overview');
              const monitor = await inspectSurface(page, 'monitor');
              checkSurface(monitor, viewport);
              stage = `${pairStage}-monitor-native-capture`;
              report.compositions.push({
                viewport,
                mode,
                preset,
                surface: 'monitor',
                metrics: monitor,
                captures: [await viewportCapture('monitor')],
              });
              stage = `${pairStage}-published-assets`;
              await Promise.all(jobs);
              assert.ok(
                assetCounts.documents > 0 && assetCounts.scripts > 0 && assetCounts.stylesheets > 0,
                'Each native pair must load real published HTML/JS/CSS',
              );
              report.compositions.at(-1).assets = assetCounts;
              assert.equal(report.pageErrors.length, 0, 'Published browser errors were observed');
              assert.equal(report.blockedMutations.length, 0, 'Unexpected mutations were blocked');
              assert.equal(report.blockedRedirects.length, 0, 'An ordinary read attempted a redirect');
              assert.equal(report.readFailures.length, 0, 'A relayed read failed');
              assert.equal(report.assetFailures.length, 0, 'A published asset could not be hashed');
            } catch (error) {
              const file = path.join(screenshotDir, `${prefix}-failure-native-viewport.png`);
              await page
                .screenshot({ path: file, fullPage: false })
                .then(() => fs.chmodSync(file, 0o600))
                .catch(() => undefined);
              throw error;
            }
          } finally {
            closing = true;
            await context.close();
          }
        }
    stage = 'palette-comparison';
    assert.equal(report.compositions.length, 48, 'Both status surfaces must run all native mode/preset/width combinations');
    for (const viewport of viewports)
      for (const surface of ['home', 'monitor']) {
        for (const mode of ['light', 'dark']) {
          const cases = report.compositions.filter(
            (item) => item.viewport.width === viewport.width && item.surface === surface && item.mode === mode,
          );
          const signatures = cases.map((item) => JSON.stringify({ background: item.metrics.background, colors: item.metrics.colors }));
          assert.equal(new Set(signatures).size, 6, 'All six presets must produce distinct status palettes');
        }
        for (const preset of presets) {
          const light = report.compositions.find(
            (item) => item.viewport.width === viewport.width && item.surface === surface && item.preset === preset && item.mode === 'light',
          );
          const dark = report.compositions.find(
            (item) => item.viewport.width === viewport.width && item.surface === surface && item.preset === preset && item.mode === 'dark',
          );
          assert.ok(
            dark.metrics.backgroundLuminance < light.metrics.backgroundLuminance - 0.02,
            'Dark status background must be visibly darker than its light counterpart',
          );
        }
      }
    stage = 'final-records';
    baseline.after = await snapshot();
    samePrivate(baseline.after, before, 'Actual preferences, installed/full app records or stores changed');
    report.recordsUnchanged = true;
    verifyBuild(await read('/api/system/build'));
    report.coreChecks.push(verifyCore(release.image));
    assert.ok(report.shadowPreferenceGets >= 24, 'Every native pair must consume its browser-only preference shadow');
    report.passed = true;
  } catch (error) {
    report.failure = { stage, type: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error', messageHash: hash(String(error.message)) };
  } finally {
    if (reader && before) {
      try {
        baseline.after = await snapshot();
        samePrivate(baseline.after, before, 'Final actual records changed');
        report.recordsUnchanged = true;
      } catch {
        report.recordsUnchanged = false;
        report.cleanupFailures.push('actual-record-comparison-failed');
      }
    }
    await reader?.close().catch(() => report.cleanupFailures.push('reader-close-failed'));
    await browser?.close().catch(() => report.cleanupFailures.push('browser-close-failed'));
    if (
      !report.recordsUnchanged ||
      report.cleanupFailures.length ||
      report.pageErrors.length ||
      report.blockedMutations.length ||
      report.blockedRedirects.length ||
      report.readFailures.length ||
      report.assetFailures.length
    )
      report.passed = false;
    if (outputReady) {
      privateWrite(baselineFile, baseline);
      save();
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      passed: report.passed,
      reportFile: outputReady ? reportFile : null,
      stage,
      compositions: report.compositions.length,
      recordsUnchanged: report.recordsUnchanged,
      realWrites: 0,
      failure: report.failure,
      cleanupFailures: report.cleanupFailures,
    })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write('Read-only published status audit failed; private session and API details were omitted.\n');
  process.exitCode = 1;
});
