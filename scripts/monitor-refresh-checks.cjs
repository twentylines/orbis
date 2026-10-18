const assert = require('node:assert/strict');
const { dom, fixture: deviceFixture } = require('./host-devices-checks.cjs');
const { fixture: processFixture } = require('./host-processes-checks.cjs');

const hostEndpoint = '/api/system/host-telemetry';
const processEndpoint = '/api/system/host-processes';
const dockerEndpoint = '/api/system/containers';
const historyEndpoint = '/api/system/host-history';
const plotSelector = '.host-history-chart:first-child .metric-chart-plot';
const aboutSelector = '.host-history-about summary';
const detailsSelector = '[data-container="worker-c"] .container-resource-details summary';
const usageHeadingSelector = '.container-resources-heading h2';
const dockerSortSelector = '#containers .container-resources-sort button:first-of-type';

function devices(count = 3, reverse = false) {
  const value = deviceFixture();
  const ordering = Array.from({ length: count }, (_, index) => index);
  if (reverse) ordering.reverse();
  value.network = ordering.map((index) => ({ ...value.network[0], interface: `eth${index}`, historyId: 'a'.repeat(64) }));
  value.disks = ordering.map((index) => ({ ...value.disks[0], device: `nvme${index}n1`, historyId: 'b'.repeat(64) }));
  value.filesystems = ordering.map((index) => ({ ...value.filesystems[0], mount: `/mnt/archive/volume-${index}` }));
  value.sampledAt = new Date().toISOString();
  return value;
}
function processes(variant = 'small') {
  const value = processFixture(variant === 'large' ? 'growth' : variant === 'empty' ? 'first-cpu' : 'ready');
  if (variant === 'small') {
    value.byCpu = value.byCpu.slice(0, 1);
    value.byMemory = structuredClone(value.byCpu);
    value.scanned = value.readable = value.compared = 1;
  }
  value.sampledAt = new Date().toISOString();
  return value;
}
function containers(count = 6, reverse = false, only = null) {
  const ids = only || Array.from({ length: count }, (_, index) => index);
  return {
    available: true,
    sampledAt: new Date().toISOString(),
    omitted: 0,
    containers: ids.map((index) => ({
      id: `fixture-container-${index}`,
      name: `worker-${String.fromCharCode(97 + index)}`,
      appUrn: null,
      state: 'running',
      health: 'healthy',
      statsAvailable: true,
      cpuPercent: reverse ? index + 1 : count - index,
      memoryBytes: 1024 ** 3,
      memoryLimitBytes: 4 * 1024 ** 3,
      receivedBytes: 1024,
      transmittedBytes: 2048,
      blockReadBytes: 4096,
      blockWriteBytes: 8192,
    })),
  };
}
function history() {
  const to = Math.floor(Date.now() / 10000) * 10000;
  const reading = { average: 100, peak: 100, samples: 1 };
  return {
    range: '5m',
    from: new Date(to - 300000).toISOString(),
    to: new Date(to).toISOString(),
    resolutionSeconds: 10,
    sampledEverySeconds: 10,
    retentionDays: 7,
    seriesLimit: 64,
    storage: 'persistent',
    collectorAvailable: true,
    reason: null,
    unidentifiedDevices: 0,
    omittedDevices: 0,
    evictedDevices: 0,
    lastSampleAt: new Date(to).toISOString(),
    persistedThrough: new Date(to).toISOString(),
    devices: [{ kind: 'network', name: 'eth0', lastSeenAt: new Date(to).toISOString(), present: true }],
    selected: { kind: 'network', name: 'eth0' },
    points: [to - 10000, to].map((at) => ({
      at: new Date(at).toISOString(),
      until: new Date(at).toISOString(),
      intervalSeconds: 10,
      samples: 1,
      sourceId: 'a'.repeat(64),
      inbound: reading,
      outbound: reading,
      busy: { average: null, peak: null, samples: 0 },
    })),
  };
}

async function restoreText(page) {
  await page.evaluate(() => {
    const state = window.__orbisHostHistoryTextScale;
    if (!state) return;
    state.observer.disconnect();
    for (const [element, value] of state.entries)
      for (const [name, original, priority] of value.original) {
        if (original) element.style.setProperty(name, original, priority);
        else element.style.removeProperty(name);
      }
    delete window.__orbisHostHistoryTextScale;
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
    window.__orbisHostHistoryTextScale = { factor, entries, observer };
  }, factor);
  await dom.settle(page);
}

async function snapshot(page, selector, inspection = false) {
  return page.locator(selector).evaluate((target, inspection) => {
    const frame = target.closest('.desktop-route-window');
    const content = frame.querySelector('.desktop-window-content');
    const desktop = frame.dataset.windowNavigation === 'desktop';
    const scroller = desktop ? content : document.scrollingElement;
    const contentBounds = content.getBoundingClientRect();
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
        position: rect.top + (desktop ? content.scrollTop - contentBounds.top : scrollY),
      };
    };
    const top = Math.max(
      document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
      desktop ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0,
      desktop ? contentBounds.top : 0,
    );
    const bottom = Math.min(document.querySelector('.desktop-dock').getBoundingClientRect().top, desktop ? contentBounds.bottom : innerHeight);
    const style = getComputedStyle(target);
    const outline = style.outlineStyle === 'none' ? 0 : Number.parseFloat(style.outlineWidth) + Math.max(0, Number.parseFloat(style.outlineOffset));
    const targetBox = box(target);
    const inspectionBox = inspection ? box(document.querySelector('.host-history-chart:first-child .metric-chart-tooltip')) : null;
    return {
      at: Date.now(),
      navigation: frame.dataset.windowNavigation,
      rawScroll: { x: scrollX, y: scrollY, frame: frame.scrollTop, content: content.scrollTop },
      scroller: {
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        maxScroll: scroller.scrollHeight - scroller.clientHeight,
        overflowAnchor: getComputedStyle(scroller).overflowAnchor,
      },
      clip: { top, bottom },
      target: targetBox,
      raster: { devicePixelRatio, comfortToleranceCssPixels: 0.5 / devicePixelRatio },
      clearance: {
        focusTop: targetBox.top - outline - top,
        focusBottom: bottom - targetBox.bottom - outline,
        inspectionTop: inspectionBox ? inspectionBox.top - top : null,
        inspectionBottom: inspectionBox ? bottom - inspectionBox.bottom : null,
      },
      focus: {
        active: document.activeElement === target,
        outline: style.outline,
        outlineOffset: style.outlineOffset,
        shadow: style.boxShadow,
        outset: outline,
        top: targetBox.top - outline,
        bottom: targetBox.bottom + outline,
      },
      inspection: inspectionBox,
      inspectedAt: inspection ? document.querySelector('.host-history-chart:first-child .metric-chart-tooltip time')?.getAttribute('datetime') : null,
      inspectedValue: inspection ? target.getAttribute('aria-valuetext') : null,
      sections: [...document.querySelector('.desktop-monitor').children].map((element) => ({ classes: element.className, box: box(element) })),
      dockerRows: [...document.querySelectorAll('.container-resource-list > li')].map((element) => ({
        name: element.dataset.container,
        box: box(element),
      })),
    };
  }, inspection);
}
function checkVisible(value, inspection) {
  assert.ok(value.focus.active, 'The same native control must retain focus');
  assert.ok(value.focus.outline.includes('solid') || value.focus.shadow !== 'none', 'Keyboard focus must have a painted marker');
  assert.ok(value.focus.top >= value.clip.top && value.focus.bottom <= value.clip.bottom, 'No painted focus marker may cross the actual clip edge');
  const tolerance = value.raster.comfortToleranceCssPixels;
  assert.ok(
    value.focus.top >= value.clip.top + 3 - tolerance && value.focus.bottom <= value.clip.bottom - 3 + tolerance,
    'Complete focus marker must remain clear of sticky chrome/dock',
  );
  if (inspection) {
    assert.ok(
      value.inspection && value.inspection.top >= value.clip.top && value.inspection.bottom <= value.clip.bottom,
      'No inspected panel may cross the actual clip edge',
    );
    assert.ok(
      value.inspection.top >= value.clip.top + 8 - tolerance && value.inspection.bottom <= value.clip.bottom - 8 + tolerance,
      'Complete inspected reading remains visible with breathing room',
    );
  }
}
async function prepare(page, selector, inspection) {
  const target = page.locator(selector);
  await target.focus();
  if (inspection) await page.keyboard.press('End');
  else {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await target.evaluate((element) => element === document.activeElement), true, 'Native traversal reaches the target');
  }
  await dom.settle(page);
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await snapshot(page, selector, inspection);
    const maximum = Math.min(value.focus.top - value.clip.top - 3, inspection ? value.inspection.top - value.clip.top - 8 : Number.POSITIVE_INFINITY);
    const minimum = Math.max(
      value.focus.bottom - value.clip.bottom + 3,
      inspection ? value.inspection.bottom - value.clip.bottom + 8 : Number.NEGATIVE_INFINITY,
    );
    const tolerance = value.raster.comfortToleranceCssPixels;
    assert.ok(minimum <= maximum + tolerance * 2, `Before refresh the full focused reading must fit the physical viewport: ${JSON.stringify(value)}`);
    const center = (minimum + maximum) / 2;
    if (minimum <= tolerance && maximum >= -tolerance && Math.abs(center) <= tolerance) {
      checkVisible(value, inspection);
      return;
    }
    const delta = Math.round(center);
    await page.mouse.move(Math.min(value.target.right - 20, value.target.left + 35), value.clip.top + 80);
    await page.mouse.wheel(0, Math.max(-900, Math.min(900, delta)));
    await page.waitForTimeout(100);
  }
  throw new Error('Native preparation wheel did not reveal the full focused reading');
}
function checkAnchor(before, after, inspection) {
  checkVisible(after, inspection);
  for (const edge of ['top', 'bottom', 'left', 'right'])
    assert.ok(Math.abs(before.target[edge] - after.target[edge]) <= 1, `Focused control ${edge} must retain its actual viewport anchor`);
  if (inspection) {
    assert.equal(after.inspectedAt, before.inspectedAt, 'The inspected recorded sample must remain selected');
    assert.equal(after.inspectedValue, before.inspectedValue, 'The inspected recorded value must remain unchanged');
    for (const edge of ['top', 'bottom', 'left', 'right'])
      assert.ok(Math.abs(before.inspection[edge] - after.inspection[edge]) <= 1, `Inspected reading ${edge} must retain its actual viewport anchor`);
  }
}

async function inspectSummaryControl(page) {
  const summary = page.locator(detailsSelector);
  const details = summary.locator('..');
  await prepare(page, detailsSelector, false);
  assert.equal(await details.getAttribute('open'), null, 'Details begins closed');
  await summary.locator('span').click();
  assert.equal(await details.getAttribute('open'), '', 'Clicking the actual label opens native details');
  await page.keyboard.press('Space');
  assert.equal(await details.getAttribute('open'), null, 'Native Space closes details again');
  await dom.settle(page);
  const value = await summary.evaluate((element) => {
    const label = element.querySelector('span');
    const glyph = element.querySelector('svg');
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width, height: value.height };
    };
    const text = label.firstChild;
    const range = document.createRange();
    range.selectNodeContents(label);
    const lines = [...range.getClientRects()].map((value) => ({ top: value.top, bottom: value.bottom, left: value.left, right: value.right }));
    const words = [...label.textContent.matchAll(/\S+/g)].map((match) => {
      const range = document.createRange();
      range.setStart(text, match.index);
      range.setEnd(text, match.index + match[0].length);
      return { word: match[0], fragments: [...range.getClientRects()].map((value) => ({ left: value.left, right: value.right })) };
    });
    const style = getComputedStyle(element);
    return {
      pointerOpened: true,
      spaceClosed: true,
      nativeDetails: element.parentElement.tagName === 'DETAILS',
      summary: rect(element),
      label: rect(label),
      glyph: rect(glyph),
      lines,
      words,
      padding: { top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft },
      gap: style.gap,
    };
  });
  assert.equal(value.nativeDetails, true, 'Summary retains native details semantics');
  assert.ok(value.lines.length > 0, 'Summary label has actual painted text');
  for (const line of value.lines) {
    assert.ok(Math.abs(line.left - value.lines[0].left) <= 0.5, 'Wrapped label lines share the same left edge');
    assert.ok(line.left >= value.summary.left + 12 && line.right <= value.summary.right - 12, 'Every painted label line has horizontal padding');
  }
  assert.ok(value.lines[0].top >= value.summary.top + 8, 'Label ink has comfortable top padding');
  assert.ok(value.lines.at(-1).bottom <= value.summary.bottom - 8, 'Label ink has comfortable bottom padding');
  assert.ok(value.glyph.left >= value.summary.left + 12, 'Chevron has comfortable left padding');
  assert.ok(value.label.left - value.glyph.right >= 8, 'Chevron and label retain their8px gap');
  assert.ok(
    Math.abs((value.label.top + value.label.bottom) / 2 - (value.glyph.top + value.glyph.bottom) / 2) <= 0.5,
    'Chevron is vertically centered beside the complete label',
  );
  for (const word of value.words) assert.equal(word.fragments.length, 1, `Ordinary word ${word.word} remains whole`);
  return value;
}

module.exports = async function inspectMonitorRefresh({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.port === '8080', 'Only static8080 fixture QA is permitted');
  const viewport = page.viewportSize();
  const scope = process.env.ORBIS_VISUAL_MONITOR_REFRESH_SCOPE || 'all';
  assert.ok(['all', 'phone', 'removed'].includes(scope), 'Unknown Monitor refresh fixture scope');
  const phoneOnly = scope === 'phone';
  const removedOnly = scope === 'removed';
  const report = {
    passed: false,
    cases: [],
    requests: [],
    errors: [],
    mutations: [],
    preferencePuts: 0,
    cleanup: {},
    cleanupFailures: [],
    provenance: {
      controlledFixtures: true,
      maximumCases: removedOnly ? 3 : phoneOnly ? 10 : 20,
      updateMechanism: 'Actual existing5s/10s query timers; no injected query client or DOM layout changes',
      history: 'Fixed recorded history isolates upstream/below-card layout updates',
      oracle: 'Stable actual viewport anchors and full native focus/inspection clearance; raw offsets reported separately',
      stop: 'First concrete failure; no post-update scrolling/focusing or screenshot reset',
      scope: removedOnly
        ? 'Removed focused Docker row and moved-away focus at1440native/1100x640native/320text2'
        : phoneOnly
          ? '320dark computed text2 follow-up only'
          : '1440light native and320dark computed text2',
      preparation: 'Native wheel maximizes feasible3px focus-marker/8px inspection slack before updates; no blanket20px envelope precondition',
      spacingOracle: 'Hard complete visibility; comfort spacing alone allows half a physical pixel (0.5/DPR CSS px); anchors remain<=1px',
    },
  };
  let shadow;
  let payloads;
  let versions;
  let counter = 0;
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
    if (!Object.hasOwn(payloads || {}, url.pathname)) return route.fallback();
    const version = versions[url.pathname] || 0;
    report.requests.push({ path: url.pathname, version, at: Date.now() });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'x-orbis-qa-version': String(version) },
      body: JSON.stringify(payloads[url.pathname]),
    });
  };
  await page.route('**/api/**', handler);
  const shot = (suffix) => capture(`monitor-refresh-${report.current}-${suffix}`, { scrollTop: false, fullPage: false });
  const updateDocker = async (value) => {
    const version = ++counter;
    const response = page.waitForResponse(
      (response) => new URL(response.url()).pathname === dockerEndpoint && response.headers()['x-orbis-qa-version'] === String(version),
      { timeout: 15000 },
    );
    void response.catch(() => undefined);
    const armed = Date.now();
    payloads[dockerEndpoint] = value;
    versions[dockerEndpoint] = version;
    await response;
    await page.waitForFunction(
      (names) => {
        const actual = [...document.querySelectorAll('.container-resource-list > li')].map((row) => row.dataset.container);
        return actual.length === names.length && actual.every((name, index) => name === names[index]);
      },
      [...value.containers].sort((left, right) => right.cpuPercent - left.cpuPercent || left.name.localeCompare(right.name)).map((row) => row.name),
    );
    await dom.settle(page);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return Date.now() - armed;
  };
  try {
    const groups = [
      { width: 1440, height: 1120, mode: 'light', scale: 1 },
      ...(removedOnly ? [{ width: 1100, height: 640, mode: 'light', scale: 1 }] : []),
      { width: 320, height: 800, mode: 'dark', scale: 2 },
    ];
    for (const group of groups.filter((group) => !phoneOnly || group.width === 320)) {
      shadow = { ...structuredClone(preferences), preset: 'ocean', mode: group.mode, windows: {} };
      payloads = { [hostEndpoint]: devices(), [processEndpoint]: processes(), [dockerEndpoint]: containers(), [historyEndpoint]: history() };
      versions = {};
      await page.setViewportSize({ width: group.width, height: group.height });
      await page.goto(`${base}/monitor?range=5m&hostDevice=network%3Aeth0`, { waitUntil: 'domcontentloaded' });
      await page.locator('.host-history-chart').first().waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll('.container-resource-list > li').length === 6 && document.querySelector('.host-process-list li'),
      );
      await dom.settle(page);
      await scaleText(page, group.scale);
      const cases = [
        ['host-grow', hostEndpoint, () => devices(6), plotSelector, true],
        ['host-shrink', hostEndpoint, () => devices(3), plotSelector, true],
        ['host-reorder', hostEndpoint, () => devices(3, true), plotSelector, true],
        [
          'host-unavailable',
          hostEndpoint,
          () => ({ available: false, reason: 'The Orbis host service is not connected. Check the host service and try again.' }),
          plotSelector,
          true,
        ],
        ['process-grow-about', processEndpoint, () => processes('large'), aboutSelector, false],
        ['process-shrink-about', processEndpoint, () => processes('empty'), aboutSelector, false],
        ['docker-reorder-chart', dockerEndpoint, () => containers(6, true), plotSelector, true],
        ['docker-reorder-details', dockerEndpoint, () => containers(6, false), detailsSelector, false],
        ['docker-grow-details', dockerEndpoint, () => containers(12, true), detailsSelector, false],
        ['docker-shrink-details', dockerEndpoint, () => containers(2, true, [2, 0]), detailsSelector, false],
      ];
      for (const [name, endpoint, next, target, inspection] of removedOnly ? [] : cases) {
        report.current = `${group.width}-${group.mode}-text${group.scale}-${name}`;
        const summaryControl = name === 'docker-reorder-details' ? await inspectSummaryControl(page) : null;
        await prepare(page, target, inspection);
        const before = await snapshot(page, target, inspection);
        await shot('before');
        const result = { ...group, name, endpoint, inspection, summaryControl, before, after: null, passed: false };
        report.cases.push(result);
        const version = ++counter;
        const response = page.waitForResponse(
          (response) => new URL(response.url()).pathname === endpoint && response.headers()['x-orbis-qa-version'] === String(version),
          { timeout: 15000 },
        );
        void response.catch(() => undefined);
        const armed = Date.now();
        payloads[endpoint] = next();
        versions[endpoint] = version;
        await response;
        result.waited = Date.now() - armed;
        await dom.settle(page);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        result.after = await snapshot(page, target, inspection);
        result.rawOffsetsChanged = JSON.stringify(result.before.rawScroll) !== JSON.stringify(result.after.rawScroll);
        result.viewportDelta = {
          top: result.after.target.top - result.before.target.top,
          bottom: result.after.target.bottom - result.before.target.bottom,
        };
        await shot('after');
        checkAnchor(before, result.after, inspection);
        result.passed = true;
      }
      if (removedOnly) {
        report.current = `${group.width}-${group.mode}-text${group.scale}-docker-focused-row-removal`;
        const result = { ...group, name: 'docker-focused-row-removal', endpoint: dockerEndpoint, passed: false };
        report.cases.push(result);
        await prepare(page, detailsSelector, false);
        result.before = await snapshot(page, detailsSelector);
        result.headingBefore = await snapshot(page, usageHeadingSelector);
        await shot('removed-before');
        result.waited = await updateDocker(containers(2, false, [0, 1]));
        result.after = await snapshot(page, usageHeadingSelector);
        result.removedControlAbsent = (await page.locator(detailsSelector).count()) === 0;
        await shot('removed-after');
        assert.equal(result.removedControlAbsent, true, 'The actual focused keyed row was removed');
        assert.equal(
          await page.locator(usageHeadingSelector).getAttribute('tabindex'),
          '-1',
          'Surviving Usage heading is a programmatic focus target',
        );
        checkVisible(result.after, false);

        await updateDocker(containers());
        await prepare(page, detailsSelector, false);
        result.movedAway = { wasOnRemovedRow: (await snapshot(page, detailsSelector)).focus.active };
        await prepare(page, dockerSortSelector, false);
        result.movedAway.before = await snapshot(page, dockerSortSelector);
        await shot('moved-away-before');
        result.movedAway.waited = await updateDocker(containers(2, false, [0, 1]));
        result.movedAway.after = await snapshot(page, dockerSortSelector);
        result.movedAway.removedControlAbsent = (await page.locator(detailsSelector).count()) === 0;
        await shot('moved-away-after');
        assert.equal(result.movedAway.wasOnRemovedRow, true, 'User initially focused the row before moving elsewhere');
        assert.equal(result.movedAway.removedControlAbsent, true, 'Previously focused row disappears after user moves away');
        checkAnchor(result.movedAway.before, result.movedAway.after, false);
        result.passed = true;
      }
    }
    assert.equal(report.cases.length, removedOnly ? 3 : phoneOnly ? 10 : 20);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    report.passed = true;
  } catch (error) {
    report.failure = { phase: report.current, name: error.name, message: error.message };
    await shot('FAILED').catch((captureError) => {
      report.captureFailure = captureError.message;
    });
  } finally {
    for (const [name, operation] of [
      ['textRestored', () => restoreText(page)],
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
