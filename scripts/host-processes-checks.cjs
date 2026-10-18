const assert = require('node:assert/strict');
const { dom } = require('./host-devices-checks.cjs');

const endpoint = '/api/system/host-processes';
const fixture = (variant = 'ready') => {
  if (variant === 'missing') return { available: false, reason: 'The Orbis host service is not connected. Check the host service and try again.' };
  if (variant === 'collecting') return { available: false, reason: 'Collecting process readings.' };
  const rows = [
    {
      pid: 10,
      name: 'media-transcoding-worker-production-secondary-archive-0123456789',
      cpuPercent: 12500.5,
      memoryBytes: Number.MAX_SAFE_INTEGER,
    },
    { pid: 11, name: 'backup-verification', cpuPercent: 12500.5, memoryBytes: 16 * 1024 ** 3 },
    { pid: 2147483647, name: 'postgres-database', cpuPercent: 207.6, memoryBytes: 64 * 1024 ** 3 },
    { pid: 22, name: 'archive-indexer', cpuPercent: 95.6, memoryBytes: 1.5 * 1024 ** 4 },
    { pid: 7, name: 'systemd', cpuPercent: 0, memoryBytes: 32 * 1024 ** 2 },
    { pid: 8, name: 'idle-worker', cpuPercent: 0, memoryBytes: 0 },
    { pid: 30, name: 'jellyfin-Διαχείριση', cpuPercent: 12.3, memoryBytes: 2 * 1024 ** 3 },
    { pid: 31, name: 'application-server', cpuPercent: 5.1, memoryBytes: 48 * 1024 ** 3 },
  ];
  if (['limited', 'growth'].includes(variant))
    for (let index = 0; index < 12; index++)
      rows.push({ pid: 100 + index, name: `storage-worker-${index}`, cpuPercent: index, memoryBytes: index * 1024 ** 3 });
  if (variant === 'first-cpu') for (const row of rows) row.cpuPercent = null;
  if (['refreshed', 'growth'].includes(variant)) {
    rows[3].cpuPercent = 15000.2;
    rows[4].memoryBytes = Number.MAX_SAFE_INTEGER;
  }
  if (variant === 'empty') rows.length = 0;
  const byCpu = rows.filter((row) => row.cpuPercent !== null).toSorted((a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid);
  const byMemory = rows.toSorted((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid);
  return {
    available: true,
    sampledAt: new Date(Date.now() - (variant === 'stale' ? 45000 : 0)).toISOString(),
    stale: variant === 'stale',
    scanned: variant === 'limited' ? 8192 : rows.length + (variant === 'unreadable' ? 3 : 0),
    readable: variant === 'limited' ? 8190 : rows.length,
    unreadable: variant === 'limited' ? 2 : variant === 'unreadable' ? 3 : 0,
    compared: variant === 'first-cpu' ? 0 : variant === 'limited' ? 8190 : rows.length,
    limited: variant === 'limited',
    byCpu,
    byMemory,
  };
};

const bytes = (value) => {
  const index = Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
};

async function wheelToHeading(page) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const geometry = await page.locator('.host-processes-heading').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const frame = element.closest('.desktop-route-window');
      const desktop = frame.dataset.windowNavigation === 'desktop';
      const dock = document.querySelector('.desktop-dock').getBoundingClientRect();
      const top = Math.max(
        document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
        desktop ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0,
      );
      const bottom = Math.min(dock.top, desktop ? frame.querySelector('.desktop-window-content').getBoundingClientRect().bottom : innerHeight);
      return {
        top,
        bottom,
        targetTop: rect.top,
        targetBottom: rect.bottom,
        x: Math.min(innerWidth - 50, rect.left + 70),
        y: Math.min(bottom - 40, top + 100),
      };
    });
    if (geometry.targetTop >= geometry.top + 16 && geometry.targetBottom <= geometry.bottom - 16) return;
    await page.mouse.move(geometry.x, geometry.y);
    await page.mouse.wheel(0, Math.max(-900, Math.min(900, geometry.targetTop - geometry.top - 24)));
    await page.waitForTimeout(100);
  }
  throw new Error('Host-process heading could not be revealed with natural wheel scrolling');
}

async function wheelToLastText(page, selector) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const geometry = await page.locator(selector).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const dock = document.querySelector('.desktop-dock').getBoundingClientRect();
      const frame = element.closest('.desktop-route-window');
      const desktop = frame.dataset.windowNavigation === 'desktop';
      const top = Math.max(
        document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
        desktop ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0,
      );
      const bottom = Math.min(dock.top, desktop ? frame.querySelector('.desktop-window-content').getBoundingClientRect().bottom : innerHeight);
      const range = document.createRange();
      range.selectNodeContents(element);
      const ink = [...range.getClientRects()]
        .filter((entry) => entry.width > 0)
        .map((entry) => ({ top: entry.top, bottom: entry.bottom, left: entry.left, right: entry.right }));
      return {
        bottom: rect.bottom,
        visibleBottom: bottom,
        visibleTop: top,
        ink,
        x: Math.min(innerWidth - 50, rect.left + 70),
        y: Math.min(dock.top - 40, top + 100),
      };
    });
    if (geometry.bottom <= geometry.visibleBottom - 16) {
      assert.ok(
        geometry.ink.every((entry) => entry.bottom <= geometry.visibleBottom - 16),
        'Final paragraph ink has16px clearance above the dock or clipped content bottom',
      );
      return geometry;
    }
    await page.mouse.move(geometry.x, geometry.y);
    await page.mouse.wheel(0, Math.min(900, geometry.bottom - geometry.visibleBottom + 20));
    await page.waitForTimeout(100);
  }
  throw new Error('Final explanatory text did not clear the dock after native wheel');
}

async function inspect(page) {
  return page.locator('.host-processes').evaluate((root) => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const ink = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()]
        .filter((rect) => rect.width > 0)
        .map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
    };
    const style = getComputedStyle(root);
    const inner = {
      left: box(root).left + Number.parseFloat(style.paddingLeft) + 1,
      right: box(root).right - Number.parseFloat(style.paddingRight) - 1,
    };
    const words = [];
    const overflowInk = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement.getClientRects().length || node.parentElement.closest('svg,[aria-hidden=true],legend,.host-process-identity strong'))
        continue;
      for (const match of node.textContent.matchAll(/[A-Za-z][A-Za-z'-]{2,}/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
        if (new Set(rects.map((rect) => Math.round(rect.top))).size > 1) words.push({ text: match[0], context: node.parentElement.textContent });
        for (const rect of rects)
          if (rect.left < inner.left - 1 || rect.right > inner.right + 1) overflowInk.push({ text: match[0], left: rect.left, right: rect.right });
      }
    }
    const chrome = (element) => {
      const value = getComputedStyle(element);
      return {
        background: value.backgroundColor,
        blur: value.backdropFilter,
        shadow: value.boxShadow,
        borders: [value.borderTopColor, value.borderRightColor, value.borderBottomColor, value.borderLeftColor],
      };
    };
    const frame = root.closest('.desktop-route-window');
    const peer = root.closest('.desktop-monitor').querySelector('.container-resources h2');
    return {
      width: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      root: box(root),
      monitor: box(root.closest('.desktop-monitor')),
      inner,
      padding: [Number.parseFloat(style.paddingLeft), Number.parseFloat(style.paddingRight)],
      compactPanelPadding: Number.parseFloat(style.getPropertyValue('--orbis-compact-panel-space')),
      heading: box(root.querySelector('h2')),
      peerHeading: peer ? box(peer) : null,
      words,
      overflowInk,
      buttons: [...root.querySelectorAll('.host-processes-sort button')].map((button) => ({
        text: button.textContent,
        box: box(button),
        ink: ink(button),
        padding: [getComputedStyle(button).paddingLeft, getComputedStyle(button).paddingRight],
      })),
      rows: [...root.querySelectorAll('.host-process-list > li')].map((row) => {
        const strong = row.querySelector('strong');
        const nameStyle = getComputedStyle(strong);
        return {
          pid: Number(row.dataset.processPid),
          box: box(row),
          name: {
            text: strong.textContent,
            title: strong.title,
            bdi: Boolean(strong.querySelector('bdi')),
            box: box(strong),
            ellipsis: strong.scrollWidth > strong.clientWidth + 1,
            overflow: nameStyle.overflowX,
            whiteSpace: nameStyle.whiteSpace,
            textOverflow: nameStyle.textOverflow,
          },
          facts: [...row.querySelectorAll('.host-process-values > div')].map((fact) => ({
            label: fact.querySelector('dt').textContent,
            text: fact.querySelector('dd').textContent,
            box: box(fact),
            labelInk: ink(fact.querySelector('dt')),
            valueInk: ink(fact.querySelector('dd')),
            overflow: fact.querySelector('dd').scrollWidth > fact.querySelector('dd').clientWidth + 1,
          })),
        };
      }),
      notice: root.querySelector('.host-processes-notice')?.textContent,
      chrome: {
        bar: chrome(document.querySelector('.desktop-system-bar')),
        dock: chrome(document.querySelector('.desktop-dock')),
        frame: chrome(frame),
        header: chrome(frame.querySelector('.desktop-window-bar')),
        navigation: frame.dataset.windowNavigation,
      },
    };
  });
}

function check(metrics) {
  const near = (a, b, message) => assert.ok(Math.abs(a - b) <= 1, `${message}: ${a} vs ${b}`);
  assert.ok(metrics.documentWidth <= metrics.width + 1, 'No process-caused document overflow');
  assert.deepEqual(metrics.words, [], 'Ordinary words must wrap whole');
  assert.deepEqual(metrics.overflowInk, [], 'Text must clear the actual card content edges');
  near(metrics.root.left, metrics.monitor.left, 'Processes share the Monitor left edge');
  near(metrics.root.right, metrics.monitor.right, 'Processes share the Monitor right edge');
  near(metrics.heading.left, metrics.inner.left, 'Title and rows share the padded content edge');
  if (metrics.peerHeading) near(metrics.heading.left, metrics.peerHeading.left, 'Process and Docker title gutters align');
  const minimumPadding = Number.isFinite(metrics.compactPanelPadding) ? Math.max(16, metrics.compactPanelPadding) : 18;
  assert.ok(
    metrics.padding.every((padding) => padding >= minimumPadding),
    'Card text retains its configured compact or legacy interior padding',
  );
  near(metrics.buttons[0].box.height, metrics.buttons[1].box.height, 'Rank controls have equal heights');
  if (Math.abs(metrics.buttons[0].box.top - metrics.buttons[1].box.top) < metrics.buttons[0].box.height)
    near(metrics.buttons[0].box.top, metrics.buttons[1].box.top, 'Rank controls sharing a row align');
  for (const button of metrics.buttons)
    for (const rect of button.ink)
      assert.ok(rect.left >= button.box.left + 8 && rect.right <= button.box.right - 8, 'Sort text has interior breathing room');
  for (const row of metrics.rows) {
    near(row.box.left, metrics.inner.left, 'Rows share the title gutter');
    near(row.box.right, metrics.inner.right, 'Rows fill the shared right gutter');
    assert.equal(row.name.title, row.name.text);
    assert.ok(row.name.bdi, 'Names preserve bidirectional isolation');
    if (row.name.ellipsis)
      assert.ok(
        row.name.overflow === 'hidden' && row.name.whiteSpace === 'nowrap' && row.name.textOverflow === 'ellipsis',
        'Long names use deliberate accessible ellipsis',
      );
    for (const fact of row.facts) {
      assert.equal(fact.overflow, false, 'Complete resource values fit their cell');
      assert.ok(new Set(fact.valueInk.map((rect) => Math.round(rect.top))).size <= 1, 'Numeric values and units stay together');
      for (const rect of [...fact.labelInk, ...fact.valueInk])
        assert.ok(
          rect.left >= metrics.inner.left - 1 && rect.right <= metrics.inner.right + 1 && rect.right <= fact.box.right + 1,
          'Fact ink retains edge/column clearance',
        );
      assert.ok(
        Math.min(...fact.valueInk.map((rect) => rect.top)) - Math.max(...fact.labelInk.map((rect) => rect.bottom)) >= 4,
        'Fact labels and values have breathing room',
      );
    }
  }
  for (const chrome of [metrics.chrome.bar, metrics.chrome.dock]) {
    assert.equal(chrome.blur, 'blur(28px) saturate(1.45)');
    assert.ok(chrome.background.startsWith('rgba(') && !chrome.background.endsWith(', 1)'), 'Glass remains translucent');
    assert.ok(chrome.borders.every((color) => color === 'rgba(0, 0, 0, 0)') && !chrome.shadow.includes('inset'), 'No white chrome rims');
  }
  if (metrics.chrome.navigation === 'desktop') {
    assert.equal(metrics.chrome.header.blur, metrics.chrome.dock.blur);
    assert.equal(metrics.chrome.frame.background, 'rgba(0, 0, 0, 0)');
    assert.ok(metrics.chrome.frame.borders.every((color) => color === 'rgba(0, 0, 0, 0)') && !metrics.chrome.frame.shadow.includes('inset'));
  }
}

async function cleanup(report, page, handler, onError, viewport) {
  report.cleanup = {};
  report.cleanupFailures = [];
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
    report.cleanup[name] = false;
    try {
      await operation();
      report.cleanup[name] = true;
    } catch (error) {
      report.cleanupFailures.push({ operation: name, name: error.name, message: error.message });
      report.passed = false;
    }
  }
}

async function createSession({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8080', 'Only isolated static8080 fixtures permitted');
  const viewport = page.viewportSize();
  const report = {
    passed: false,
    layouts: [],
    states: [],
    retries: [],
    warm: [],
    refresh: [],
    growth: [],
    polling: [],
    requests: [],
    preferencePuts: 0,
    mutations: [],
    errors: [],
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
      report.mutations.push({ path: url.pathname, method: request.method() });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/system/telemetry' && scenario === 'core-missing')
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    if (url.pathname !== endpoint) return route.fallback();
    const requested = scenario;
    report.requests.push({ scenario: requested, at: Date.now() });
    if (hold) {
      const gate = hold;
      hold = undefined;
      await gate;
    }
    return route.fulfill({
      status: requested === 'error' ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(requested === 'error' ? { message: 'Controlled process read failure' } : fixture(requested)),
    });
  };
  await page.route('**/api/**', handler);
  const shot = (name) => capture(`host-processes-${name}`, { scrollTop: false, fullPage: false });
  const visit = async (variant, width, mode, scale, preset = 'ocean') => {
    scenario = variant;
    report.current = `${width}-${mode}-text${scale}-${preset}-${variant}`;
    shadow = { ...structuredClone(preferences), mode, preset, windows: {} };
    await page.setViewportSize({ width, height: width === 1440 ? 1120 : width === 768 ? 1024 : width === 390 ? 844 : 800 });
    await page.goto(`${base}/monitor`, { waitUntil: 'domcontentloaded' });
    await page.locator(`.desktop[data-desktop-mode="${mode}"][data-desktop-preset="${preset}"] .host-processes`).waitFor();
    await page.waitForFunction(() => {
      const root = document.querySelector('.host-processes');
      return root && ![...root.querySelectorAll('output')].some((element) => element.textContent.includes('Loading host processes'));
    });
    if (['error', 'missing', 'collecting'].includes(variant)) await page.locator('.host-processes-notice').waitFor();
    else await page.locator('.host-process-list').waitFor({ state: 'attached' });
    await dom.settle(page);
    await dom.scaleText(page, scale);
  };
  const verify = async (variant, sort) => {
    const value = fixture(variant);
    const rows = sort === 'cpuPercent' ? value.byCpu : value.byMemory;
    assert.deepEqual(
      await page.locator('.host-process-list > li').evaluateAll((elements) => elements.map((element) => Number(element.dataset.processPid))),
      rows.map((row) => row.pid),
      'Exact metric/PID order',
    );
    assert.deepEqual(
      await page.locator('.host-process-identity strong').allTextContents(),
      rows.map((row) => row.name),
      'Full names remain in the DOM',
    );
    assert.deepEqual(
      await page.locator('.host-process-values dd').allTextContents(),
      rows.flatMap((row) => [row.cpuPercent === null ? 'Pending' : `${row.cpuPercent.toFixed(1)}%`, bytes(row.memoryBytes)]),
      'Complete multicore CPU/RSS values',
    );
  };
  const measure = async () => {
    const metrics = await inspect(page);
    report.pending = metrics;
    check(metrics);
    delete report.pending;
    return metrics;
  };
  const finish = async () => {
    for (const release of releases) release();
    await cleanup(report, page, handler, onError, viewport);
  };
  const failure = async (error) => {
    report.failure = { name: error.name, message: error.message };
    await shot(`${report.current}-FAILED`).catch((captureError) => {
      report.captureFailure = captureError.message;
    });
  };
  return {
    page,
    report,
    visit,
    verify,
    measure,
    shot,
    finish,
    failure,
    releases,
    setScenario: (value) => {
      scenario = value;
    },
    setHold: (value) => {
      hold = value;
    },
  };
}

module.exports = async function inspectHostProcesses({
  page,
  base,
  preferences,
  capture,
  widths = [1440, 768, 390, 320],
  modes = ['light', 'dark'],
  textScales = [1, 2],
  stateGroups = [
    { width: 1440, mode: 'light', scale: 1 },
    { width: 768, mode: 'dark', scale: 2 },
    { width: 390, mode: 'dark', scale: 1 },
    { width: 320, mode: 'light', scale: 2 },
    { width: 320, mode: 'dark', scale: 2 },
  ],
  interactions = true,
  onlyAbout = false,
}) {
  const session = await createSession({ page, base, preferences, capture });
  const { report, visit, verify, measure, shot, setScenario, setHold, releases } = session;
  const sortButton = (name) => page.getByRole('group', { name: 'Rank host processes by' }).getByRole('button', { name, exact: true });
  const focusClear = async () => {
    const metrics = await dom.focusMetrics(page);
    report.pendingFocus = metrics;
    assert.ok(metrics.top >= metrics.chromeBottom + 3 && metrics.bottom <= metrics.dockTop - 3, 'Entire native focus marker clears sticky chrome');
    assert.ok(!metrics.outline.startsWith('0px') || metrics.shadow !== 'none', 'Native focus has a visible marker');
    return metrics;
  };
  try {
    report.scope = onlyAbout
      ? 'About paragraph capture clearance only'
      : widths.length
        ? 'Host process layout and interactions'
        : 'Host process state, focus and polling only';
    report.provenance = {
      preview: base,
      controlledFixtures: true,
      widths,
      modes,
      textScales,
      stateGroups,
      interactions,
      build: process.env.ORBIS_VISUAL_HOST_PROCESS_BUILD || 'compiled source',
    };
    for (const width of widths)
      for (const mode of modes)
        for (const scale of textScales) {
          await visit('ready', width, mode, scale);
          if (onlyAbout) {
            await page.locator('.host-processes-about summary').focus();
            await page.keyboard.press('Enter');
            const about = await measure();
            const aboutInk = await wheelToLastText(page, '.host-processes-about p:last-child');
            await shot(`${report.current}-about-copy`);
            report.layouts.push({ width, mode, scale, about, aboutInk, passed: true });
            continue;
          }
          await verify('ready', 'cpuPercent');
          await wheelToHeading(page);
          await shot(`${report.current}-cpu`);
          const cpu = await measure();
          await sortButton('CPU').focus();
          await page.keyboard.press('Tab');
          assert.equal(await sortButton('Memory').evaluate((element) => element === document.activeElement), true);
          const focus = await focusClear();
          await page.keyboard.press('Space');
          await page.waitForFunction(() => document.querySelectorAll('.host-processes-sort button')[1].getAttribute('aria-pressed') === 'true');
          await verify('ready', 'memoryBytes');
          const memory = await measure();
          await shot(`${report.current}-memory`);
          await dom.wheelTo(page, '.host-process-list > li:first-child');
          await shot(`${report.current}-values`);
          await page.keyboard.press('Shift+Tab');
          assert.equal(await sortButton('CPU').evaluate((element) => element === document.activeElement), true);
          await page.keyboard.press('Enter');
          await verify('ready', 'cpuPercent');
          await page.locator('.host-processes-about summary').focus();
          await page.keyboard.press('Enter');
          assert.equal(await page.locator('.host-processes-about').getAttribute('open'), '');
          const about = await measure();
          await shot(`${report.current}-about`);
          const aboutInk = await wheelToLastText(page, '.host-processes-about p:last-child');
          await shot(`${report.current}-about-copy`);
          report.layouts.push({ width, mode, scale, cpu, memory, about, aboutInk, focus, reading: await dom.reading(page), passed: true });
          delete report.pendingFocus;
        }
    if (interactions) {
      for (const group of stateGroups) {
        for (const variant of ['missing', 'collecting', 'error', 'stale', 'limited', 'unreadable', 'empty', 'first-cpu']) {
          await visit(variant, group.width, group.mode, group.scale);
          await wheelToHeading(page);
          if (!['missing', 'collecting', 'error'].includes(variant)) await verify(variant, 'cpuPercent');
          const state = { ...group, variant, metrics: await measure(), passed: true };
          if (variant === 'first-cpu') {
            await page.getByText('Collecting CPU comparisons… Select Memory to see current readings.', { exact: true }).waitFor();
            await sortButton('Memory').click();
            await verify('first-cpu', 'memoryBytes');
            state.memory = await measure();
          }
          if (variant === 'stale') await page.locator('.host-processes-stale time').waitFor();
          if (variant === 'empty') await page.getByText('No readable host processes.', { exact: true }).waitFor();
          if (variant === 'limited') assert.match(await page.locator('.host-processes-coverage').first().textContent(), /8,192/);
          if (['missing', 'error'].includes(variant)) {
            const retry = page.locator('.host-processes-notice button');
            await retry.focus();
            await page.keyboard.press('Shift+Tab');
            await page.keyboard.press('Tab');
            assert.equal(await retry.evaluate((element) => element === document.activeElement), true);
            state.nativeFocus = await focusClear();
            await shot(`${report.current}-retry-focused`);
            if (variant === 'error') {
              const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.status() === 503);
              void rejected.catch(() => undefined);
              await page.keyboard.press('Enter');
              await rejected;
              await page.waitForFunction(() => {
                const button = document.querySelector('.host-processes-notice button');
                return button && !button.disabled;
              });
              await dom.settle(page);
              assert.equal(await retry.evaluate((element) => element === document.activeElement), true);
              state.rejectedFocus = await focusClear();
              await shot(`${report.current}-retry-rejected`);
            }
            const before = await dom.reading(page);
            setScenario('ready');
            let release;
            setHold(
              new Promise((resolve) => {
                release = resolve;
              }),
            );
            releases.push(release);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => {
              const root = document.querySelector('.host-processes');
              return (
                Boolean(root.querySelector('button:disabled')) ||
                [...root.querySelectorAll('output')].some((element) => element.textContent.includes('Loading host processes'))
              );
            });
            state.pending = await page.locator('.host-processes').textContent();
            await shot(`${report.current}-retry-pending`);
            release();
            await page.locator('.host-processes-notice').waitFor({ state: 'hidden' });
            await verify('ready', 'cpuPercent');
            await dom.settle(page);
            assert.equal(
              await page.locator('#host-processes-title').evaluate((element) => element === document.activeElement),
              true,
              'Successful Retry restores surviving heading',
            );
            state.successFocus = await focusClear();
            state.before = before;
            state.after = await dom.reading(page);
            report.retries.push({
              ...group,
              variant,
              pending: true,
              rejected: variant === 'error',
              before,
              after: state.after,
              focus: state.successFocus,
            });
          }
          await shot(`${report.current}-state`);
          report.states.push(state);
        }
        for (const variant of ['collecting', 'first-cpu']) {
          await visit(variant, group.width, group.mode, group.scale);
          const initial = report.requests.at(-1).at;
          setScenario('ready');
          await page.waitForFunction(() => document.querySelectorAll('.host-process-list > li').length === 8, null, { timeout: 5500 });
          const interval = report.requests.at(-1).at - initial;
          assert.ok(interval >= 1500 && interval <= 5000, 'Initial CPU warmup polls at2seconds');
          report.warm.push({ ...group, variant, interval });
        }
        await visit('ready', group.width, group.mode, group.scale);
        await sortButton('Memory').focus();
        await dom.focusMetrics(page);
        await dom.wheelTo(page, '.host-process-list > li:nth-child(3)');
        const before = await dom.reading(page);
        const oldOrder = await page.locator('.host-process-list > li').evaluateAll((rows) => rows.map((row) => row.dataset.processPid));
        const initial = report.requests.at(-1).at;
        setScenario('refreshed');
        await page.waitForFunction(() => document.querySelector('.host-process-list > li')?.dataset.processPid === '22', null, { timeout: 13000 });
        await dom.settle(page);
        const after = await dom.reading(page);
        const order = await page.locator('.host-process-list > li').evaluateAll((rows) => rows.map((row) => row.dataset.processPid));
        report.pendingRefresh = {
          ...group,
          before,
          after,
          oldOrder,
          order,
          focus: await sortButton('Memory').evaluate((element) => element === document.activeElement),
        };
        assert.deepEqual(after, before, 'Automatic ranking refresh preserves exact natural reading position');
        assert.equal(
          await sortButton('Memory').evaluate((element) => element === document.activeElement),
          true,
          'Ranking refresh preserves focused sort control',
        );
        assert.notDeepEqual(order, oldOrder);
        await verify('refreshed', 'cpuPercent');
        const interval = report.requests.at(-1).at - initial;
        assert.ok(interval >= 9000 && interval <= 12500);
        report.refresh.push({ ...group, before, after, interval, oldOrder, order });
        delete report.pendingRefresh;
        const summary = page.locator('.host-processes-about summary');
        await summary.focus();
        const growthBeforeFocus = await focusClear();
        const growthBefore = await dom.reading(page);
        const growthAt = report.requests.at(-1).at;
        setScenario('growth');
        await page.waitForFunction(() => document.querySelectorAll('.host-process-list > li').length === 20, null, { timeout: 13000 });
        await dom.settle(page);
        assert.equal(
          await summary.evaluate((element) => element === document.activeElement),
          true,
          'List growth preserves the focused About summary',
        );
        const growthAfterFocus = await focusClear();
        await verify('growth', 'cpuPercent');
        const growth = {
          ...group,
          before: growthBefore,
          after: await dom.reading(page),
          beforeFocus: growthBeforeFocus,
          afterFocus: growthAfterFocus,
          interval: report.requests.at(-1).at - growthAt,
          count: 20,
        };
        report.growth.push(growth);
        await shot(`${report.current}-about-growth-focused`);
      }
      await visit('missing', 390, 'dark', 1);
      const retry = page.locator('.host-processes-notice button');
      await retry.focus();
      setScenario('ready');
      let release;
      setHold(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      releases.push(release);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => Boolean(document.querySelector('.host-processes-notice button:disabled')));
      await sortButton('Memory').focus();
      release();
      await page.locator('.host-processes-notice').waitFor({ state: 'hidden' });
      await dom.settle(page);
      assert.equal(
        await sortButton('Memory').evaluate((element) => element === document.activeElement),
        true,
        'Retry completion must not steal moved focus',
      );
      report.focusAffinity = true;
      await visit('ready', 1440, 'dark', 1);
      await page.getByRole('button', { name: 'Minimize Monitor', exact: true }).click();
      await page.locator('.desktop-route-window').waitFor({ state: 'hidden' });
      const minimizedCount = report.requests.length;
      await page.waitForTimeout(10600);
      assert.equal(report.requests.length, minimizedCount, 'Minimized process polling stops');
      await page.getByRole('button', { name: 'Restore Monitor', exact: true }).click();
      await page.locator('.desktop-route-window').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('.host-process-list > li').length === 8);
      report.polling.push({ kind: 'minimized', reads: 0, duration: 10600 });
      await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
      const hiddenCount = report.requests.length;
      await page.waitForTimeout(10600);
      assert.equal(report.requests.length, hiddenCount, 'Hidden route process polling stops');
      report.polling.push({ kind: 'hidden-route', reads: 0, duration: 10600 });
      await visit('core-missing', 390, 'dark', 1);
      await verify('ready', 'cpuPercent');
      await wheelToHeading(page);
      report.coreIndependent = await measure();
      await shot('390-dark-core-unavailable-processes-ready');
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    report.passed = true;
  } catch (error) {
    await session.failure(error);
  } finally {
    await session.finish();
  }
  return report;
};

module.exports.fixture = fixture;
module.exports.dom = { inspect, check };

module.exports.contrast = async function inspectProcessContrast({ page, base, preferences, capture }) {
  const session = await createSession({ page, base, preferences, capture });
  const { report, visit, shot } = session;
  report.samples = [];
  report.issues = [];
  try {
    for (const preset of ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'])
      for (const mode of ['light', 'dark']) {
        await visit('stale', 1440, mode, 1, preset);
        await page.locator('.host-processes-about summary').click();
        await wheelToHeading(page);
        const samples = await page.locator('.host-processes').evaluate((root) => {
          const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
          context.canvas.width = context.canvas.height = 1;
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
            return [...a.slice(0, 3).map((channel, index) => (channel * alpha + b[index] * behind * (1 - alpha)) / combined), combined * 255];
          };
          const luminance = (color) => {
            const values = color.slice(0, 3).map((channel) => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
          };
          return [
            ['fact label', '.host-process-values dt', '--desktop-status-muted'],
            ['process PID', '.host-process-identity > span', '--desktop-status-muted'],
            ['rank note', '.host-processes-sort > span', '--desktop-status-muted'],
            ['coverage', '.host-processes-coverage', '--desktop-status-muted'],
            ['about', '.host-processes-about p', '--desktop-status-muted'],
            ['stale', '.host-processes-stale,.host-processes-state[data-stale=true]', '--desktop-warning'],
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
                  const style = getComputedStyle(ancestor);
                  layers.push({ color: rgba(style.backgroundColor), image: style.backgroundImage });
                }
                const effective = [0, 255].map((bound) => {
                  let background = [bound, bound, bound, 255];
                  for (const layer of layers.toReversed()) {
                    background = over(layer.color, background);
                    if (layer.image !== 'none') background = [bound, bound, bound, 255];
                  }
                  const text = over(foreground, background);
                  return {
                    background,
                    text,
                    ratio: (Math.max(luminance(text), luminance(background)) + 0.05) / (Math.min(luminance(text), luminance(background)) + 0.05),
                  };
                });
                return {
                  text: element.textContent,
                  foreground,
                  expected,
                  layers,
                  effective,
                  minimum: Math.min(...effective.map((value) => value.ratio)),
                };
              }),
            };
          });
        });
        for (const family of samples) {
          if (!family.labels.length) report.issues.push({ preset, mode, family: family.family, reason: 'missing-family' });
          for (const label of family.labels) {
            if (!label.foreground.every((channel, index) => channel === label.expected[index]))
              report.issues.push({ preset, mode, family: family.family, reason: 'token-mismatch', label });
            if (label.minimum < 4.5) report.issues.push({ preset, mode, family: family.family, reason: 'contrast', label });
          }
        }
        await shot(`${preset}-${mode}-palette`);
        report.samples.push({ preset, mode, samples });
      }
    assert.deepEqual(report.issues, []);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    report.minimum = Math.min(...report.samples.flatMap((sample) => sample.samples.flatMap((family) => family.labels.map((label) => label.minimum))));
    report.passed = true;
  } catch (error) {
    await session.failure(error);
  } finally {
    await session.finish();
  }
  return report;
};
