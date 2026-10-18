const assert = require('node:assert/strict');
const { dom } = require('./host-devices-checks.cjs');

const endpoint = '/api/system/host-sensors';
const rootSelector = '.host-sensors';
const aboutSelector = '.host-sensors-about summary';
const retrySelector = '.host-sensors-notice button';
const id = (kind, index) => `${kind}:${index.toString(16).padStart(16, '0')}`;

function fixture(variant = 'ready') {
  if (variant === 'missing') return { available: false, reason: 'Sensor readings are unavailable. Check the Orbis host service.' };
  if (variant === 'collecting') return { available: false, reason: 'Collecting sensor readings.' };
  const result = {
    available: true,
    sampledAt: new Date(Date.now() - (variant === 'stale' ? 120000 : 0)).toISOString(),
    stale: variant === 'stale',
    limited: false,
    unreadable: 0,
    omitted: { temperatures: 0, fans: 0, gpus: 0 },
    unavailable: [],
    temperatures: [
      {
        id: id('temperature', 1),
        label: 'Processor package temperature',
        chip: 'motherboard-monitoring-controller-secondary-archive-0123456789',
        status: 'available',
        celsius: 0,
        criticalCelsius: null,
      },
      { id: id('temperature', 2), label: 'Storage controller', chip: 'nvme', status: 'available', celsius: 1000, criticalCelsius: 90 },
      { id: id('temperature', 3), label: 'External probe', chip: 'nct6775', status: 'fault', celsius: null, criticalCelsius: null },
      { id: id('temperature', 4), label: 'Disabled probe', chip: 'nct6775', status: 'disabled', celsius: null, criticalCelsius: null },
      { id: id('temperature', 5), label: 'Unavailable probe', chip: 'nct6775', status: 'unavailable', celsius: null, criticalCelsius: null },
      { id: id('temperature', 6), label: 'Cold ambient probe', chip: 'environment', status: 'available', celsius: -273.15, criticalCelsius: 0 },
    ],
    fans: [
      { id: id('fan', 1), label: 'Stopped chassis fan', chip: 'nct6775', status: 'available', rpm: 0 },
      { id: id('fan', 2), label: 'Maximum reported fan', chip: 'nct6775', status: 'available', rpm: 1000000 },
      { id: id('fan', 3), label: 'Faulted fan', chip: 'nct6775', status: 'fault', rpm: null },
      { id: id('fan', 4), label: 'Disabled fan', chip: 'nct6775', status: 'disabled', rpm: null },
    ],
    gpus: [
      {
        id: id('gpu', 1),
        label: 'Primary graphics adapter with a complete accessible descriptive name',
        vendor: 'AMD',
        driver: 'amdgpu',
        utilizationPercent: 0,
        memoryUsedBytes: 0,
        memoryTotalBytes: Number.MAX_SAFE_INTEGER,
      },
      {
        id: id('gpu', 2),
        label: 'Busy graphics adapter',
        vendor: 'AMD',
        driver: 'amdgpu',
        utilizationPercent: 100,
        memoryUsedBytes: Number.MAX_SAFE_INTEGER,
        memoryTotalBytes: Number.MAX_SAFE_INTEGER,
      },
      {
        id: id('gpu', 3),
        label: 'Identity only graphics adapter',
        vendor: 'Intel',
        driver: 'i915',
        utilizationPercent: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
      },
      {
        id: id('gpu', 4),
        label: 'Driver not reported',
        vendor: null,
        driver: null,
        utilizationPercent: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
      },
    ],
  };
  if (variant === 'refreshed') result.fans[0].rpm = 42;
  if (['partial', 'stale'].includes(variant)) {
    result.unavailable = ['fans'];
    result.unreadable = 3;
    result.limited = true;
    result.omitted = { temperatures: 1, fans: 2, gpus: 3 };
  }
  if (['empty', 'failed-empty', 'limited-empty'].includes(variant)) result.temperatures = result.fans = result.gpus = [];
  if (variant === 'failed-empty') {
    result.unavailable = ['temperatures', 'fans', 'gpus'];
    result.unreadable = 3;
  }
  if (variant === 'limited-empty') {
    result.limited = true;
    result.omitted = { temperatures: 1, fans: 2, gpus: 3 };
  }
  return result;
}

function bytes(value) {
  const index = Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
}

async function inspect(page) {
  return page.locator(rootSelector).evaluate((root) => {
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const ink = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()]
        .filter((r) => r.width && r.height)
        .map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }));
    };
    const style = getComputedStyle(root);
    const inner = {
      left: box(root).left + Number.parseFloat(style.paddingLeft) + 1,
      right: box(root).right - Number.parseFloat(style.paddingRight) - 1,
    };
    const words = [];
    const overflow = [];
    const identifiers = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent.getClientRects().length || parent.closest('svg,[aria-hidden="true"]')) continue;
      const identifier = parent.closest('h4,.host-sensor-chip');
      if (identifier && identifier.dataset.fallback !== 'true') continue;
      const owner = parent.closest('.host-sensor-card') || root;
      const ownerStyle = getComputedStyle(owner);
      const boundary = {
        left: box(owner).left + Number.parseFloat(ownerStyle.paddingLeft) + 1,
        right: box(owner).right - Number.parseFloat(ownerStyle.paddingRight) - 1,
      };
      for (const match of node.textContent.matchAll(/[A-Za-z][A-Za-z'-]{2,}|-?\d[\d,.]*/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width && r.height);
        if (new Set(rects.map((r) => Math.round(r.top))).size > 1)
          words.push({
            text: match[0],
            context: parent.textContent,
            rects: rects.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
          });
        for (const r of rects)
          if (r.left < boundary.left - 1 || r.right > boundary.right + 1)
            overflow.push({ text: match[0], context: parent.textContent, bounds: boundary, left: r.left, right: r.right });
      }
    }
    for (const element of root.querySelectorAll('h4,.host-sensor-chip')) {
      const s = getComputedStyle(element);
      identifiers.push({
        text: element.textContent,
        title: element.title,
        fallback: element.dataset.fallback === 'true',
        ellipsis: element.scrollWidth > element.clientWidth + 1,
        overflow: s.overflowX,
        whiteSpace: s.whiteSpace,
        textOverflow: s.textOverflow,
      });
    }
    const chrome = (element) => {
      const s = getComputedStyle(element);
      return {
        background: s.backgroundColor,
        blur: s.backdropFilter,
        shadow: s.boxShadow,
        borders: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor],
      };
    };
    const frame = root.closest('.desktop-route-window');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      root: box(root),
      monitor: box(root.closest('.desktop-monitor')),
      inner,
      padding: [style.paddingLeft, style.paddingRight].map(Number.parseFloat),
      heading: box(root.querySelector('h2')),
      headingInk: ink(root.querySelector('h2')),
      words,
      overflow,
      identifiers,
      groups: [...root.querySelectorAll('.host-sensor-groups > section')].map((group) => ({
        box: box(group),
        heading: box(group.querySelector('h3')),
        cards: [...group.querySelectorAll('.host-sensor-card')].map((card) => ({
          box: box(card),
          padding: [getComputedStyle(card).paddingLeft, getComputedStyle(card).paddingRight].map(Number.parseFloat),
          title: box(card.querySelector('h4')),
          chip: box(card.querySelector('.host-sensor-chip')),
          facts: [...card.querySelectorAll('.host-gpu-facts > div')].map((fact) => ({
            box: box(fact),
            label: ink(fact.querySelector('dt')),
            value: ink(fact.querySelector('dd')),
          })),
        })),
      })),
      chrome: {
        navigation: frame.dataset.windowNavigation,
        frame: chrome(frame),
        header: chrome(frame.querySelector('.desktop-window-bar')),
        bar: chrome(document.querySelector('.desktop-system-bar')),
        dock: chrome(document.querySelector('.desktop-dock')),
      },
    };
  });
}

function check(value) {
  assert.ok(value.documentWidth <= value.viewport.width, 'No horizontal document overflow');
  assert.deepEqual(value.words, [], 'Ordinary words and complete numbers must not fracture');
  assert.deepEqual(value.overflow, [], 'Painted text retains its card/section gutter');
  assert.ok(
    value.padding.every((n) => n >= 18),
    'Sensor section has at least18px horizontal padding',
  );
  assert.ok(
    Math.abs(value.root.left - value.monitor.left) <= 1 && Math.abs(value.root.right - value.monitor.right) <= 1,
    'Sensor section shares Monitor outer edges',
  );
  assert.ok(Math.abs(value.heading.left - value.inner.left) <= 1, 'Heading uses the shared section gutter');
  for (const identifier of value.identifiers) {
    if (identifier.fallback) {
      assert.equal(identifier.text, identifier.title, 'Ordinary fallback copy retains its complete title');
      assert.equal(identifier.ellipsis, false, 'Ordinary fallback copy wraps instead of truncating');
    }
    if (identifier.title) assert.equal(identifier.text, identifier.title, 'Full accessible identifier retained in title and DOM');
    if (identifier.ellipsis)
      assert.ok(
        identifier.text === identifier.title &&
          identifier.overflow === 'hidden' &&
          identifier.whiteSpace === 'nowrap' &&
          identifier.textOverflow === 'ellipsis',
        'Only explicit accessible ellipsis may truncate identifiers',
      );
  }
  for (const group of value.groups) {
    assert.ok(Math.abs(group.heading.left - group.box.left) <= 1, 'Group heading aligns with its cards');
    for (const card of group.cards) {
      assert.ok(Math.abs(card.box.left - group.box.left) <= 1 && Math.abs(card.box.right - group.box.right) <= 1, 'Cards share group edges');
      assert.ok(
        card.padding.every((n) => n >= 18),
        'Card text has18px padding',
      );
      assert.ok(Math.abs(card.title.left - card.chip.left) <= 1, 'Title and chip share the card gutter');
      for (const fact of card.facts)
        for (const rect of [...fact.label, ...fact.value])
          assert.ok(rect.left >= fact.box.left - 1 && rect.right <= fact.box.right + 1, 'GPU fact ink fits its actual column');
    }
  }
  for (const chrome of [value.chrome.bar, value.chrome.dock]) {
    assert.equal(chrome.blur, 'blur(28px) saturate(1.45)');
    assert.ok(chrome.background.startsWith('rgba(') && !chrome.background.endsWith(', 1)'), 'Glass remains translucent');
    assert.ok(chrome.borders.every((c) => c === 'rgba(0, 0, 0, 0)') && !chrome.shadow.includes('inset'), 'No bright white chrome rims');
  }
  if (value.chrome.navigation === 'desktop') {
    assert.equal(value.chrome.header.blur, value.chrome.dock.blur);
    assert.equal(value.chrome.frame.background, 'rgba(0, 0, 0, 0)');
    assert.ok(value.chrome.frame.borders.every((c) => c === 'rgba(0, 0, 0, 0)') && !value.chrome.frame.shadow.includes('inset'));
  }
}

async function verifyValues(page, variant) {
  const value = fixture(variant);
  if (!value.available) return;
  const states = { fault: 'Sensor fault', disabled: 'Disabled', unavailable: 'Unavailable' };
  for (const row of value.temperatures) {
    const card = page.locator(`[data-sensor-id="${row.id}"]`);
    assert.equal(await card.locator('h4').textContent(), row.label);
    assert.equal(
      await card.locator('.host-sensor-reading').textContent(),
      row.celsius === null ? states[row.status] : `${row.celsius.toLocaleString('en-US', { maximumFractionDigits: 1 })} °C`,
    );
  }
  for (const row of value.fans)
    assert.equal(
      await page.locator(`[data-sensor-id="${row.id}"] .host-sensor-reading`).textContent(),
      row.rpm === null ? states[row.status] : `${row.rpm.toLocaleString('en-US')} RPM`,
    );
  for (const row of value.gpus) {
    const texts = await page.locator(`[data-sensor-id="${row.id}"] dd`).allTextContents();
    assert.deepEqual(texts, [
      row.utilizationPercent === null ? 'Unavailable' : `${row.utilizationPercent.toFixed(1)}%`,
      row.memoryUsedBytes === null ? 'Unavailable' : bytes(row.memoryUsedBytes),
      row.memoryTotalBytes === null ? 'Unavailable' : bytes(row.memoryTotalBytes),
    ]);
  }
}

async function focusSnapshot(page, selector) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await dom.settle(page);
  return page.locator(selector).evaluate((element) => {
    const frame = element.closest('.desktop-route-window');
    const desktop = frame.dataset.windowNavigation === 'desktop';
    const content = frame.querySelector('.desktop-window-content');
    const r = element.getBoundingClientRect();
    const s = getComputedStyle(element);
    const extent = s.outlineStyle === 'none' ? 0 : Number.parseFloat(s.outlineWidth) + Math.max(0, Number.parseFloat(s.outlineOffset));
    const top = Math.max(
      document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
      desktop ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0,
    );
    const bottom = Math.min(
      document.querySelector('.desktop-dock').getBoundingClientRect().top,
      desktop ? content.getBoundingClientRect().bottom : innerHeight,
    );
    return {
      active: document.activeElement === element,
      top: r.top,
      bottom: r.bottom,
      focusTop: r.top - extent,
      focusBottom: r.bottom + extent,
      extent,
      clip: { top, bottom },
      raw: { x: scrollX, y: scrollY, content: content.scrollTop, frame: frame.scrollTop },
      rootTop: document.querySelector('.host-sensors').getBoundingClientRect().top,
    };
  });
}
function checkFocus(value) {
  assert.ok(value.active, 'Expected control retains focus');
  assert.ok(value.extent > 0, 'Focus has a painted outline');
  assert.ok(
    value.focusTop >= value.clip.top + 2.5 && value.focusBottom <= value.clip.bottom - 2.5,
    'Complete focus marker clears sticky chrome/dock',
  );
}

async function wheelVisible(page, selector) {
  for (let attempt = 0; attempt < 65; attempt++) {
    const value = await page.locator(selector).evaluate((element) => {
      const r = element.getBoundingClientRect();
      const frame = element.closest('.desktop-route-window');
      const desktop = frame.dataset.windowNavigation === 'desktop';
      const top =
        Math.max(
          document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
          desktop ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0,
        ) + 16;
      const bottom =
        Math.min(
          document.querySelector('.desktop-dock').getBoundingClientRect().top,
          desktop ? frame.querySelector('.desktop-window-content').getBoundingClientRect().bottom : innerHeight,
        ) - 16;
      return { top, bottom, targetTop: r.top, targetBottom: r.bottom, x: Math.min(innerWidth - 40, r.left + 40), y: Math.min(bottom - 30, top + 80) };
    });
    if (value.targetTop >= value.top && value.targetBottom <= value.bottom) return;
    const delta = value.targetTop < value.top ? value.targetTop - value.top : value.targetBottom - value.bottom;
    await page.mouse.move(value.x, value.y);
    await page.mouse.wheel(0, Math.max(-900, Math.min(900, delta)));
    await page.waitForTimeout(90);
  }
  throw new Error(`Native wheel could not reveal ${selector} within actual chrome bounds`);
}

async function palette(page) {
  return page.locator(rootSelector).evaluate((root) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (color) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const over = (a, b) => {
      const alpha = a[3] / 255;
      const behind = b[3] / 255;
      const combined = alpha + behind * (1 - alpha);
      return [...a.slice(0, 3).map((c, i) => (c * alpha + b[i] * behind * (1 - alpha)) / combined), combined * 255];
    };
    const luminance = (color) => {
      const v = color.slice(0, 3).map((c) => {
        const n = c / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      });
      return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
    };
    return [
      ['state', '.host-sensors-state', '--host-sensor-warning'],
      ['stale', '.host-sensors-stale', '--host-sensor-warning'],
      ['chip', '.host-sensor-chip', '--desktop-status-muted'],
      ['threshold', '.host-sensor-threshold', '--desktop-status-muted'],
      ['coverage', '.host-sensor-coverage', '--desktop-status-muted'],
      ['GPU label', '.host-gpu-facts dt', '--desktop-status-muted'],
      ['warning', '.host-sensor-reading[data-warning="true"]', '--host-sensor-warning'],
      ['about', '.host-sensors-about p', '--desktop-status-muted'],
    ].map(([family, selector, token]) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      root.append(probe);
      const expected = rgba(getComputedStyle(probe).color);
      probe.remove();
      return {
        family,
        token,
        labels: [...root.querySelectorAll(selector)].map((element) => {
          const foreground = rgba(getComputedStyle(element).color);
          const layers = [];
          for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            const s = getComputedStyle(ancestor);
            layers.push({ color: rgba(s.backgroundColor), image: s.backgroundImage });
          }
          const bounds = [0, 255].map((bound) => {
            let background = [bound, bound, bound, 255];
            for (const layer of layers.toReversed()) {
              background = over(layer.color, background);
              if (layer.image !== 'none') background = [bound, bound, bound, 255];
            }
            const painted = over(foreground, background);
            return {
              background,
              painted,
              ratio: (Math.max(luminance(painted), luminance(background)) + 0.05) / (Math.min(luminance(painted), luminance(background)) + 0.05),
            };
          });
          return { text: element.textContent, foreground, expected, layers, bounds, minimum: Math.min(...bounds.map((v) => v.ratio)) };
        }),
      };
    });
  });
}

module.exports = async function inspectHostSensors({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8080', 'Only isolated static8080 fixtures are permitted');
  const viewport = page.viewportSize();
  const scope = process.env.ORBIS_VISUAL_HOST_SENSORS_SCOPE || 'all';
  assert.ok(
    [
      'all',
      'early',
      'layouts',
      'palette',
      'states',
      'finish',
      'functional',
      'captures',
      'copy-proof',
      'fallback-negative',
      'fallback-proof',
    ].includes(scope),
  );
  const report = {
    passed: false,
    layouts: [],
    palette: [],
    states: [],
    retries: [],
    refresh: [],
    polling: [],
    requests: [],
    errors: [],
    mutations: [],
    preferencePuts: 0,
    cleanup: {},
    cleanupFailures: [],
    provenance: {
      controlledFixtures: true,
      scope,
      ordinaryWords: 'No arbitrary fractures; long identifiers require full DOM/title and actual CSS ellipsis',
      contrast: 'Conservative black/white wallpaper compositions through actual ancestor layers',
      poll: 'Actual existing30second query timer, no injected clock or invalidation',
    },
  };
  let shadow = structuredClone(preferences);
  let scenario = 'ready';
  let hold;
  const releases = [];
  const onError = (error) => report.errors.push({ name: error.name, message: error.message });
  page.on('pageerror', onError);
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/desktop-preferences') {
      if (request.method() === 'PUT') {
        shadow = request.postDataJSON();
        report.preferencePuts++;
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(shadow) });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    if (url.pathname !== endpoint) return route.fallback();
    const requested = scenario;
    report.requests.push({ scenario: requested, at: Date.now() });
    if (hold) {
      const gate = hold;
      hold = undefined;
      await gate;
    }
    return route.fulfill({
      status: requested === 'error' ? 500 : 200,
      contentType: 'application/json',
      body: JSON.stringify(requested === 'error' ? { message: 'Controlled sensor read rejection' } : fixture(requested)),
    });
  };
  await page.route('**/api/**', handler);
  const shot = (suffix) => capture(`host-sensors-${report.current}-${suffix}`, { scrollTop: false, fullPage: false });
  const visit = async (variant, width, mode, scale = 1, preset = 'ocean') => {
    await dom.restoreText(page);
    scenario = variant;
    report.current = `${width}-${mode}-text${scale}-${preset}-${variant}`;
    shadow = { ...structuredClone(preferences), preset, mode, windows: {} };
    await page.setViewportSize({ width, height: width === 1440 ? 1120 : width === 768 ? 1024 : width === 390 ? 844 : 800 });
    await page.goto(`${base}/monitor`, { waitUntil: 'domcontentloaded' });
    await page.locator(`.desktop[data-desktop-mode="${mode}"][data-desktop-preset="${preset}"] .host-sensors`).waitFor();
    if (variant === 'loading') await page.locator('.host-sensors > output').waitFor();
    else if (['error', 'missing', 'collecting'].includes(variant)) await page.locator('.host-sensors-notice').waitFor();
    else await page.waitForFunction(() => document.querySelector('.host-sensors-state')?.textContent !== 'Temperatures, fans and GPUs');
    await dom.settle(page);
    await dom.scaleText(page, scale);
  };
  const held = () => {
    let release;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    releases.push(release);
    return release;
  };
  try {
    if (scope === 'copy-proof') {
      report.copyProofs = [];
      await visit('error', 390, 'dark', 1, 'frost');
      await wheelVisible(page, rootSelector);
      assert.equal(await page.locator('.host-sensor-card').count(), 0);
      assert.equal(await page.locator('.host-sensors-notice p').textContent(), 'Hardware readings could not be refreshed.');
      report.copyProofs.push({ phase: 'initial500', metrics: await inspect(page), text: await page.locator(rootSelector).innerText() });
      await shot('initial500-copy');

      await visit('ready', 1440, 'light');
      await page.getByRole('button', { name: 'Minimize Monitor', exact: true }).click();
      await page.locator('.desktop-route-window').waitFor({ state: 'hidden' });
      scenario = 'error';
      await page.getByRole('button', { name: 'Restore Monitor', exact: true }).click();
      await page.locator(retrySelector).waitFor();
      const retry = page.locator(retrySelector);
      await retry.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      const response = page.waitForResponse((value) => new URL(value.url()).pathname === endpoint && value.status() === 500);
      await page.keyboard.press('Enter');
      await response;
      await page.waitForFunction(() => Boolean(document.querySelector('.host-sensors-notice button:not(:disabled)')));
      const focus = await focusSnapshot(page, retrySelector);
      checkFocus(focus);
      await verifyValues(page, 'ready');
      assert.equal(await page.locator('.host-sensors-notice p').textContent(), 'Hardware readings could not be refreshed.');
      const text = await page.locator(rootSelector).innerText();
      assert.equal((text.match(/values may be stale/gi) || []).length, 1, 'Stale explanation is shown only once beside its last-sample timestamp');
      const notice = await page.locator('.host-sensors-notice').evaluate((element) => {
        const box = (target) => {
          const r = target.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
        };
        const range = document.createRange();
        range.selectNodeContents(element.querySelector('p'));
        return { box: box(element), paragraph: box(element.querySelector('p')), lines: [...range.getClientRects()].length };
      });
      report.copyProofs.push({ phase: 'cached500-retry', focus, notice, metrics: await inspect(page), text });
      assert.equal(notice.lines, 1, 'Desktop error notice remains one line after the copy change');
      await shot('cached500-copy');
    }
    if (scope === 'captures') {
      report.captureProofs = [];
      for (const variant of ['ready', 'empty', 'failed-empty', 'error', 'loading']) {
        let release;
        if (variant === 'loading') release = held();
        await visit(variant, variant === 'ready' ? 320 : 390, variant === 'loading' ? 'light' : 'dark', variant === 'ready' ? 2 : 1, 'frost');
        if (variant === 'ready') await dom.wheelTo(page, '.host-sensors-heading');
        else await wheelVisible(page, rootSelector);
        const metrics = await inspect(page);
        report.captureProofs.push({ variant, metrics, text: await page.locator(rootSelector).innerText() });
        await shot('reading-capture');
        if (release) {
          release();
          await page.locator('.host-sensor-card').first().waitFor();
        }
      }
    }
    if (['fallback-negative', 'fallback-proof'].includes(scope)) {
      await visit('ready', 320, 'dark', 2);
      const selector = `[data-sensor-id="${id('gpu', 4)}"]`;
      await wheelVisible(page, `${selector} .host-sensor-chip`);
      report.fallback = await page.locator(`${selector} .host-sensor-chip`).evaluate((element) => {
        const card = element.closest('.host-sensor-card');
        const rect = (target) => {
          const value = target.getBoundingClientRect();
          return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width, height: value.height };
        };
        const style = getComputedStyle(element);
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          text: element.textContent,
          title: element.title,
          box: rect(element),
          card: rect(card),
          cardPadding: getComputedStyle(card).padding,
          font: style.fontSize,
          lineHeight: style.lineHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          overflow: style.overflowX,
          whiteSpace: style.whiteSpace,
          textOverflow: style.textOverflow,
          ink: [...range.getClientRects()].map((value) => ({ left: value.left, right: value.right, top: value.top, bottom: value.bottom })),
        };
      });
      await shot(`last-gpu-${scope}`);
      check(await inspect(page));
    }
    if (['all', 'early', 'layouts'].includes(scope)) {
      const groups = [
        { width: 1440, mode: 'light', scale: 1 },
        { width: 320, mode: 'dark', scale: 2 },
        { width: 1440, mode: 'dark', scale: 1 },
        { width: 320, mode: 'light', scale: 2 },
        ...[768, 390, 320].flatMap((width) => ['light', 'dark'].map((mode) => ({ width, mode, scale: 1 }))),
      ];
      for (const group of scope === 'early' ? groups.slice(0, 2) : groups) {
        await visit('ready', group.width, group.mode, group.scale);
        await verifyValues(page, 'ready');
        await wheelVisible(page, '.host-sensors-heading');
        const metrics = await inspect(page);
        report.layouts.push({ ...group, metrics, passed: false });
        await shot('heading');
        check(metrics);
        await dom.wheelTo(page, '.host-sensor-groups > section:last-child');
        await shot('gpus');
        const summary = page.locator(aboutSelector);
        await wheelVisible(page, aboutSelector);
        await summary.locator('span').click();
        assert.equal(await summary.locator('..').getAttribute('open'), '');
        await page.keyboard.press('Space');
        assert.equal(await summary.locator('..').getAttribute('open'), null);
        checkFocus(await focusSnapshot(page, aboutSelector));
        const aboutGeometry = await summary.evaluate((element) => {
          const box = (target) => {
            const r = target.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          };
          const range = document.createRange();
          range.selectNodeContents(element.querySelector('span'));
          return {
            box: box(element),
            glyph: box(element.querySelector('svg')),
            lines: [...range.getClientRects()].map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
            padding: [
              getComputedStyle(element).paddingTop,
              getComputedStyle(element).paddingRight,
              getComputedStyle(element).paddingBottom,
              getComputedStyle(element).paddingLeft,
            ].map(Number.parseFloat),
          };
        });
        assert.ok(aboutGeometry.padding[0] >= 8 && aboutGeometry.padding[2] >= 8 && aboutGeometry.padding[1] >= 12 && aboutGeometry.padding[3] >= 12);
        for (const line of aboutGeometry.lines) {
          assert.ok(Math.abs(line.left - aboutGeometry.lines[0].left) <= 0.5, 'Wrapped About lines share a left edge');
          assert.ok(
            line.left >= aboutGeometry.glyph.right + 8 && line.right <= aboutGeometry.box.right - 12,
            'About label has glyph and edge clearance',
          );
        }
        report.layouts.at(-1).aboutGeometry = aboutGeometry;
        report.layouts.at(-1).aboutNativeToggle = true;
        report.layouts.at(-1).passed = true;
        await shot('about-focused');
      }
    }
    if (['all', 'palette', 'finish'].includes(scope))
      for (const preset of ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'])
        for (const mode of ['light', 'dark']) {
          await visit('stale', 1440, mode, 1, preset);
          await page.locator(aboutSelector).click();
          await wheelVisible(page, '.host-sensors-heading');
          const samples = await palette(page);
          report.palette.push({ preset, mode, samples, passed: false });
          await shot('palette');
          for (const family of samples) {
            assert.ok(family.labels.length, `Palette family ${family.family} is painted`);
            for (const label of family.labels) {
              assert.deepEqual(label.foreground, label.expected, `${family.family} uses its active token`);
              assert.ok(label.minimum >= 4.5, `${family.family} contrast ${label.minimum} must reach4.5`);
            }
          }
          report.palette.at(-1).passed = true;
        }
    if (scope === 'finish') {
      await visit('ready', 320, 'dark', 2, 'frost');
      await verifyValues(page, 'ready');
      await wheelVisible(page, '.host-sensors-heading');
      report.colorOnlyLayoutProof = await inspect(page);
      await shot('color-only-layout-proof');
      check(report.colorOnlyLayoutProof);
      await wheelVisible(page, '.host-sensor-chip[data-fallback="true"]');
      await shot('fallback-wrapped');
    }
    if (['all', 'states', 'finish', 'functional'].includes(scope)) {
      for (const variant of scope === 'functional'
        ? ['error']
        : ['missing', 'collecting', 'empty', 'failed-empty', 'limited-empty', 'partial', 'stale', 'error']) {
        await visit(variant, 390, 'dark');
        await wheelVisible(page, '.host-sensors-heading');
        const metrics = await inspect(page);
        report.states.push({ variant, metrics, passed: false });
        await shot('state');
        check(metrics);
        if (variant === 'empty') assert.match(await page.locator(rootSelector).innerText(), /exposes no temperature sensors, fans or GPUs/);
        if (['failed-empty', 'limited-empty'].includes(variant))
          assert.doesNotMatch(
            await page.locator(rootSelector).innerText(),
            /exposes no temperature sensors, fans or GPUs/,
            'Incomplete scans must not claim hardware absence',
          );
        if (variant === 'failed-empty')
          assert.doesNotMatch(
            await page.locator(rootSelector).innerText(),
            /No (temperature sensors|fan sensors|GPUs) exposed/,
            'A failed group must not claim no exposed hardware',
          );
        if (variant === 'error') {
          assert.equal(await page.locator('.host-sensor-card').count(), 0, 'Rejected initial request must not invent numeric readings');
          assert.equal(await page.locator('.host-sensors-notice').getAttribute('role'), 'alert');
        } else if (fixture(variant).available) await verifyValues(page, variant);
        report.states.at(-1).passed = true;
      }
      scenario = 'ready';
      let release = held();
      await visit('loading', 390, 'light');
      report.states.push({ variant: 'loading', text: await page.locator('.host-sensors > output').textContent(), passed: true });
      await wheelVisible(page, '.host-sensors-heading');
      await shot('loading');
      release();
      await page.locator('.host-sensor-card').first().waitFor();
      await visit('collecting', 390, 'dark');
      const at = report.requests.at(-1).at;
      scenario = 'ready';
      await page.locator('.host-sensor-card').first().waitFor({ timeout: 5500 });
      report.warm = { interval: report.requests.at(-1).at - at };
      assert.ok(report.warm.interval >= 1500 && report.warm.interval <= 5000);

      await visit('ready', 1440, 'light');
      await page.locator(aboutSelector).focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      const before = await focusSnapshot(page, aboutSelector);
      checkFocus(before);
      const initial = report.requests.at(-1).at;
      scenario = 'error';
      await page.locator(retrySelector).waitFor({ timeout: 37000 });
      await page.locator(retrySelector).waitFor({ state: 'visible' });
      await dom.settle(page);
      const after = await focusSnapshot(page, aboutSelector);
      report.refresh.push({ before, after, interval: report.requests.find((r) => r.at > initial && r.scenario === 'error').at - initial });
      await shot('cached-poll-error');
      checkFocus(after);
      assert.ok(Math.abs(after.top - before.top) <= 1, 'Actual30second refresh preserves the viewport anchor');
      assert.ok(report.refresh[0].interval >= 29000 && report.refresh[0].interval <= 36000);
      await verifyValues(page, 'ready');
      const retry = page.locator(retrySelector);
      await retry.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      checkFocus(await focusSnapshot(page, retrySelector));
      release = held();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.host-sensors-notice button')?.disabled);
      await verifyValues(page, 'ready');
      release();
      await page.waitForFunction(
        () => {
          const button = document.querySelector('.host-sensors-notice button');
          return button && !button.disabled;
        },
        {},
        { timeout: 15000 },
      );
      const rejected = await focusSnapshot(page, retrySelector);
      report.retries.push({ phase: 'cached-rejected', focus: rejected });
      checkFocus(rejected);
      await shot('cached-retry-rejected');
      scenario = 'ready';
      await page.keyboard.press('Enter');
      await page.locator('.host-sensors-notice').waitFor({ state: 'hidden' });
      await dom.settle(page);
      const recovered = await focusSnapshot(page, '#host-sensors-title');
      report.retries.push({ phase: 'cached-recovered', focus: recovered });
      await shot('retry-recovered');
      checkFocus(recovered);
      await visit('missing', 390, 'dark');
      await page.locator(retrySelector).focus();
      scenario = 'ready';
      release = held();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.host-sensors-notice button')?.disabled);
      await page.locator(aboutSelector).focus();
      release();
      await page.locator('.host-sensors-notice').waitFor({ state: 'hidden' });
      const moved = await focusSnapshot(page, aboutSelector);
      report.retries.push({ phase: 'moved-away', focus: moved });
      checkFocus(moved);
      await visit('ready', 1440, 'dark');
      await page.getByRole('button', { name: 'Minimize Monitor', exact: true }).click();
      await page.locator('.desktop-route-window').waitFor({ state: 'hidden' });
      let count = report.requests.length;
      await page.waitForTimeout(31000);
      assert.equal(report.requests.length, count, 'Minimized sensor polling stops');
      report.polling.push({ kind: 'minimized', duration: 31000, reads: 0 });
      await page.getByRole('button', { name: 'Restore Monitor', exact: true }).click();
      await page.locator('.desktop-route-window').waitFor({ state: 'visible' });
      await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
      count = report.requests.length;
      await page.waitForTimeout(31000);
      assert.equal(report.requests.length, count, 'Hidden-route sensor polling stops');
      report.polling.push({ kind: 'hidden-route', duration: 31000, reads: 0 });
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    report.passed = true;
  } catch (error) {
    report.failure = { phase: report.current, name: error.name, message: error.message };
    await shot('FAILED').catch((error) => {
      report.captureFailure = error.message;
    });
  } finally {
    for (const release of releases) release();
    for (const [name, operation] of [
      ['textRestored', () => dom.restoreText(page)],
      ['routesRestored', () => page.unroute('**/api/**', handler)],
      [
        'listenersRestored',
        async () => {
          page.off('pageerror', onError);
          assert.equal(page.listeners('pageerror').includes(onError), false);
        },
      ],
      ['viewportRestored', () => page.setViewportSize(viewport)],
    ]) {
      try {
        await operation();
        report.cleanup[name] = true;
      } catch (error) {
        report.cleanup[name] = false;
        report.cleanupFailures.push({ operation: name, name: error.name, message: error.message });
        report.passed = false;
      }
    }
  }
  return report;
};
module.exports.fixture = fixture;
module.exports.dom = { inspect, check };
