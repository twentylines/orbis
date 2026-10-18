const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const { dom } = require('./host-devices-checks.cjs');
const settingsAlignment = require('./settings-alignment-checks.cjs');

const controlsSelector = 'button:not([role=switch]),input:not([type=checkbox]):not([type=radio]),select,[role=combobox],summary';
const samples = [
  { name: 'home', path: '/dashboard', ready: '.workspace-heading', root: '.desktop-main' },
  { name: 'monitor', path: '/monitor', ready: '.desktop-host-overview-readings strong', root: '.desktop-route-window' },
  { name: 'appearance', path: '/settings?tab=appearance', ready: '.appearance-section', root: '.desktop-route-window' },
  { name: 'apps', path: '/apps', ready: '.desktop-installed-grid .app-link', root: '.desktop-route-window' },
  { name: 'store', path: '/app-store', ready: '.desktop-catalogue-grid .app-tile', root: '.desktop-route-window' },
  { name: 'updates', path: '/updates', ready: '.desktop-updates-card', root: '.desktop-route-window' },
  { name: 'login', path: '/login', ready: '.desktop-auth input[name=email]', root: '.desktop-auth', anonymous: true },
  { name: 'reset', path: '/reset-password', ready: '.desktop-auth pre', root: '.desktop-auth', anonymous: true },
];
async function measure(page, rootSelector) {
  return page.locator(rootSelector).evaluate((root, controlsSelector) => {
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, cy: (r.top + r.bottom) / 2 };
    };
    const visible = (element) => {
      const s = getComputedStyle(element);
      return (
        element.getClientRects().length > 0 && s.visibility !== 'hidden' && !element.closest('[aria-hidden=true],[hidden],.visually-hidden,.sr-only')
      );
    };
    const rects = (range) =>
      [...range.getClientRects()].filter((r) => r.width && r.height).map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }));
    const fonts = [
      ...root.querySelectorAll(
        'h1,h2,h3,.desktop-telemetry-lead > strong,.desktop-host-overview-readings strong,.workspace-status-copy > strong,.workspace-gauge strong,.workspace-storage > strong,.desktop-update-release-title',
      ),
    ]
      .filter(visible)
      .map((element) => ({
        selector: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${String(element.className).trim().replaceAll(/\s+/g, '.')}`,
        text: element.textContent.trim(),
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        lineHeight: getComputedStyle(element).lineHeight,
        box: box(element),
      }));
    const words = [];
    const clipped = [];
    const ellipses = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!visible(parent) || parent.closest('svg,pre,code,textarea,[data-radix-popper-content-wrapper]')) continue;
      let ellipsis = null;
      for (let ancestor = parent; ancestor && root.contains(ancestor); ancestor = ancestor.parentElement) {
        const css = getComputedStyle(ancestor);
        if (css.textOverflow === 'ellipsis' && css.overflowX === 'hidden' && css.whiteSpace === 'nowrap') {
          ellipsis = ancestor;
          break;
        }
      }
      if (ellipsis && ellipsis.scrollWidth > ellipsis.clientWidth + 1) {
        const titled = ellipsis.closest('[title]');
        ellipses.push({
          text: ellipsis.textContent,
          title: titled?.title || '',
          css: true,
          accessible: Boolean(titled?.title?.includes(ellipsis.textContent)),
        });
        continue;
      }
      const boundary = parent.getBoundingClientRect();
      for (const match of node.textContent.matchAll(/[A-Za-z]{3,}|\d[\d,.]*%?/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const painted = rects(range);
        if (new Set(painted.map((r) => Math.round(r.top))).size > 1) words.push({ word: match[0], context: parent.textContent, rects: painted });
        for (const r of painted)
          if (r.left < boundary.left - 1 || r.right > boundary.right + 1)
            clipped.push({ word: match[0], context: parent.textContent, rect: r, bounds: { left: boundary.left, right: boundary.right } });
      }
    }
    const controls = [...root.querySelectorAll(controlsSelector)]
      .map((element, index) => {
        if (!visible(element) || element.closest('.desktop-window-controls,.desktop-window-resize')) return null;
        const css = getComputedStyle(element);
        const chrome = Boolean(element.closest('.desktop-system-bar,.desktop-dock'));
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          index,
          tag: element.tagName,
          type: element.getAttribute('type'),
          role: element.getAttribute('role'),
          classes: element.className,
          text: element.tagName === 'INPUT' ? element.getAttribute('name') : element.textContent.trim(),
          box: box(element),
          ink: rects(range),
          fontSize: Number.parseFloat(css.fontSize),
          padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(Number.parseFloat),
          chrome,
          inheritedTarget: element.matches('.container-resources-sort button')
            ? 'Existing36px Usage sort'
            : element.matches('.monitor-history-ranges button')
              ? 'Existing38px Monitor range'
              : element.matches('.desktop-auth input.form-control')
                ? 'Existing36px authentication input'
                : element.tagName === 'SUMMARY' && !element.matches('.monitor-history-info summary')
                  ? 'Existing native disclosure summary'
                  : null,
          disabled: element.disabled || false,
        };
      })
      .filter(Boolean);
    const frame = root.closest('.desktop-route-window') || root.querySelector('.desktop-route-window');
    const heading = frame?.querySelector('.desktop-window-bar');
    const icon = heading?.querySelector('.desktop-window-icon');
    const headingLabel = heading?.querySelector('h1');
    const content = frame?.querySelector('.desktop-window-content');
    const setting = root.querySelector('.desktop-settings');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      scroll: { x: scrollX, y: scrollY, content: content?.scrollTop || 0, frame: frame?.scrollTop || 0 },
      mode: document.querySelector('.orbis-theme')?.dataset.desktopMode,
      preset: document.querySelector('.orbis-theme')?.dataset.desktopPreset,
      htmlFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      bodyFont: Number.parseFloat(getComputedStyle(document.body).fontSize),
      tokens: Object.fromEntries(
        ['title', 'section', 'reading', 'page-title', 'panel-space', 'section-gap'].map((name) => [
          name,
          getComputedStyle(root).getPropertyValue(`--orbis-compact-${name}`).trim(),
        ]),
      ),
      fonts,
      words,
      clipped,
      ellipses,
      controls,
      heading:
        icon && headingLabel
          ? { icon: box(icon), label: box(headingLabel), fontSize: Number.parseFloat(getComputedStyle(headingLabel).fontSize) }
          : null,
      navigation: frame?.dataset.windowNavigation,
      content: content ? box(content) : null,
      settings: setting ? box(setting) : null,
      panels: [
        ...root.querySelectorAll(
          '.workspace-activity,.workspace-operations,.workspace-attention,.desktop-host-overview,.desktop-telemetry-grid > section,.host-sensors,.host-processes,.host-device-history,.desktop-updates-card,.desktop-auth .card-body',
        ),
      ]
        .filter(visible)
        .map((element) => ({
          classes: element.className,
          box: box(element),
          padding: [getComputedStyle(element).paddingLeft, getComputedStyle(element).paddingRight].map(Number.parseFloat),
        })),
      chromeControls: [...document.querySelectorAll('.desktop-system-bar button,.desktop-system-bar .desktop-icon-button')]
        .filter(visible)
        .map((element) => ({ classes: element.className, box: box(element) })),
      auth: root.matches('.desktop-auth')
        ? {
            card: box(root.querySelector('.card')),
            body: box(root.querySelector('.card-body')),
            code: [...root.querySelectorAll('pre')].map((element) => ({
              box: box(element),
              complete: element.textContent === './runtipi-cli reset-password',
            })),
          }
        : null,
    };
  }, controlsSelector);
}
function checkGeometry(value, name) {
  assert.ok(value.documentWidth <= value.viewport.width, `${name}: document must not overflow horizontally`);
  assert.deepEqual(value.words, [], `${name}: ordinary words and values must not split into fragments`);
  assert.deepEqual(value.clipped, [], `${name}: text must not paint outside its actual allocated box`);
  assert.ok(
    value.ellipses.every((item) => item.accessible),
    `${name}: deliberate identifier ellipsis must retain the complete accessible text`,
  );
  if (value.heading && value.navigation === 'page')
    assert.ok(Math.abs(value.heading.icon.cy - value.heading.label.cy) <= 1, `${name}: compact page icon and title centres must align`);
  if (value.navigation)
    assert.equal(
      value.navigation,
      value.viewport.width >= 1100 && value.viewport.height >= 640 ? 'desktop' : 'page',
      `${name}: small screens retain ordinary pages`,
    );
  for (const panel of value.panels)
    assert.ok(
      panel.padding.every((n) => n >= 12),
      `${name}: compact panels keep at least12px interior breathing room`,
    );
  for (const control of value.controls) {
    if (control.chrome) continue;
    if (control.inheritedTarget) {
      const minimum = control.inheritedTarget.includes('38px') ? 38 : control.inheritedTarget.includes('36px') ? 36 : null;
      if (minimum) assert.ok(control.box.height >= minimum, `${name}: inherited target must not collapse below its recorded legacy contract`);
      continue;
    }
    assert.ok(control.box.height >= 40, `${name}: ${control.text || control.classes} target is ${control.box.height}px, below40px`);
    if (control.box.width < 40 && !control.text) assert.fail(`${name}: icon control target is narrower than40px`);
  }
  for (const item of value.chromeControls) assert.ok(item.box.height >= 36, `${name}: existing phone chrome keeps its separate36px contract`);
  if (value.auth)
    assert.ok(
      value.auth.card.left >= 12 &&
        value.auth.card.right <= value.viewport.width - 12 &&
        value.auth.code.every((code) => code.complete && code.box.left >= value.auth.body.left && code.box.right <= value.auth.body.right),
      `${name}: auth card/complete reset command retain their viewport/form gutters`,
    );
  if (name === 'home') {
    const title = value.fonts.find((font) => font.selector === 'h1.' || font.text === 'Hades');
    assert.ok(title, 'Home native title must be measured');
    const width = value.viewport.width;
    const max = width <= 380 ? 24 : width <= 760 ? 26 : width <= 1099 ? 32 : 80;
    assert.ok(title.fontSize <= max + 0.1, `Home native compact title ${title.fontSize}px exceeds ${max}px scale`);
  }
  if (value.viewport.width <= 760) {
    for (const font of value.fonts.filter((font) => font.selector === '#desktop-host-overview-title'))
      assert.ok(font.fontSize <= 26.1, 'Native phone Monitor title must reduce with compact scale');
    for (const font of value.fonts.filter((font) =>
      ['#host-sensors-title', '#host-processes-title', '#host-device-history-title'].includes(font.selector),
    ))
      assert.ok(font.fontSize <= 18.1, 'Native phone Monitor sections must share compact headings');
  }
}
async function wheelVisible(page, locator) {
  for (let attempt = 0; attempt < 65; attempt++) {
    const value = await locator.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const frame = element.closest('.desktop-route-window');
      const desktop = frame?.dataset.windowNavigation === 'desktop';
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        clipTop:
          Math.max(
            document.querySelector('.desktop-system-bar')?.getBoundingClientRect().bottom || 0,
            desktop ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0,
          ) + 16,
        clipBottom:
          Math.min(
            document.querySelector('.desktop-dock')?.getBoundingClientRect().top || innerHeight,
            desktop ? frame.querySelector('.desktop-window-content').getBoundingClientRect().bottom : innerHeight,
          ) - 16,
      };
    });
    if (value.top >= value.clipTop && value.bottom <= value.clipBottom) return;
    const delta = value.top < value.clipTop ? value.top - value.clipTop : value.bottom - value.clipBottom;
    await page.mouse.move(
      Math.min((await page.viewportSize()).width - 30, value.left + 20),
      Math.max(value.clipTop + 40, Math.min(value.clipBottom - 40, value.clipTop + 80)),
    );
    await page.mouse.wheel(0, Math.max(-850, Math.min(850, delta)));
    await page.waitForTimeout(80);
  }
  throw new Error('Native wheel did not reveal bounded compact sample');
}
module.exports = async function inspectCompactScale({ page, base, capture, viewport }) {
  const origin = new URL(base);
  assert.ok(
    ['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8080' && origin.protocol === 'http:',
    'Compact checks only permit the static fixture preview8080',
  );
  const report = {
    passed: false,
    viewport,
    samples: [],
    errors: [],
    mutations: [],
    externalRequests: [],
    cleanup: {},
    scope:
      'Native default-fixture appearance only; six authenticated routes plus browser-only anonymous Login/Reset. Real homelab/recovery endpoints and credentials are not accessed. No enlarged-text matrix repeated; root owns that separate gate.',
  };
  const start = process.env.ORBIS_VISUAL_COMPACT_SCALE_FROM || 'home';
  const startIndex = samples.findIndex((sample) => sample.name === start);
  assert.ok(startIndex >= 0, 'Compact continuation must name an explicit retained route');
  const selectedSamples = samples.slice(startIndex);
  report.requestedStart = start;
  report.provenance = {
    helperSha256: hash(fs.readFileSync(__filename)),
    runnerSha256: hash(fs.readFileSync(require.resolve('./visual-qa.cjs'))),
    compiledIndexSha256: hash(fs.readFileSync(path.join(__dirname, '../packages/frontend/dist/client/index.html'))),
  };
  const originalViewport = page.viewportSize();
  let anonymous = false;
  let current;
  let rootSelector;
  const originalUser = await page.evaluate(() => fetch('/api/user-context').then((response) => response.json()));
  const onError = (error) => report.errors.push({ name: error.name, message: error.message });
  const handler = (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) {
      report.externalRequests.push(url.origin);
      return route.abort('blockedbyclient');
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ path: url.pathname, method: request.method() });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/user-context' && anonymous)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...originalUser, isLoggedIn: false }) });
    return route.fallback();
  };
  page.on('pageerror', onError);
  await page.route('**/*', handler);
  try {
    for (const sample of selectedSamples) {
      current = sample.name;
      rootSelector = sample.root;
      report.current = current;
      anonymous = Boolean(sample.anonymous);
      await page.goto(`${base}${sample.path}`, { waitUntil: 'domcontentloaded' });
      await page.locator(sample.ready).first().waitFor();
      await dom.settle(page);
      const metrics = await measure(page, sample.root);
      const item = {
        name: current,
        path: sample.path,
        passed: false,
        metrics,
        inheritedUnder40Targets: metrics.controls.filter((control) => control.inheritedTarget && control.box.height < 40),
        allMeasuredTargetsMeet40: metrics.controls.every((control) => control.box.height >= 40),
      };
      report.samples.push(item);
      await capture(`compact-${current}`, { scrollTop: false, fullPage: false });
      checkGeometry(metrics, current);
      if (current === 'appearance') item.sharedGutters = await settingsAlignment(page);
      if (current === 'monitor') {
        await wheelVisible(page, page.locator('#host-sensors-title'));
        await capture('compact-monitor-lower', { scrollTop: false, fullPage: false });
      }
      if (current === 'login') {
        await page.locator('input[name=email]').focus();
        await page.keyboard.press('Tab');
        await dom.settle(page);
        item.keyboardPassword = await page.evaluate(() => ({
          type: document.activeElement.getAttribute('type'),
          top: document.activeElement.getBoundingClientRect().top,
          bottom: document.activeElement.getBoundingClientRect().bottom,
          height: innerHeight,
        }));
        assert.ok(
          item.keyboardPassword.type === 'password' && item.keyboardPassword.top >= 0 && item.keyboardPassword.bottom <= item.keyboardPassword.height,
          'Native auth focus is visible without scroll reset',
        );
      }
      item.passed = true;
    }
    assert.equal(report.samples.length, selectedSamples.length);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.externalRequests, []);
    report.passed = true;
  } catch (error) {
    report.failure = { name: error.name, message: error.message, route: current };
    if (rootSelector)
      try {
        report.failure.before = await measure(page, rootSelector);
        const bad = report.failure.before.controls.find((control) => !control.chrome && !control.inheritedTarget && control.box.height < 40);
        if (bad) {
          report.failure.revealedControl = { index: bad.index, text: bad.text, box: bad.box };
          await wheelVisible(page, page.locator(rootSelector).locator(controlsSelector).nth(bad.index));
          report.failure.afterNativeWheel = await measure(page, rootSelector);
        }
      } catch (measureError) {
        report.failure.diagnosticError = measureError.message;
      }
    await capture(`compact-${current}-FAILED`, { scrollTop: false, fullPage: false }).catch(() => {
      report.failure.captureUnavailable = true;
    });
  } finally {
    try {
      await page.unroute('**/*', handler);
      report.cleanup.routesRestored = true;
    } catch (error) {
      report.cleanup.routesRestored = false;
      report.cleanup.routeError = error.message;
    }
    try {
      page.off('pageerror', onError);
      assert.equal(page.listeners('pageerror').includes(onError), false);
      report.cleanup.listenerRestored = true;
    } catch (error) {
      report.cleanup.listenerRestored = false;
      report.cleanup.listenerError = error.message;
    }
    try {
      await page.setViewportSize(originalViewport);
      report.cleanup.viewportRestored = true;
    } catch (error) {
      report.cleanup.viewportRestored = false;
      report.cleanup.viewportError = error.message;
    }
    if (!Object.values(report.cleanup).every((value) => value === true)) report.passed = false;
  }
  return report;
};
