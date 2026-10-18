const assert = require('node:assert/strict');
const storageKey = 'server-desktop-preferences-v1';
const namePrefix = 'orbis-system-mode-qa:';

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime) && a.effect.getComputedTiming().endTime <= 4000)
        .map((a) => a.finished.catch(() => undefined)),
    );
  });
  await page.waitForTimeout(180);
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
  await settle(page);
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
async function assertMode(page, mode, selector = '.desktop') {
  await page.waitForFunction(
    ({ mode, selector }) => {
      const roots = [...document.querySelectorAll(selector)].filter((e) => e.getClientRects().length);
      return roots.length > 0 && roots.every((e) => e.dataset.desktopMode === mode);
    },
    { mode, selector },
  );
  const info = await page.evaluate(() => ({
    roots: [...document.querySelectorAll('[data-desktop-mode]')]
      .filter((e) => e.getClientRects().length)
      .map((e) => ({ mode: e.dataset.desktopMode, preset: e.dataset.desktopPreset, classes: e.className })),
    listeners: window.__orbisSystemQa?.activeCount(),
    cache: (() => {
      try {
        return JSON.parse(localStorage.getItem('server-desktop-preferences-v1') || 'null')?.mode;
      } catch {
        return 'denied';
      }
    })(),
  }));
  assert.ok(
    info.roots.every((root) => root.mode === mode),
    'Every themed surface must use the resolved mode',
  );
  return info;
}
async function discoverToast(page) {
  return page.evaluate(async () => {
    for (const url of [...new Set(performance.getEntriesByType('resource').map((e) => e.name))].filter(
      (name) => new URL(name).origin === location.origin && new URL(name).pathname.startsWith('/assets/') && name.endsWith('.js'),
    )) {
      const m = await import(url);
      for (const [key, value] of Object.entries(m))
        if (typeof value === 'function' && ['success', 'error', 'loading', 'dismiss', 'remove'].every((k) => typeof value[k] === 'function'))
          return { url, key };
    }
    throw new Error('Loaded production toast API not found');
  });
}

module.exports = async function inspectSystemMode({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '8080',
    'System-mode checks require isolated8080 fixtures',
  );
  assert.equal(typeof capture, 'function');
  const original = {
    name: await page.evaluate(() => window.name),
    storage: await page.evaluate((key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    }, storageKey),
    viewport: page.viewportSize(),
  };
  const template = { ...structuredClone(preferences), mode: 'system', preset: 'ocean', windows: {} };
  let shadow = structuredClone(template);
  let phase = { name: 'initial', scenario: 'authenticated' };
  let configuration = {};
  const report = { passed: false, layout: [], behavior: [], storage: [], mutations: [], preferencePuts: [], browserErrors: [], cleanup: {} };
  const onError = (e) => report.browserErrors.push({ phase: phase.name, name: e.name, message: e.message });
  page.on('pageerror', onError);
  const respond = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  const handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin.origin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/desktop-preferences') {
      if (req.method() === 'GET')
        return respond(route, phase.getFail ? { message: 'Controlled preference GET failure' } : shadow, phase.getFail ? 500 : 200);
      if (req.method() === 'PUT') {
        const value = req.postDataJSON();
        report.preferencePuts.push({ phase: phase.name, mode: value.mode, preset: value.preset, status: phase.putFail ? 500 : 200 });
        if (!phase.putFail) shadow = value;
        return respond(route, phase.putFail ? { message: 'Controlled preference save failure' } : shadow, phase.putFail ? 500 : 200);
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      report.mutations.push({ path: url.pathname, method: req.method(), phase: phase.name });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/user-context')
      return respond(route, {
        version: { current: '4.10.1', latest: '4.10.1', body: '', releases: [] },
        isLoggedIn: phase.scenario === 'authenticated',
        isConfigured: true,
        isGuestDashboardEnabled: phase.scenario === 'guest',
        allowAutoThemes: false,
        allowErrorMonitoring: false,
        themeColor: 'blue',
        themeBase: 'slate',
        localDomain: 'local.test',
        sslPort: 443,
      });
    if (url.pathname === '/api/apps/guest') return respond(route, { installed: [] });
    if (url.pathname === '/api/links/guest') return respond(route, { links: [] });
    if (url.pathname === '/api/marketplace/all' && phase.fallback) return respond(route, { message: 'Controlled theme fallback' }, 500);
    return route.fallback();
  };
  await page.route('**/api/**', handler);
  await page.addInitScript(
    ({ prefix, key }) => {
      if (!window.name.startsWith(prefix)) return;
      const config = JSON.parse(window.name.slice(prefix.length));
      const local = localStorage;
      const oldGet = Storage.prototype.getItem;
      const oldSet = Storage.prototype.setItem;
      const oldAdd = MediaQueryList.prototype.addEventListener;
      const oldRemove = MediaQueryList.prototype.removeEventListener;
      const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
      if (config.seed) {
        oldSet.call(local, key, JSON.stringify(config.preferences));
      }
      config.seed = false;
      window.name = prefix + JSON.stringify(config);
      const active = [];
      let adds = 0;
      let removes = 0;
      Storage.prototype.getItem = function (...args) {
        if (this === local && config.readDenied) throw new DOMException('Controlled localStorage read denial', 'SecurityError');
        return oldGet.apply(this, args);
      };
      Storage.prototype.setItem = function (...args) {
        if (this === local && config.writeDenied) throw new DOMException('Controlled localStorage write denial', 'SecurityError');
        return oldSet.apply(this, args);
      };
      if (config.cookieDenied && cookie)
        Object.defineProperty(Document.prototype, 'cookie', {
          configurable: true,
          get() {
            throw new DOMException('Controlled cookie denial', 'SecurityError');
          },
          set() {
            throw new DOMException('Controlled cookie denial', 'SecurityError');
          },
        });
      MediaQueryList.prototype.addEventListener = function (type, listener, options) {
        if (type === 'change' && this.media.includes('prefers-color-scheme')) {
          if (!active.some((x) => x.query === this && x.listener === listener)) active.push({ query: this, listener });
          adds++;
        }
        return oldAdd.call(this, type, listener, options);
      };
      MediaQueryList.prototype.removeEventListener = function (type, listener, options) {
        if (type === 'change' && this.media.includes('prefers-color-scheme')) {
          const index = active.findIndex((x) => x.query === this && x.listener === listener);
          if (index >= 0) active.splice(index, 1);
          removes++;
        }
        return oldRemove.call(this, type, listener, options);
      };
      window.__orbisSystemQa = {
        activeCount: () => active.length,
        counts: () => ({ active: active.length, adds, removes }),
        restore: () => {
          Storage.prototype.getItem = oldGet;
          Storage.prototype.setItem = oldSet;
          MediaQueryList.prototype.addEventListener = oldAdd;
          MediaQueryList.prototype.removeEventListener = oldRemove;
          if (cookie) Object.defineProperty(Document.prototype, 'cookie', cookie);
        },
      };
    },
    { prefix: namePrefix, key: storageKey },
  );
  const shot = (name, options = {}) => capture(`system-${name}`, { scrollTop: false, fullPage: false, ...options });
  const visit = async (path, options = {}) => {
    phase = {
      name: options.name || path,
      scenario: options.scenario || 'authenticated',
      getFail: !!options.getFail,
      putFail: !!options.putFail,
      fallback: !!options.fallback,
    };
    report.current = phase.name;
    if (options.reset !== false) shadow = { ...structuredClone(template), ...(options.mode ? { mode: options.mode } : {}) };
    configuration = {
      seed: options.seed !== false,
      preferences: shadow,
      readDenied: !!options.readDenied,
      writeDenied: !!options.writeDenied,
      cookieDenied: !!options.cookieDenied,
    };
    await page.evaluate(
      ({ name, prefix }) => {
        window.name = prefix + JSON.stringify(name);
      },
      { name: configuration, prefix: namePrefix },
    );
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.locator(options.selector || '.desktop-settings').waitFor();
    await settle(page);
  };
  const flip = async (mode, selector = '.desktop') => {
    const writes = report.preferencePuts.length;
    await page.emulateMedia({ colorScheme: mode });
    const snapshot = await assertMode(page, mode, selector);
    await page.waitForTimeout(420);
    assert.equal(report.preferencePuts.length, writes, 'OS media changes must not save preferences');
    return snapshot;
  };
  try {
    for (const viewport of [
      { width: 1440, height: 1120 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 320, height: 800 },
    ])
      for (const os of ['light', 'dark'])
        for (const scale of [1, 2]) {
          const tag = `${viewport.width}-${os}-text${scale}`;
          report.current = tag;
          await page.setViewportSize(viewport);
          await page.emulateMedia({ colorScheme: os });
          await visit('/settings?tab=appearance', { name: `layout-${tag}` });
          await page.locator('.appearance-mode-system[aria-pressed="true"]').waitFor();
          await assertMode(page, os);
          await scaleText(page, scale);
          await page.mouse.move(0, 0);
          await settle(page);
          const geometry = await appearanceGeometry(page);
          report.pending = { tag, geometry };
          checkAppearance(geometry);
          const focusStates = [];
          await page.locator('.appearance-mode-light').focus();
          for (const modeClass of ['light', 'dark', 'system']) {
            if (modeClass !== 'light') await page.keyboard.press('Tab');
            assert.equal(
              await page.locator(`.appearance-mode-${modeClass}`).evaluate((e) => e === document.activeElement),
              true,
              'Native Tab must reach every mode card',
            );
            await page.waitForTimeout(220);
            const focused = await page.locator(`.appearance-mode-${modeClass}`).evaluate((e) => {
              const r = e.getBoundingClientRect();
              const bar = document.querySelector('.desktop-system-bar').getBoundingClientRect();
              const dock = document.querySelector('.desktop-dock').getBoundingClientRect();
              const s = getComputedStyle(e);
              return { top: r.top, bottom: r.bottom, bar: bar.bottom, dock: dock.top, outline: s.outline, shadow: s.boxShadow };
            });
            assert.ok(focused.top >= focused.bar + 3 && focused.bottom <= focused.dock - 3, 'Mode keyboard focus must clear chrome');
            assert.ok(!focused.outline.startsWith('0px') || focused.shadow !== 'none', 'Mode focus marker must be visible');
            focusStates.push({ modeClass, ...focused });
          }
          await shot(tag);
          report.layout.push({ viewport, os, textScale: scale, geometry, focusStates });
          delete report.pending;
        }
    for (const viewport of [
      { width: 1440, height: 1120 },
      { width: 390, height: 844 },
    ]) {
      const label = String(viewport.width);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: 'dark' });
      await visit('/settings?tab=appearance', { name: `functional-${label}`, mode: 'light' });
      await page.locator('.appearance-mode-system').click();
      await page.waitForTimeout(650);
      assert.equal(shadow.mode, 'system');
      await assertMode(page, 'dark');
      const subscribed = await page.evaluate(() => window.__orbisSystemQa.activeCount());
      assert.ok(subscribed > 0);
      for (const os of ['light', 'dark', 'light', 'dark']) await flip(os);
      assert.equal(await page.evaluate(() => window.__orbisSystemQa.activeCount()), subscribed, 'OS changes must not leak subscriptions');
      await page.locator('.appearance-preset-graphite').click();
      await page.waitForTimeout(650);
      assert.equal(shadow.mode, 'system', 'Preset change must preserve system selection');
      await page.locator('.appearance-preset-ocean').click();
      await page.waitForTimeout(650);
      assert.equal(shadow.mode, 'system');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.appearance-mode-system[aria-pressed="true"]').waitFor();
      await assertMode(page, 'dark');
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export settings', exact: true }).click();
      const download = await downloadPromise;
      const stream = await download.createReadStream();
      assert.ok(stream);
      let exported = '';
      for await (const chunk of stream) exported += chunk;
      assert.equal(JSON.parse(exported).mode, 'system');
      await page.locator('.appearance-mode-light').click();
      await page.waitForTimeout(650);
      await page
        .locator('input[type="file"]')
        .setInputFiles({ name: 'controlled-system-settings.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
      await page.waitForTimeout(650);
      assert.equal(shadow.mode, 'system', 'Import must preserve system');
      await page.locator('.appearance-mode-system[aria-pressed="true"]').waitFor();
      const headerToggle = page.getByRole('button', { name: 'Switch to light mode', exact: true });
      await headerToggle.click();
      await page.waitForTimeout(650);
      assert.equal(shadow.mode, 'light');
      await assertMode(page, 'light');
      const writes = report.preferencePuts.length;
      await page.emulateMedia({ colorScheme: 'light' });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(450);
      await assertMode(page, 'light');
      assert.equal(report.preferencePuts.length, writes);
      assert.equal(await page.evaluate(() => window.__orbisSystemQa.activeCount()), 0, 'Manual mode must detach OS subscription');
      report.behavior.push({ viewport, case: 'selection-preset-save-reload-export-import-manual', passed: true });
      for (const route of [
        { path: '/dashboard', selector: '.workspace-activity', name: 'home-status' },
        { path: '/monitor', selector: '.desktop-host-overview', name: 'monitor-status' },
      ]) {
        await visit(route.path, { name: `${label}-${route.name}`, selector: route.selector });
        await flip('light');
        const light = await page
          .locator(route.selector)
          .evaluate((e) => ({ background: getComputedStyle(e).backgroundImage, ink: getComputedStyle(e).color }));
        await flip('dark');
        const dark = await page
          .locator(route.selector)
          .evaluate((e) => ({ background: getComputedStyle(e).backgroundImage, ink: getComputedStyle(e).color }));
        assert.notDeepEqual(light, dark, 'System status must actually change palette with OS');
        assert.equal((await assertMode(page, 'dark')).roots[0].preset, 'ocean');
        await shot(`${label}-${route.name}`);
        report.behavior.push({ viewport, case: route.name, light, dark, passed: true });
      }
      await visit('/settings?tab=appearance', { name: `${label}-toast` });
      const binding = await discoverToast(page);
      await page.evaluate(async (binding) => {
        const toast = (await import(binding.url))[binding.key];
        toast.success('Follow system fixture notification', { id: 'system-mode-proof', duration: Number.POSITIVE_INFINITY });
      }, binding);
      await page.locator('[data-notification-id="system-mode-proof"]').waitFor();
      await flip('light');
      await flip('dark');
      await shot(`${label}-toast`);
      await page.evaluate(async (binding) => (await import(binding.url))[binding.key].remove(), binding);
      report.behavior.push({ viewport, case: 'toast', passed: true });
      for (const editor of [
        { path: '/apps/test/media', selector: '.app-workspace', name: 'files-editor' },
        { path: '/apps/create', selector: '.service-config-tabs', name: 'compose-editor' },
      ]) {
        await visit(editor.path, { name: `${label}-${editor.name}`, selector: editor.selector });
        if (editor.name === 'files-editor')
          await page.getByRole('tablist', { name: 'Application sections' }).getByRole('tab', { name: 'Files', exact: true }).click();
        if (editor.name === 'compose-editor') await page.getByRole('button', { name: 'YAML Editor', exact: true }).click();
        const cm = page.locator('.cm-editor:visible').first();
        await cm.waitFor();
        const text = await cm.locator('.cm-content').innerText();
        await flip('light');
        const lightEditor = await cm.evaluate((e) => ({
          background: getComputedStyle(e).backgroundColor,
          ink: getComputedStyle(e).color,
          classes: e.className,
        }));
        await flip('dark');
        const darkEditor = await cm.evaluate((e) => ({
          background: getComputedStyle(e).backgroundColor,
          ink: getComputedStyle(e).color,
          classes: e.className,
        }));
        report.pending = { phase: phase.name, lightEditor, darkEditor };
        assert.notDeepEqual(lightEditor, darkEditor, 'The actual CodeMirror theme must change with the OS');
        assert.notEqual(lightEditor.background, darkEditor.background, 'CodeMirror painted backgrounds must change');
        const channels = (value) =>
          value
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number);
        assert.ok(
          channels(lightEditor.background).reduce((a, b) => a + b, 0) > channels(darkEditor.background).reduce((a, b) => a + b, 0),
          'Light editor background must be visibly lighter than dark',
        );
        assert.equal(await cm.locator('.cm-content').innerText(), text, 'OS theme must retain editor contents');
        report.behavior.push({ viewport, case: editor.name, lightEditor, darkEditor, passed: true });
        delete report.pending;
      }
      for (const surface of [
        { scenario: 'login', path: '/login', selector: '.desktop-auth' },
        { scenario: 'guest', path: '/dashboard', selector: '.desktop-guest' },
        { scenario: 'authenticated', path: '/settings?tab=appstores', selector: '.desktop-fallback', fallback: true },
      ]) {
        await visit(surface.path, {
          name: `${label}-${surface.scenario}-${surface.fallback ? 'fallback' : 'surface'}`,
          scenario: surface.scenario,
          selector: surface.selector,
          fallback: surface.fallback,
        });
        await flip('light', surface.selector);
        await flip('dark', surface.selector);
        if (surface.scenario === 'guest') {
          const count = report.preferencePuts.length;
          await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
          await assertMode(page, 'light', surface.selector);
          await page.waitForTimeout(650);
          assert.equal(report.preferencePuts.length, count, 'Guest edits must remain local');
          const cache = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).mode, storageKey);
          assert.equal(cache, 'light');
        }
        await shot(`${label}-${surface.scenario}-${surface.fallback ? 'fallback' : 'surface'}`);
        report.behavior.push({ viewport, case: surface.fallback ? 'fallback' : surface.scenario, passed: true });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const storage of [
      { name: 'read-denied', readDenied: true },
      { name: 'read-load-failure', readDenied: true, getFail: true },
      { name: 'write-denied', writeDenied: true },
      { name: 'read-write-denied', readDenied: true, writeDenied: true },
      { name: 'cookie-denied', cookieDenied: true },
      { name: 'save-cache-failure', writeDenied: true, putFail: true },
      { name: 'load-cache-failure', readDenied: true, writeDenied: true, getFail: true },
    ]) {
      await visit('/settings?tab=appearance', { ...storage, selector: '.appearance-mode-system' });
      await page.locator('.appearance-mode-dark').click();
      await page.waitForTimeout(700);
      assert.equal(await page.locator('.desktop-fallback-panel').count(), 0, 'Storage denial must not crash');
      const note = await page.locator('.appearance-note').textContent();
      if (storage.putFail || storage.getFail) {
        assert.ok(!/Changes are cached|Saved in this browser|Saving changes/i.test(note), 'Failed server and cache must not claim cached/saving');
        assert.match(note, /lost|not saved|unavailable/i);
      } else assert.equal(note.trim(), 'Synced to your account');
      await shot(`390-${storage.name}`);
      report.storage.push({ ...storage, note, passed: true });
    }
    assert.equal(report.layout.length, 16);
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.browserErrors, []);
    report.passed = true;
    return report;
  } catch (error) {
    await shot(`failure-${report.current || phase.name}`).catch(() => undefined);
    error.systemModeReport = report;
    throw error;
  } finally {
    page.off('pageerror', onError);
    if (!page.isClosed()) {
      await page.evaluate(
        ({ name, key, storage }) => {
          window.__orbisSystemQa?.restore();
          for (const [element, values] of window.__orbisSystemTextOriginals || [])
            if (element.isConnected)
              for (const [property, value, priority] of values) {
                if (value) element.style.setProperty(property, value, priority);
                else element.style.removeProperty(property);
              }
          delete window.__orbisSystemQa;
          delete window.__orbisSystemTextOriginals;
          window.name = name;
          if (storage === null) localStorage.removeItem(key);
          else localStorage.setItem(key, storage);
          if (localStorage.getItem(key) !== storage) throw new Error('Fixture preference cache was not restored');
        },
        { name: original.name, key: storageKey, storage: original.storage },
      );
      await page.emulateMedia({ colorScheme: null });
      await page.setViewportSize(original.viewport);
    }
    await page.unroute('**/api/**', handler);
    report.cleanup = {
      routesRestored: true,
      listenersRestored: true,
      browserStorageHooksRestored: true,
      windowNameRestored: true,
      viewportRestored: true,
    };
  }
};
