// Published beta41 UI audit. Execution requires explicit opt-in, exact release pins and private owned inputs.
// Actual response bodies are unchanged; no browser mutation is forwarded.
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
    const grid = kind === 'home' ? document.querySelector('.workspace-grid') : null;
    const launcher = grid?.querySelector('.workspace-apps');
    const launcherEnd = launcher?.lastElementChild;
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
      workspace: grid
        ? {
            grid: box(grid),
            defaultLayout: grid.dataset.defaultLayout === 'true',
            gap: Number.parseFloat(getComputedStyle(grid).columnGap),
            widgets: [...grid.querySelectorAll(':scope > .workspace-widget')].map((node) => ({
              id: node.dataset.widget,
              ...box(node),
            })),
            launcher: launcher
              ? {
                  ...box(launcher),
                  minHeight: getComputedStyle(launcher).minHeight,
                  forcedBlank: launcherEnd
                    ? Math.max(0, box(launcher).bottom - box(launcherEnd).bottom - Number.parseFloat(getComputedStyle(launcher).paddingBottom))
                    : null,
                }
              : null,
          }
        : null,
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

async function scaleText(page, scale) {
  if (scale === 1) return;
  await page.evaluate((scale) => {
    const values = [...document.querySelectorAll('body,body *')]
      .filter((e) => e instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(e.tagName))
      .map((e) => ({
        e,
        font: Number.parseFloat(getComputedStyle(e).fontSize),
        line: getComputedStyle(e).lineHeight,
        original: ['font-size', 'line-height'].map((name) => [name, e.style.getPropertyValue(name), e.style.getPropertyPriority(name)]),
      }));
    window.__orbisSystemTextOriginals = values.map(({ e, original }) => [e, original]);
    for (const { e, font, line } of values) {
      if (Number.isFinite(font)) e.style.setProperty('font-size', `${font * scale}px`, 'important');
      if (line !== 'normal' && Number.isFinite(Number.parseFloat(line)))
        e.style.setProperty('line-height', `${Number.parseFloat(line) * scale}px`, 'important');
    }
  }, scale);
  await settleNative(page, '.desktop-settings');
}
async function appearanceGeometry(page) {
  return page.evaluate(() => {
    const box = (e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const words = (e) => {
      const issues = [];
      const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.parentElement.closest('svg,.visually-hidden,[hidden],[aria-hidden="true"]')) continue;
        for (const m of n.textContent.matchAll(/[A-Za-z]{2,}/g)) {
          const r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          const rects = [...r.getClientRects()].filter((r) => r.width && r.height);
          if (new Set(rects.map((r) => Math.round(r.top * 10))).size > 1) issues.push(m[0]);
        }
      }
      return issues;
    };
    const settings = document.querySelector('.desktop-settings');
    const frame = settings.closest('.desktop-route-window');
    const header = frame.querySelector('.desktop-window-bar');
    const icon = header.querySelector('.desktop-window-icon');
    const nav = settings.querySelector('.nav-tabs');
    const divider = nav.closest('.card-header');
    const section = settings.querySelector('[aria-labelledby="appearance-mode"]');
    const group = section.querySelector('.appearance-modes');
    const tabs = [...nav.querySelectorAll('button')].filter((e) => e.offsetWidth && e.offsetHeight);
    const buttons = [...group.querySelectorAll('button')].map((e) => {
      const label = e.querySelector('strong');
      const glyph = e.querySelector('svg');
      const range = document.createRange();
      range.selectNodeContents(label);
      const ink = range.getBoundingClientRect();
      const s = getComputedStyle(e);
      return {
        text: label.textContent,
        pressed: e.getAttribute('aria-pressed'),
        box: box(e),
        glyph: box(glyph),
        ink: { left: ink.left, right: ink.right, top: ink.top, bottom: ink.bottom },
        words: words(label),
        padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(Number.parseFloat),
        transform: s.transform,
      };
    });
    const chrome = (e) => {
      const s = getComputedStyle(e);
      return {
        background: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        backdrop: s.backdropFilter,
        borderWidths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
        borderColours: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor],
        shadow: s.boxShadow,
        transition: s.viewTransitionName,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      overflow: document.documentElement.scrollWidth > innerWidth,
      settings: box(settings),
      icon: box(icon),
      nav: box(nav),
      note: box(settings.querySelector('.appearance-note')),
      section: box(section),
      form: box(group),
      nameForm: box(settings.querySelector('.appearance-name')),
      presetForm: box(settings.querySelector('.appearance-presets')),
      divider: { ...box(divider), y: divider.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(divider).borderBottomWidth) / 2 },
      lastTabBottom: Math.max(...tabs.map((e) => e.getBoundingClientRect().bottom)),
      buttons,
      chrome: {
        bar: chrome(document.querySelector('.desktop-system-bar')),
        dock: chrome(document.querySelector('.desktop-dock')),
        frame: chrome(frame),
        header: chrome(header),
      },
      navigation: frame.dataset.windowNavigation,
    };
  });
}
function checkAppearance(g) {
  const near = (a, b, message) => assert.ok(Math.abs(a - b) <= 1, `${message}: ${a} vs ${b}`);
  assert.equal(g.overflow, false, 'Appearance must not overflow');
  for (const key of ['icon', 'nav', 'note', 'section']) near(g[key].left, g.settings.left, `${key} shared left gutter`);
  for (const key of ['nav', 'note', 'section']) near(g[key].right, g.settings.right, `${key} shared right gutter`);
  near(g.form.left, g.nameForm.left, 'Mode and name form columns');
  near(g.form.left, g.presetForm.left, 'Mode and preset form columns');
  near(g.form.right, g.presetForm.right, 'Mode form right edge');
  assert.ok(g.divider.y - g.lastTabBottom >= 8, 'Divider must clear all tab/More rows');
  assert.deepEqual(
    g.buttons.map((b) => b.text),
    ['Light', 'Dark', 'Follow system'],
  );
  assert.deepEqual(
    g.buttons.map((b) => b.pressed),
    ['false', 'false', 'true'],
  );
  const rows = [];
  for (const b of g.buttons) {
    assert.deepEqual(b.words, [], 'Mode labels require whole words');
    assert.ok(
      b.ink.left >= b.box.left + 8 && b.ink.right <= b.box.right - 8 && b.ink.top >= b.box.top + 8 && b.ink.bottom <= b.box.bottom - 8,
      'Mode label needs real interior padding',
    );
    assert.ok(b.glyph.left >= b.box.left + 8 && b.glyph.right <= b.box.right - 8, 'Mode icon needs edge room');
    const horizontal = b.ink.left - b.glyph.right;
    const vertical = b.ink.top - b.glyph.bottom;
    assert.ok(horizontal >= 8 || vertical >= 8, 'Mode text must clear its icon');
    assert.ok(b.box.left >= g.form.left - 1 && b.box.right <= g.form.right + 1, 'Mode button within form');
    let row = rows.find((r) => Math.abs(r[0].box.top - b.box.top) < 1);
    if (!row) {
      row = [];
      rows.push(row);
    }
    row.push(b);
  }
  const columns = Math.max(...rows.map((row) => row.length));
  for (const row of rows) {
    near(row[0].box.left, g.form.left, 'Mode row starts at form gutter');
    if (row.length === columns) near(row.at(-1).box.right, g.form.right, 'Complete mode row ends at form gutter');
    assert.ok(Math.max(...row.map((b) => b.box.bottom)) - Math.min(...row.map((b) => b.box.bottom)) <= 1, 'Mode buttons share row bottom');
  }
  for (const key of ['bar', 'dock']) {
    const c = g.chrome[key];
    assert.equal(c.backdrop, 'blur(28px) saturate(1.45)');
    assert.ok(c.background.startsWith('rgba(') && !c.background.endsWith(', 1)'), 'Chrome must be translucent');
    assert.ok(
      c.borderColours.every((colour) => colour === 'rgba(0, 0, 0, 0)'),
      'No chrome rims',
    );
    assert.ok(!c.shadow.includes('inset'), 'No inset chrome sheen');
  }
  if (g.navigation === 'desktop') {
    assert.equal(g.chrome.header.backdrop, 'blur(28px) saturate(1.45)');
    assert.equal(g.chrome.frame.background, 'rgba(0, 0, 0, 0)');
    assert.equal(g.chrome.frame.transition, 'none');
    assert.ok(g.chrome.frame.borderColours.every((c) => c === 'rgba(0, 0, 0, 0)'));
    assert.ok(!g.chrome.frame.shadow.includes('inset'));
  }
}
async function restoreText(page) {
  if (page.isClosed()) return;
  await page.evaluate(() => {
    for (const [element, properties] of window.__orbisSystemTextOriginals || []) {
      if (!element.isConnected) continue;
      for (const [name, value, priority] of properties) {
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
      }
    }
    delete window.__orbisSystemTextOriginals;
  });
}

async function loadedToast(page) {
  return page.evaluate(async () => {
    const assets = [...new Set(performance.getEntriesByType('resource').map((entry) => entry.name))].filter((name) => {
      const url = new URL(name);
      return url.origin === location.origin && url.pathname.startsWith('/assets/') && url.pathname.endsWith('.js');
    });
    for (const url of assets) {
      const exports = await import(url);
      for (const [key, value] of Object.entries(exports)) {
        if (
          typeof value === 'function' &&
          ['success', 'error', 'loading', 'dismiss', 'remove'].every((method) => typeof value[method] === 'function')
        ) {
          return { url, key };
        }
      }
    }
    throw new Error('Actual loaded notification API was not available');
  });
}

async function paintedMode(page, mode) {
  await page.waitForFunction((mode) => {
    const roots = [...document.querySelectorAll('.desktop,[data-desktop-mode]')];
    return (
      roots.length >= 2 &&
      roots.every((root) => root.dataset.desktopMode === mode && root.dataset.desktopPreset === 'ocean') &&
      document.body.dataset.bsTheme === mode
    );
  }, mode);
  return page.evaluate(() => {
    const root = document.querySelector('.desktop');
    const rootStyle = getComputedStyle(root);
    const bodyStyle = getComputedStyle(document.body);
    const portal = document.querySelector('.orbis-notifications');
    const notice = portal?.querySelector('.orbis-notification');
    const rootTokens = (style) =>
      Object.fromEntries(
        ['--desktop-ink', '--desktop-muted', '--desktop-surface', '--desktop-chrome', '--desktop-status-background'].map((token) => [
          token,
          style.getPropertyValue(token).trim(),
        ]),
      );
    const frame = document.querySelector('.desktop-route-window');
    const content = frame?.querySelector('.desktop-window-content');
    return {
      roots: [...document.querySelectorAll('[data-desktop-mode]')].map((element) => ({
        className: element.className,
        mode: element.dataset.desktopMode,
        preset: element.dataset.desktopPreset,
      })),
      body: { mode: document.body.dataset.bsTheme, tokens: rootTokens(bodyStyle) },
      root: { tokens: rootTokens(rootStyle) },
      portal: portal
        ? { mode: portal.dataset.desktopMode, preset: portal.dataset.desktopPreset, tokens: rootTokens(getComputedStyle(portal)) }
        : null,
      notice: notice ? { background: getComputedStyle(notice).backgroundColor, ink: getComputedStyle(notice).color } : null,
      header: {
        target: document.querySelector('.desktop-mode-toggle')?.getAttribute('aria-label'),
        pressed: document.querySelector('.desktop-mode-toggle')?.getAttribute('aria-pressed'),
      },
      scroll: { x: scrollX, y: scrollY, frame: frame?.scrollTop || 0, content: content?.scrollTop || 0 },
      documentWidth: document.documentElement.scrollWidth,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
}

function checkMode(metrics, mode) {
  assert.ok(
    metrics.roots.length >= 2 && metrics.roots.every((root) => root.mode === mode && root.preset === 'ocean'),
    'Actual desktop and notification roots must resolve the OS mode and retain Ocean',
  );
  assert.equal(metrics.body.mode, mode, 'Body mode must follow the OS');
  samePrivate(metrics.body.tokens, metrics.root.tokens, 'Body theme tokens must follow the actual desktop');
  assert.ok(metrics.portal, 'Actual notification portal is required');
  samePrivate(metrics.portal.tokens, metrics.root.tokens, 'Notification portal tokens must follow the desktop');
  assert.equal(metrics.header.target, `Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`, 'Header action must target the opposite resolved mode');
  assert.equal(metrics.header.pressed, String(mode === 'dark'), 'Header pressed state must resolve the OS mode');
  assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, 'Actual route must fit the viewport');
}

function checkStatus(metrics, viewport) {
  assert.equal(metrics.heading, 'System status');
  assert.equal(metrics.background, metrics.expectedBackground, 'Status paint must resolve the active shared background');
  samePrivate(
    metrics.colors,
    { ink: metrics.expectedColors.ink, heading: metrics.expectedColors.ink, muted: metrics.expectedColors.muted, edge: metrics.expectedColors.edge },
    'Status text and edge must resolve the active tokens',
  );
  samePrivate(metrics.wordIssues, [], 'Ordinary status words must remain complete');
  samePrivate(metrics.paintIssues, [], 'Status text must remain inside the card');
  samePrivate(metrics.nodeOverflow, [], 'Status values must not crowd or overflow their own layout');
  assert.ok(metrics.gradientColors.length >= 2 && metrics.wordCount > 0, 'Real painted status gradient and text are required');
  assert.ok(
    metrics.card.left >= 0 && metrics.card.right <= viewport.width + 1 && metrics.documentWidth <= viewport.width + 1,
    'Actual status card must fit horizontally',
  );
}

async function chromeMetrics(page) {
  return page.evaluate(() => {
    const chrome = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        blur: style.backdropFilter,
        shadow: style.boxShadow,
        borders: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
        transition: style.viewTransitionName,
      };
    };
    const frame = document.querySelector('.desktop-route-window');
    return {
      bar: chrome(document.querySelector('.desktop-system-bar')),
      dock: chrome(document.querySelector('.desktop-dock')),
      frame: chrome(frame),
      header: chrome(frame?.querySelector('.desktop-window-bar')),
      navigation: frame?.dataset.windowNavigation,
    };
  });
}

function checkChrome(metrics) {
  for (const chrome of [metrics.bar, metrics.dock]) {
    assert.ok(chrome && chrome.blur === 'blur(28px) saturate(1.45)', 'Topbar and dock must retain matching28px glass blur');
    assert.ok(chrome.background.startsWith('rgba(') && !chrome.background.endsWith(', 1)'), 'Chrome must be translucent');
    assert.ok(
      chrome.borders.every((color) => color === 'rgba(0, 0, 0, 0)') && !chrome.shadow.includes('inset'),
      'Chrome must not add a bright frame rim or inset sheen',
    );
  }
  if (metrics.navigation === 'desktop') {
    assert.equal(metrics.frame.background, 'rgba(0, 0, 0, 0)', 'Desktop frame must not put a pale surface under glass');
    assert.equal(metrics.frame.blur, 'none');
    assert.equal(metrics.frame.transition, 'none');
    assert.ok(
      metrics.frame.borders.every((color) => color === 'rgba(0, 0, 0, 0)') && !metrics.frame.shadow.includes('inset'),
      'Desktop frame must have no bright rim',
    );
    assert.equal(metrics.header.blur, metrics.dock.blur);
    assert.ok(metrics.header.background.startsWith('rgba(') && !metrics.header.background.endsWith(', 1)'), 'Titlebar must remain translucent');
  }
}

async function assertImages(page) {
  await page.waitForFunction(() =>
    [...document.images].every((image) => {
      const rect = image.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      return !visible || (image.complete && image.naturalWidth > 0);
    }),
  );
  return page.evaluate(() =>
    [...document.images].map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight,
        requested: Boolean(image.currentSrc),
        complete: image.complete,
        loaded: image.naturalWidth > 0,
        lazy: image.loading === 'lazy',
      };
    }),
  );
}

async function main() {
  process.umask(0o077);
  const expectedCommit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
  const expectedDigest = process.env.ORBIS_AUDIT_EXPECTED_DIGEST;
  const output = process.env.ORBIS_AUDIT_OUTPUT_DIR || '/tmp/orbis-live-beta41-system-mode';
  let stage = 'preflight';
  let outputReady = false;
  let browser;
  let reader;
  let activeContext;
  let origin;
  let release;
  let before;
  let contextsClosed = 0;
  const baseline = {};
  const report = {
    passed: false,
    release: null,
    source: {
      live: [
        'Actual published HTML/JS/CSS/images and API GET/HEAD responses',
        'Actual server-seeded system/Ocean preferences, app/store records and telemetry',
      ],
      controlled: [
        'Browser OS colour-scheme emulation',
        'One320px doubled-computed-text Appearance group',
        'One fresh390px browser boot with injected localStorage and document.cookie denial; HTTP authentication cookies unchanged',
        'Actual loaded toast API with a clearly labelled UI-only QA message, removed afterwards',
        'Browser-only document connect-src self policy; actual response bodies unchanged',
      ],
      omitted: [
        'Signed-out/login/guest/fallback mode transitions, manual mode edits and export/import; source coverage remains separate',
        'No48-preset matrix, all16-source layout matrix, account changes or real preference writes',
      ],
      APIBodySubstitutions: 0,
      preferenceShadows: 0,
      realWrites: 0,
      capture: 'Native viewport at actual reading/focus positions; no scroll reset',
    },
    groups: [],
    assets: {},
    forwardedReads: {},
    blockedMutations: [],
    externalRequestsBlocked: 0,
    blockedRedirects: [],
    readFailures: [],
    assetFailures: [],
    pageErrors: [],
    coreChecks: [],
    recordsUnchanged: false,
    contextsClosed: 0,
    browserClosed: false,
    cleanupFailures: [],
  };
  const screenshotDir = path.join(output, 'screenshots');
  const reportFile = path.join(output, 'report.json');
  const baselineFile = path.join(output, 'private-baseline.json');
  const save = () => privateWrite(reportFile, { ...report, stage });
  const read = async (endpoint) => {
    assert.ok(endpoint.startsWith('/api/') && !endpoint.includes('?') && !endpoint.includes('#'), 'Direct reads must use fixed owned API paths');
    const response = await reader.request.get(`${origin.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
    assert.ok(response.ok(), 'Owned authenticated GET failed');
    return response.json();
  };
  const verifyBuild = (build) =>
    assert.ok(
      build.version === expectedTag && build.commit === expectedCommit && build.imageDigest === expectedDigest,
      'Published build differs from independent exact pins',
    );
  const snapshot = async () => {
    const installed = await read('/api/apps/installed');
    assert.ok(Array.isArray(installed.installed), 'Actual installed app records are required');
    const apps = {};
    for (const item of installed.installed) {
      const urn = item.info?.urn;
      assert.ok(typeof urn === 'string' && urn.includes(':') && !Object.hasOwn(apps, urn), 'Installed identity must be valid and unique');
      apps[urn] = await read(`/api/apps/${encodeURIComponent(urn)}`);
      assert.equal(apps[urn].info?.urn, urn, 'Actual full app identity differs');
    }
    return { preferences: await read('/api/desktop-preferences'), installed, apps, stores: await read('/api/marketplace/all') };
  };
  const unchangedPreferences = async () =>
    samePrivate(await read('/api/desktop-preferences'), before.preferences, 'Actual raw system/Ocean preferences changed during media emulation');
  try {
    assert.equal(process.env.ORBIS_ALLOW_LIVE_SYSTEM_MODE_AUDIT, '1', 'Explicit published read-only audit opt-in is required');
    assert.equal(expectedTag, 'v0.1.0-beta.41', 'Only the reviewed beta41 target is permitted');
    assert.match(expectedCommit || '', /^87c670af[a-f0-9]{32}$/, 'The reviewed full40-character commit pin is required');
    assert.match(expectedDigest || '', /^sha256:[a-f0-9]{64}$/, 'Exact published digest is required');
    assert.equal(process.env.ORBIS_AUDIT_COOKIE_FILE, ownedCookieFile, 'Only the private owned cookie jar is permitted');
    const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
    assert.ok(releaseFile, 'Explicit release manifest is required');
    origin = new URL(process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080');
    assert.ok(
      origin.protocol === 'http:' &&
        origin.hostname === '127.0.0.1' &&
        origin.port === '18080' &&
        origin.pathname === '/' &&
        !origin.username &&
        !origin.password &&
        !origin.search &&
        !origin.hash,
      'Only owned HTTP127.0.0.1:18080 is permitted',
    );
    const stat = fs.lstatSync(installRoot);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && fs.realpathSync(installRoot) === installRoot,
      'Owned installation root mismatch',
    );
    release = parsePrivate(readOwnedInput(releaseFile), 'Release manifest');
    assert.ok(
      release.tag === expectedTag && release.commit === expectedCommit && release.image === `ghcr.io/twentylines/orbis@${expectedDigest}`,
      'Release manifest differs from explicit pins',
    );
    const cookies = parseCookies(readOwnedInput(ownedCookieFile), origin.hostname);
    temporaryOutput(output);
    assert.ok(!fs.existsSync(output), 'Use a new private evidence directory');
    privateDirectory(output);
    privateDirectory(screenshotDir);
    outputReady = true;
    report.release = { tag: expectedTag, commit: expectedCommit, digest: expectedDigest };
    report.coreChecks.push(verifyCore(release.image));
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    verifyBuild(await read('/api/system/build'));
    assert.equal((await read('/api/user-context')).isLoggedIn, true, 'Owned session must authenticate');
    const appContext = await read('/api/app-context');
    assert.ok(appContext.user?.hasSeenWelcome && appContext.user?.locale === 'en', 'Owned English account onboarding must be complete');
    before = await snapshot();
    assert.equal(before.preferences.mode, 'system', 'Root must seed actual raw system mode before this audit');
    assert.equal(before.preferences.preset, 'ocean', 'Root must seed actual Ocean preset before this audit');
    assert.ok(!before.preferences.workspace.hidden.includes('activity'), 'Home status must already be enabled; this audit will not change selection');
    baseline.before = before;
    baseline.telemetry = await read('/api/system/telemetry');
    assert.ok(
      baseline.telemetry.memory?.totalBytes > 0 && Number.isFinite(baseline.telemetry.cpu?.uptimeSeconds),
      'Actual host telemetry must be ready',
    );
    privateWrite(baselineFile, baseline);
    for (const group of [
      { width: 1440, height: 1120, textScale: 1, routes: ['home', 'monitor', 'appearance'] },
      { width: 390, height: 844, textScale: 1, routes: ['home', 'monitor', 'appearance'] },
      { width: 320, height: 800, textScale: 2, routes: ['appearance'] },
      { width: 390, height: 844, textScale: 1, denyBrowserStorage: true, routes: ['appearance'] },
    ]) {
      const viewport = { width: group.width, height: group.height };
      verifyBuild(await read('/api/system/build'));
      activeContext = await browser.newContext({ viewport, colorScheme: group.denyBrowserStorage ? 'dark' : 'light', serviceWorkers: 'block' });
      let closing = false;
      let page;
      let toastBinding;
      const jobs = [];
      const assetCounts = { document: 0, script: 0, stylesheet: 0, image: 0, font: 0 };
      const readiness = {};
      const prefix = `${group.width}x${group.height}-text${group.textScale}${group.denyBrowserStorage ? '-storage-denied' : ''}`;
      try {
        await activeContext.addCookies(cookies);
        if (group.denyBrowserStorage)
          await activeContext.addInitScript((origin) => {
            if (location.origin !== origin) return;
            const local = localStorage;
            const originalGet = Storage.prototype.getItem;
            const originalSet = Storage.prototype.setItem;
            const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
            Storage.prototype.getItem = function (...args) {
              if (this === local) throw new DOMException('Controlled browser cache denial', 'SecurityError');
              return originalGet.apply(this, args);
            };
            Storage.prototype.setItem = function (...args) {
              if (this === local) throw new DOMException('Controlled browser cache denial', 'SecurityError');
              return originalSet.apply(this, args);
            };
            if (cookie?.configurable)
              Object.defineProperty(Document.prototype, 'cookie', {
                configurable: true,
                get() {
                  throw new DOMException('Controlled JS cookie denial', 'SecurityError');
                },
                set() {
                  throw new DOMException('Controlled JS cookie denial', 'SecurityError');
                },
              });
            window.__orbisLiveStorageDenial = {
              cookieDenied: Boolean(cookie?.configurable),
              restore() {
                Storage.prototype.getItem = originalGet;
                Storage.prototype.setItem = originalSet;
                if (cookie) Object.defineProperty(Document.prototype, 'cookie', cookie);
                delete window.__orbisLiveStorageDenial;
              },
            };
          }, origin.origin);
        activeContext.on('requestfailed', (request) => {
          const target = new URL(request.url());
          if (!closing && target.origin === origin.origin && ['document', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType()))
            report.assetFailures.push({
              group: prefix,
              path: target.pathname,
              resource: request.resourceType(),
              messageHash: hash(request.failure()?.errorText || 'Asset request failed'),
            });
        });
        activeContext.on('response', (response) => {
          const request = response.request();
          const target = new URL(request.url());
          if (target.origin !== origin.origin) return;
          if (!response.ok()) {
            if (response.status() !== 304) report.readFailures.push({ group: prefix, path: target.pathname, status: response.status() });
            return;
          }
          if (target.pathname.startsWith('/api/')) readiness[target.pathname] = (readiness[target.pathname] || 0) + 1;
          const kind = request.resourceType();
          if (!Object.hasOwn(assetCounts, kind)) return;
          jobs.push(
            response
              .body()
              .then((body) => {
                assetCounts[kind]++;
                const record = { resource: kind, bytes: body.length, sha256: hash(body) };
                report.assets[`${target.pathname}:${record.sha256}`] = record;
              })
              .catch(() => {
                if (!closing) report.assetFailures.push({ group: prefix, path: target.pathname, resource: kind });
              }),
          );
        });
        await activeContext.route('**/*', async (route) => {
          const request = route.request();
          const target = new URL(request.url());
          if (target.origin !== origin.origin) {
            report.externalRequestsBlocked++;
            return route.abort('blockedbyclient');
          }
          if (!readMethods.has(request.method())) {
            report.blockedMutations.push({ group: prefix, method: request.method(), path: target.pathname });
            return route.abort('blockedbyclient');
          }
          if (
            /^\/api\/auth\//.test(target.pathname) ||
            /\/(?:refresh|restart|reboot|shutdown|install|uninstall|logout)(?:\/|$)/.test(target.pathname)
          ) {
            report.blockedMutations.push({ group: prefix, method: request.method(), path: target.pathname, reason: 'side-effect-endpoint' });
            return route.abort('blockedbyclient');
          }
          if (target.pathname.startsWith('/api/')) report.forwardedReads[target.pathname] = (report.forwardedReads[target.pathname] || 0) + 1;
          if (target.pathname === '/api/sse/app' && !target.search) return route.continue();
          try {
            const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
            if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) {
              report.blockedRedirects.push({ group: prefix, path: target.pathname, status: response.status() });
              return route.abort('blockedbyclient');
            }
            const headers = response.headers();
            if (request.resourceType() === 'document')
              headers['content-security-policy'] = headers['content-security-policy']
                ? `${headers['content-security-policy']}, connect-src 'self'`
                : "connect-src 'self'";
            return route.fulfill({ response, headers });
          } catch (error) {
            if (!closing) report.readFailures.push({ group: prefix, path: target.pathname, messageHash: hash(String(error.message)) });
            return route.abort('failed').catch(() => undefined);
          }
        });
        page = await activeContext.newPage();
        page.on('pageerror', (error) =>
          report.pageErrors.push({
            group: prefix,
            type: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error',
            messageHash: hash(error.message),
          }),
        );
        const capture = async (surface, mode) => {
          const file = path.join(screenshotDir, `${prefix}-${surface}-${mode}-actual-viewport.png`);
          temporaryOutput(file);
          await page.screenshot({ path: file, fullPage: false });
          fs.chmodSync(file, 0o600);
          return { file, kind: 'Actual viewport, preserved native route/focus reading position' };
        };
        for (const surface of group.routes) {
          stage = `${prefix}-${surface}`;
          const route = { home: '/dashboard', monitor: '/monitor', appearance: '/settings?tab=appearance' }[surface];
          const selector = { home: '.workspace-activity', monitor: '.desktop-host-overview', appearance: '.desktop-settings' }[surface];
          await page.emulateMedia({ colorScheme: group.denyBrowserStorage ? 'dark' : 'light' });
          await page.goto(`${origin.origin}${route}`, { waitUntil: 'domcontentloaded' });
          await page.locator(selector).waitFor();
          await page.locator('.desktop-connection-dot.is-connected').waitFor();
          if (surface === 'appearance') await page.locator('.appearance-mode-system[aria-pressed="true"]').waitFor();
          if (surface === 'home')
            await page
              .locator('.workspace-activity .workspace-section-heading p')
              .filter({ hasText: /^Uptime / })
              .waitFor();
          await settleNative(page, selector);
          if (group.textScale === 2) await scaleText(page, 2);
          const result = {
            surface,
            viewport,
            textScale: group.textScale,
            browserStorageDenied: Boolean(group.denyBrowserStorage),
            modeSequence: group.denyBrowserStorage ? ['dark', 'light', 'dark'] : ['light', 'dark', 'light'],
            states: [],
          };
          if (group.denyBrowserStorage)
            result.denial = await page.evaluate(() => ({
              enabled: Boolean(window.__orbisLiveStorageDenial),
              cookieDenied: window.__orbisLiveStorageDenial?.cookieDenied,
              rendered: Boolean(document.querySelector('.appearance-mode-system[aria-pressed="true"]')),
              fallback: Boolean(document.querySelector('.desktop-fallback')),
            }));
          if (group.denyBrowserStorage)
            assert.ok(
              result.denial.enabled && result.denial.cookieDenied && result.denial.rendered && !result.denial.fallback,
              'Denied JS storage/cookies must retain actual authenticated settings',
            );
          if (surface === 'appearance') {
            toastBinding = await loadedToast(page);
            await page.evaluate(
              async (binding) =>
                (await import(binding.url))[binding.key].success('Browser-only QA: system colour mode', {
                  id: 'live-system-mode-qa',
                  duration: Number.POSITIVE_INFINITY,
                }),
              toastBinding,
            );
            await page.locator('[data-notification-id="live-system-mode-qa"]').waitFor();
          }
          for (const [index, mode] of result.modeSequence.entries()) {
            stage = `${prefix}-${surface}-${mode}-${index}`;
            const readingBefore = await page.evaluate(() => ({
              x: scrollX,
              y: scrollY,
              frame: document.querySelector('.desktop-route-window')?.scrollTop || 0,
              content: document.querySelector('.desktop-window-content')?.scrollTop || 0,
            }));
            await page.emulateMedia({ colorScheme: mode });
            await paintedMode(page, mode);
            await settleNative(page, selector);
            const paint = await paintedMode(page, mode);
            checkMode(paint, mode);
            samePrivate(paint.scroll, readingBefore, 'An OS mode change must not move the actual reading position');
            const chrome = await chromeMetrics(page);
            checkChrome(chrome);
            const state = { mode, paint, chrome, images: await assertImages(page) };
            report.pending = { surface, viewport, textScale: group.textScale, state };
            if (surface === 'appearance') {
              state.appearance = await appearanceGeometry(page);
              checkAppearance(state.appearance);
              state.focus = [];
              await page.locator('.appearance-mode-light').focus();
              for (const modeClass of ['light', 'dark', 'system']) {
                if (modeClass !== 'light') await page.keyboard.press('Tab');
                await page.waitForTimeout(240);
                const focus = await page.locator(`.appearance-mode-${modeClass}`).evaluate((element) => {
                  const rect = element.getBoundingClientRect();
                  const style = getComputedStyle(element);
                  const barBottom = document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom;
                  const frame = element.closest('.desktop-route-window');
                  const titleBottom =
                    frame.dataset.windowNavigation === 'desktop' ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0;
                  return {
                    active: document.activeElement === element,
                    top: rect.top,
                    bottom: rect.bottom,
                    topChrome: Math.max(barBottom, titleBottom),
                    dockTop: document.querySelector('.desktop-dock').getBoundingClientRect().top,
                    outline: style.outline,
                    shadow: style.boxShadow,
                  };
                });
                assert.ok(
                  focus.active && focus.top >= focus.topChrome + 3 && focus.bottom <= focus.dockTop - 3,
                  'Native mode-card focus must clear the actual sticky chrome',
                );
                assert.ok(!focus.outline.startsWith('0px') || focus.shadow !== 'none', 'The full mode-card focus marker must remain readable');
                state.focus.push({ modeClass, ...focus });
              }
            } else {
              state.status = await inspectSurface(page, surface);
              checkStatus(state.status, viewport);
            }
            if (index < 2) state.capture = await capture(surface, mode);
            result.states.push(state);
            await unchangedPreferences();
            assert.equal(report.blockedMutations.length, 0, 'OS changes or native focus must not attempt a preference/API mutation');
          }
          const light = result.states.find((state) => state.mode === 'light');
          const dark = result.states.find((state) => state.mode === 'dark');
          assert.notDeepEqual(light.paint.root.tokens, dark.paint.root.tokens, 'Resolved desktop paint must visibly change');
          if (surface === 'appearance') {
            assert.ok(light.paint.notice && dark.paint.notice, 'Actual visible notification must be included');
            assert.notDeepEqual(light.paint.notice, dark.paint.notice, 'Actual notification paint must change with the OS');
            await page.evaluate(async (binding) => (await import(binding.url))[binding.key].remove('live-system-mode-qa'), toastBinding);
            toastBinding = undefined;
          } else {
            assert.notEqual(light.status.background, dark.status.background, 'Actual status gradient must change');
            assert.notEqual(light.status.colors.ink, dark.status.colors.ink, 'Actual status ink must change');
            assert.ok(dark.status.backgroundLuminance < light.status.backgroundLuminance - 0.02, 'Dark status must visibly darken');
          }
          result.passed = true;
          report.groups.push(result);
          delete report.pending;
          await restoreText(page);
          save();
        }
        await Promise.all(jobs);
        assert.ok(
          assetCounts.document >= group.routes.length && assetCounts.script > 0 && assetCounts.stylesheet > 0 && assetCounts.image > 0,
          'Every viewport group must actually load published HTML/scripts/styles/images',
        );
        assert.ok(readiness['/api/desktop-preferences'] >= group.routes.length, 'Every actual route must consume real server preferences');
        report.groups.at(-1).assets = assetCounts;
        report.groups.at(-1).actualReadiness = readiness;
      } catch (error) {
        if (page)
          await page
            .screenshot({ path: path.join(screenshotDir, `${prefix}-failure.png`), fullPage: false })
            .then(() => fs.chmodSync(path.join(screenshotDir, `${prefix}-failure.png`), 0o600))
            .catch(() => undefined);
        throw error;
      } finally {
        closing = true;
        if (page && !page.isClosed()) {
          if (toastBinding)
            await page
              .evaluate(async (binding) => (await import(binding.url))[binding.key].remove('live-system-mode-qa'), toastBinding)
              .catch(() => report.cleanupFailures.push('ui-notice-removal-failed'));
          await restoreText(page).catch(() => report.cleanupFailures.push('text-style-restore-failed'));
          await page
            .evaluate(() => window.__orbisLiveStorageDenial?.restore())
            .catch(() => report.cleanupFailures.push('storage-hooks-restore-failed'));
          await page.emulateMedia({ colorScheme: null }).catch(() => report.cleanupFailures.push('os-emulation-reset-failed'));
          await page.setViewportSize(viewport).catch(() => report.cleanupFailures.push('viewport-restore-failed'));
        }
        await activeContext.close();
        activeContext = undefined;
        report.contextsClosed = ++contextsClosed;
      }
    }
    stage = 'final-records';
    baseline.after = await snapshot();
    samePrivate(baseline.after, before, 'Actual preferences/app/store records changed');
    report.recordsUnchanged = true;
    verifyBuild(await read('/api/system/build'));
    report.coreChecks.push(verifyCore(release.image));
    assert.equal(report.groups.length, 8, 'Eight bounded actual route/viewport/text/storage groups are required');
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
    await activeContext?.close().catch(() => report.cleanupFailures.push('active-context-close-failed'));
    await reader?.close().catch(() => report.cleanupFailures.push('reader-close-failed'));
    if (browser)
      await browser
        .close()
        .then(() => {
          report.browserClosed = true;
        })
        .catch(() => report.cleanupFailures.push('browser-close-failed'));
    if (
      !report.recordsUnchanged ||
      !report.browserClosed ||
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
    `${JSON.stringify({ passed: report.passed, groups: report.groups.length, resolvedStates: report.groups.reduce((sum, group) => sum + group.states.length, 0), recordsUnchanged: report.recordsUnchanged, realWrites: 0, browserClosed: report.browserClosed, reportFile: outputReady ? reportFile : null, failure: report.failure })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module)
  main().catch(() => {
    process.stderr.write('Read-only published system-mode audit failed; private inputs and call details were omitted.\n');
    process.exitCode = 1;
  });
module.exports = { main };
