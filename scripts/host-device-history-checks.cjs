const assert = require('node:assert/strict');
const { dom } = require('./host-devices-checks.cjs');

const endpoint = '/api/system/host-history';
const networkName = `enp193s0f0np0.4094:${'storage-replication-backup-'.repeat(5)}`.slice(0, 128);
const diskName = `dm-${'production-archive-backup-'.repeat(6)}`.slice(0, 128);
const devices = [
  { kind: 'network', name: networkName },
  { kind: 'network', name: 'eth0:1' },
  { kind: 'disk', name: diskName },
  { kind: 'disk', name: 'nvme0n1' },
];
const ranges = { '5m': [300000, 10], '1h': [3600000, 60], '24h': [86400000, 300], '7d': [604800000, 1800] };
const keyOf = ({ kind, name }) => `${kind}:${name}`;
const fixture = (range = '1h', selection = null, variant = 'ready') => {
  assert.ok(Object.hasOwn(ranges, range), 'Known source fixture range');
  const selected =
    typeof selection === 'string'
      ? { kind: selection.slice(0, selection.indexOf(':')), name: selection.slice(selection.indexOf(':') + 1) }
      : selection || (variant === 'catalogue-growth' ? { kind: 'network', name: 'aa0' } : devices[0]);
  const [duration, resolutionSeconds] = ranges[range];
  const to = Math.floor(Date.now() / 10000) * 10000;
  const from = to - duration;
  const available = !['unavailable', 'old-helper'].includes(variant);
  const catalogue = ['empty', 'old-helper', 'unavailable'].includes(variant)
    ? []
    : devices.map((item) => ({
        ...item,
        lastSeenAt: new Date(to - (variant === 'missing-device' ? 60000 : variant === 'empty-range' ? 7200000 : 0)).toISOString(),
        present: !['missing-device', 'empty-range'].includes(variant),
      }));
  if (variant === 'catalogue-growth') catalogue.unshift({ kind: 'network', name: 'aa0', lastSeenAt: new Date(to).toISOString(), present: true });
  const count = range === '5m' ? 1 : Math.max(2, resolutionSeconds / 10);
  const points = Array.from({ length: 10 }, (_, index) => {
    const position = index > 6 ? index + 2 : index;
    const at = to - (12 - position) * resolutionSeconds * 1000;
    const missing = index === 2 || variant === 'null';
    const average = (index + 1 + (variant === 'refreshed' ? 1 : 0)) * 1024 ** 2;
    const metric = (value) => ({
      average: missing ? null : value,
      peak: missing ? null : value * (count > 1 ? 1.5 : 1),
      samples: missing ? 0 : count,
    });
    return {
      at: new Date(at).toISOString(),
      until: new Date(at + (count - 1) * 10000).toISOString(),
      intervalSeconds: resolutionSeconds,
      samples: count,
      sourceId: missing ? null : (index < 5 ? 'a' : 'b').repeat(64),
      inbound: metric(average),
      outbound: metric(average / 2),
      busy: selected.kind === 'disk' ? metric((index + 1) * 5) : { average: null, peak: null, samples: 0 },
    };
  });
  return {
    range,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    resolutionSeconds,
    sampledEverySeconds: 10,
    retentionDays: 7,
    seriesLimit: 64,
    storage: variant === 'storage' ? 'unavailable' : 'persistent',
    collectorAvailable: available,
    reason:
      variant === 'old-helper'
        ? 'Update the Orbis host service to record device history.'
        : variant === 'unavailable'
          ? 'The Orbis host service is not connected. Check the host service and try again.'
          : null,
    unidentifiedDevices: variant === 'old-helper' ? 3 : 0,
    omittedDevices: variant === 'coverage' ? 4 : 0,
    evictedDevices: variant === 'coverage' ? 19 : 0,
    lastSampleAt: available ? new Date(to).toISOString() : null,
    persistedThrough: available && variant !== 'empty' ? new Date(to - 60000).toISOString() : null,
    devices: catalogue,
    selected: catalogue.length ? { ...selected } : null,
    points: catalogue.length && variant !== 'empty-range' ? points : [],
  };
};

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

async function measure(page) {
  return page.locator('.host-device-history').evaluate((root) => {
    const box = (element) => {
      if (!element) return null;
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
    const edgeInk = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement.getClientRects().length || node.parentElement.closest('svg,legend,[aria-hidden=true],bdi')) continue;
      for (const match of node.textContent.matchAll(/[A-Za-z][A-Za-z'-]{2,}/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
        if (new Set(rects.map((rect) => Math.round(rect.top))).size > 1) words.push({ text: match[0], context: node.parentElement.textContent });
        for (const rect of rects)
          if (rect.left < inner.left - 1 || rect.right > inner.right + 1) edgeInk.push({ text: match[0], left: rect.left, right: rect.right });
      }
    }
    const textControl = (element) => ({
      text: element.textContent,
      box: box(element),
      ink: ink(element),
      font: Number.parseFloat(getComputedStyle(element).fontSize),
      expectedFont: window.__orbisHostHistoryTextScale?.entries.get(element)?.font * (window.__orbisHostHistoryTextScale?.factor || 1) || null,
    });
    const choices = [...document.querySelectorAll('.host-history-choice')].map((choice) => {
      const identifier = choice.querySelector('bdi');
      const identifierStyle = getComputedStyle(identifier);
      const option = choice.closest('[role=option]');
      return {
        box: box(choice),
        text: choice.textContent,
        title: choice.title,
        parentRole: option?.getAttribute('role'),
        accessibleName: option?.getAttribute('aria-label'),
        option: box(option),
        kind: textControl(choice.querySelector('span')),
        identifier: {
          text: identifier.textContent,
          box: box(identifier),
          overflow: identifierStyle.overflowX,
          ellipsis: identifierStyle.textOverflow,
          nowrap: identifierStyle.whiteSpace,
          truncated: identifier.scrollWidth > identifier.clientWidth + 1,
        },
      };
    });
    return {
      menu: document.querySelector('.host-history-device-menu')
        ? {
            box: box(document.querySelector('.host-history-device-menu')),
            viewport: box(document.querySelector('.host-history-device-menu .orbis-select-viewport')),
            focused: document.activeElement?.getAttribute('role') === 'option' ? box(document.activeElement) : null,
          }
        : null,
      textScale: window.__orbisHostHistoryTextScale?.factor || 1,
      width: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      root: box(root),
      monitor: box(root.closest('.desktop-monitor')),
      inner,
      padding: [Number.parseFloat(style.paddingLeft), Number.parseFloat(style.paddingRight)],
      heading: box(root.querySelector('h2')),
      peer: box(root.closest('.desktop-monitor').querySelector('.host-processes-heading h2')),
      words,
      edgeInk,
      label: textControl(root.querySelector('.host-history-device .form-label')),
      trigger: {
        ...textControl(root.querySelector('[role=combobox]')),
        title: root.querySelector('[role=combobox]').title,
        disabled: root.querySelector('[role=combobox]').disabled,
      },
      buttons: [...root.querySelectorAll('.host-history-ranges button')].map(textControl),
      choices,
      charts: [...root.querySelectorAll('.host-history-chart')].map((chart) => {
        const plot = chart.querySelector('.metric-chart-plot');
        const scale = chart.querySelector('.metric-chart-scale');
        const tooltip = chart.querySelector('.metric-chart-tooltip');
        const svg = chart.querySelector('svg');
        const empty = chart.querySelector('.metric-chart-empty');
        return {
          box: box(chart),
          heading: box(chart.querySelector('h3')),
          headerValue: textControl(chart.querySelector('header output')),
          metric: chart.querySelector('.metric-chart').dataset.metric,
          plot: box(plot),
          svg: box(svg),
          scale: box(scale),
          labels: [...scale.children]
            .filter((element) => element.getClientRects().length)
            .map((element) => ({ ...textControl(element), prefix: getComputedStyle(element, '::before').content })),
          times: [...chart.querySelectorAll('.metric-chart-times span')].filter((element) => element.getClientRects().length).map(textControl),
          lines: [...svg.querySelectorAll('polyline')].map((line) => line.getAttribute('points')),
          segments: svg.querySelectorAll('[data-history-segment]').length,
          tooltip: tooltip
            ? { ...textControl(tooltip), position: getComputedStyle(tooltip).position, children: [...tooltip.children].map(textControl) }
            : null,
          empty: empty ? textControl(empty) : null,
        };
      }),
      notices: [...root.querySelectorAll('.host-history-notice,.host-history-coverage')].map(textControl),
    };
  });
}

function check(metrics) {
  const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${label}: ${a} vs ${b}`);
  assert.ok(metrics.documentWidth <= metrics.width + 1, 'Device history must not overflow the document');
  assert.deepEqual(metrics.words, [], 'Ordinary history words must remain whole');
  assert.deepEqual(metrics.edgeInk, [], 'Actual text must clear padded card edges');
  near(metrics.root.left, metrics.monitor.left, 'History shares Monitor left edge');
  near(metrics.root.right, metrics.monitor.right, 'History shares Monitor right edge');
  near(metrics.heading.left, metrics.inner.left, 'History heading uses shared inner gutter');
  if (metrics.peer) near(metrics.heading.left, metrics.peer.left, 'History and process headings share an inner gutter');
  near(metrics.label.box.left, metrics.inner.left, 'Device label uses shared gutter');
  assert.ok(
    metrics.padding.every((value) => value >= 18),
    'History card retains at least18px padding',
  );
  assert.ok(metrics.trigger.box.top - metrics.label.box.bottom >= 8, 'Device label clears its selector');
  for (const button of metrics.buttons) {
    assert.ok(button.box.height >= 38, 'Shared time range control retains its established height');
    for (const rect of button.ink)
      assert.ok(rect.left >= button.box.left + 8 && rect.right <= button.box.right - 8, 'Time range text retains symmetric inner breathing room');
  }
  assert.ok(
    metrics.buttons.every((button) => Math.abs(button.box.height - metrics.buttons[0].box.height) <= 1),
    'Range controls share equal heights',
  );
  if (metrics.menu) {
    assert.ok(metrics.menu.box.left >= 15 && metrics.menu.box.right <= metrics.width - 15, 'Open selector clears viewport edges');
    if (metrics.menu.focused)
      assert.ok(
        metrics.menu.focused.top >= metrics.menu.viewport.top - 1 && metrics.menu.focused.bottom <= metrics.menu.viewport.bottom + 1,
        'Native focused device option is wholly visible inside scrolling menu',
      );
  }
  for (const choice of metrics.choices) {
    if (choice.identifier.truncated)
      assert.ok(
        choice.identifier.overflow === 'hidden' && choice.identifier.ellipsis === 'ellipsis' && choice.identifier.nowrap === 'nowrap',
        'Long device names use deliberate ellipsis',
      );
    assert.ok(choice.title.endsWith(choice.identifier.text), 'Full logical identifier remains in title');
    if (choice.parentRole) assert.ok(choice.accessibleName.endsWith(choice.identifier.text), 'Open option retains full accessible identifier');
    for (const rect of choice.kind.ink)
      assert.ok(rect.left >= choice.box.left - 1 && rect.right <= choice.box.right + 1, 'Device kind text fits selector content');
  }
  for (const chart of metrics.charts) {
    for (const text of [...chart.labels, ...chart.times, ...(chart.tooltip?.children || [])])
      if (metrics.textScale === 2) {
        assert.ok(text.expectedFont !== null, 'Dynamic text was registered for enlargement');
        assert.ok(Math.abs(text.font - text.expectedFont) <= 0.1, 'Dynamically inserted chart text is enlarged exactly once');
      }
    assert.ok(chart.svg.width >= Math.min(160, chart.plot.width - 26) - 1, 'Graph retains a useful width rather than a token sliver');
    assert.ok(chart.box.left >= metrics.inner.left - 1 && chart.box.right <= metrics.inner.right + 1, 'Chart respects card gutters');
    const compact = chart.scale.bottom <= chart.svg.top - 8;
    if (compact) {
      assert.equal(chart.labels.length, 1, 'Compact chart exposes one complete range legend');
      assert.equal(chart.labels[0].prefix, '"0 – "', 'Compact legend includes the zero-to-maximum range');
      assert.ok(Math.abs(chart.svg.width - (chart.plot.width - 26)) <= 1, 'Compact graph fills the full plot inner width');
    } else assert.equal(chart.labels.length, 3, 'Wide chart retains its complete vertical scale');
    for (const label of chart.labels) {
      assert.ok(new Set(label.ink.map((rect) => Math.round(rect.top))).size <= (compact ? 2 : 1), 'Complete axis values remain readable');
      for (const rect of label.ink) {
        assert.ok(rect.left >= chart.scale.left - 1 && rect.right <= chart.scale.right + 1, 'Actual scale ink fits its own gutter');
        if (compact) assert.ok(rect.left >= chart.plot.left + 12 && rect.right <= chart.plot.right - 12, 'Full range legend clears plot edges');
        else assert.ok(rect.right <= chart.svg.left - 8, 'Vertical axis ink clears the graph by8px');
      }
    }
    for (const time of chart.times)
      for (const rect of time.ink) assert.ok(rect.left >= chart.plot.left + 10 && rect.right <= chart.plot.right - 10, 'Timestamps clear plot edges');
    if (chart.tooltip) {
      const panel = chart.tooltip;
      assert.ok(panel.box.top >= chart.plot.bottom + 8 && panel.box.bottom <= chart.box.bottom + 1, 'Inspection panel reserves actual flow height');
      assert.ok(!['fixed', 'absolute'].includes(panel.position), 'Inspection panel remains in normal flow');
      for (const child of panel.children)
        for (const rect of child.ink)
          assert.ok(
            rect.left >= panel.box.left + 12 &&
              rect.right <= panel.box.right - 12 &&
              rect.top >= panel.box.top + 10 &&
              rect.bottom <= panel.box.bottom - 10,
            'Inspection text retains full inner padding',
          );
    }
    if (chart.empty)
      for (const rect of chart.empty.ink)
        assert.ok(rect.left >= chart.empty.box.left + 10 && rect.right <= chart.empty.box.right - 10, 'Empty chart text retains readable padding');
  }
}

function verifyReadyValues(metrics, kind, keyboard = []) {
  const expected =
    kind === 'disk'
      ? [
          ['host-inbound', '10.0 MB/s', '15.0 MB/s'],
          ['host-outbound', '5.0 MB/s', '7.5 MB/s'],
          ['host-busy', '50.0%', '75.0%'],
        ]
      : [
          ['host-inbound', '10.0 MB/s', '15.0 MB/s'],
          ['host-outbound', '5.0 MB/s', '7.5 MB/s'],
        ];
  assert.deepEqual(
    metrics.charts.map((chart) => chart.metric),
    expected.map(([metric]) => metric),
    'Device kind maps the correct independent metric fields',
  );
  for (const [index, [, average, peak]] of expected.entries()) {
    const chart = metrics.charts[index];
    assert.equal(chart.headerValue.text, average, 'Chart header shows its actual latest direction');
    if (chart.tooltip)
      assert.ok(
        chart.tooltip.children.some((child) => child.text === `${average} average`),
        'Inspection shows the actual measured average',
      );
    if (chart.tooltip)
      assert.ok(
        chart.tooltip.children.some((child) => child.text === `Peak ${peak} · 6 samples`),
        'Inspection shows actual peak and measured sample count',
      );
    const end = keyboard.find((step) => step.index === index && step.key === 'End');
    if (end) {
      assert.ok(end.value.includes(average), 'Keyboard inspection exposes the actual measured average');
      assert.ok(end.value.includes(`peak ${peak}, 6 samples`), 'Keyboard inspection exposes actual peak and measured count');
    }
  }
}

async function wheelReveal(page, selector, lastLine = false) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const geometry = await page
      .locator(selector)
      .first()
      .evaluate((element, lastLine) => {
        const rect = element.getBoundingClientRect();
        const frame = element.closest('.desktop-route-window');
        const desktop = frame?.dataset.windowNavigation === 'desktop';
        const bar = document.querySelector('.desktop-system-bar').getBoundingClientRect();
        const dock = document.querySelector('.desktop-dock').getBoundingClientRect();
        const clip = desktop ? frame.querySelector('.desktop-window-content').getBoundingClientRect() : { top: 0, bottom: innerHeight };
        const top = Math.max(bar.bottom, clip.top, desktop ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0) + 16;
        const bottom = Math.min(dock.top, clip.bottom) - 16;
        const range = document.createRange();
        range.selectNodeContents(element);
        const lines = [...range.getClientRects()].filter((item) => item.width);
        const target = lastLine ? lines.at(-1) || rect : rect;
        return {
          top,
          bottom,
          target: { top: target.top, bottom: target.bottom },
          x: Math.min(innerWidth - 36, Math.max(50, rect.left + 50)),
          y: top + Math.min(100, (bottom - top) / 2),
        };
      }, lastLine);
    if (geometry.target.top >= geometry.top - 1 && geometry.target.bottom <= geometry.bottom + 1) return geometry;
    await page.mouse.move(geometry.x, geometry.y);
    const amount = geometry.target.top < geometry.top ? geometry.target.top - geometry.top : geometry.target.bottom - geometry.bottom;
    await page.mouse.wheel(0, Math.max(-900, Math.min(900, amount)));
    await page.waitForTimeout(100);
  }
  throw new Error(`Native wheel could not reveal ${selector}`);
}

async function session({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.port === '8080', 'Only isolated static8080 fixtures are permitted');
  const viewport = page.viewportSize();
  const report = {
    passed: false,
    layouts: [],
    states: [],
    retries: [],
    ranges: [],
    refresh: [],
    polling: [],
    requests: [],
    errors: [],
    mutations: [],
    preferencePuts: 0,
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
    if (url.pathname !== endpoint) return route.fallback();
    const variant = scenario;
    const range = url.searchParams.get('range') || '1h';
    const device = url.searchParams.get('device');
    report.requests.push({ variant, range, device, at: Date.now() });
    if (hold) {
      const gate = hold;
      hold = undefined;
      await gate;
    }
    return route.fulfill({
      status: variant === 'error' ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(variant === 'error' ? { message: 'Controlled history read failure' } : fixture(range, device, variant)),
    });
  };
  await page.route('**/api/**', handler);
  const shot = (name) => capture(`host-device-history-${name}`, { scrollTop: false, fullPage: false });
  const visit = async (variant, width, mode, scale, { range = '1h', selection = null, preset = 'ocean', wait = true } = {}) => {
    scenario = variant;
    report.current = `${width}-${mode}-text${scale}-${preset}-${range}-${typeof selection === 'string' && selection.startsWith('disk:') ? 'disk' : 'network'}-${variant}`;
    shadow = { ...structuredClone(preferences), mode, preset, windows: {} };
    await page.setViewportSize({ width, height: width === 1440 ? 1120 : width === 768 ? 1024 : width === 390 ? 844 : 800 });
    await page.goto(
      `${base}/monitor?range=${range}${selection ? `&hostDevice=${encodeURIComponent(typeof selection === 'string' ? selection : keyOf(selection))}` : ''}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.locator(`.desktop[data-desktop-mode="${mode}"][data-desktop-preset="${preset}"] .host-device-history`).waitFor();
    if (wait) {
      if (variant === 'error') await page.locator('.host-device-history [role=alert]').waitFor();
      else await page.waitForFunction(() => !document.querySelector('.host-device-history')?.textContent.includes('Loading device history…'));
    }
    await dom.settle(page);
    await scaleText(page, scale);
  };
  const metrics = async () => {
    const value = await measure(page);
    report.pending = value;
    check(value);
    delete report.pending;
    return value;
  };
  const finish = async () => {
    for (const release of releases) release();
    report.cleanup = {};
    report.cleanupFailures = [];
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
  };
  const failure = async (error) => {
    report.failure = { phase: report.current, name: error.name, message: error.message };
    await shot(`${report.current}-FAILED`).catch((error) => {
      report.captureFailure = error.message;
    });
  };
  return {
    report,
    visit,
    shot,
    metrics,
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

module.exports = async function inspectHostDeviceHistory({
  page,
  base,
  preferences,
  capture,
  widths = [1440, 768, 390, 320],
  modes = ['light', 'dark'],
  textScales = [1, 2],
  interactions = true,
  stateGroups = [
    { width: 1440, mode: 'light', scale: 1 },
    { width: 768, mode: 'dark', scale: 2 },
    { width: 390, mode: 'dark', scale: 1 },
    { width: 320, mode: 'light', scale: 2 },
    { width: 320, mode: 'dark', scale: 2 },
  ],
}) {
  const active = await session({ page, base, preferences, capture });
  const { report, visit, shot, metrics, setScenario, setHold, releases } = active;
  const root = page.locator('.host-device-history');
  const combo = root.getByRole('combobox', { name: 'Host device', exact: true });
  const rangeButton = (label) => root.getByRole('button', { name: label, exact: true });
  const focusClear = async () => {
    const focus = await dom.focusMetrics(page);
    report.pendingFocus = focus;
    assert.ok(focus.top >= focus.chromeBottom + 3 && focus.bottom <= focus.dockTop - 3, 'Full native focus marker clears sticky chrome and dock');
    assert.ok(!focus.outline.startsWith('0px') || focus.shadow !== 'none', 'Native keyboard focus marker is visible');
    delete report.pendingFocus;
    return focus;
  };
  const choose = async (index) => {
    await combo.focus();
    await page.keyboard.press('Space');
    await page.getByRole('listbox').waitFor();
    await page.keyboard.press('Home');
    const optionName = (position) => `${devices[position].kind === 'disk' ? 'Disk' : 'Network'} ${devices[position].name}`;
    await page.waitForFunction((name) => document.activeElement?.getAttribute('aria-label') === name, optionName(0));
    for (let position = 0; position < index; position++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction((name) => document.activeElement?.getAttribute('aria-label') === name, optionName(position + 1));
    }
    await page.keyboard.press('Enter');
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    await page.waitForFunction((expected) => new URL(location.href).searchParams.get('hostDevice') === expected, keyOf(devices[index]));
    await page.waitForFunction(
      (expected) => document.querySelector('.host-history-device [role=combobox]')?.title.endsWith(expected),
      devices[index].name,
    );
    await page.waitForFunction(() => document.querySelector('.host-device-history')?.getAttribute('aria-busy') === 'false');
    await dom.settle(page);
  };
  const inspectCharts = async (kind) => {
    const plots = root.getByRole('slider');
    assert.equal(await plots.count(), kind === 'disk' ? 3 : 2, 'Device kind has exactly its own chart fields');
    const keyboard = [];
    for (let index = 0; index < (await plots.count()); index++) {
      const plot = plots.nth(index);
      await plot.focus();
      const focused = await focusClear();
      const graph = await plot.locator('svg').boundingBox();
      await page.mouse.move(graph.x + 1, graph.y + graph.height / 2);
      await page.waitForFunction(
        (index) => Number(document.querySelectorAll('.host-device-history [role=slider]')[index]?.getAttribute('aria-valuenow')) === 0,
        index,
      );
      await page.mouse.move(graph.x + graph.width - 1, graph.y + graph.height / 2);
      await page.waitForFunction(
        (index) => Number(document.querySelectorAll('.host-device-history [role=slider]')[index]?.getAttribute('aria-valuenow')) === 9,
        index,
      );
      keyboard.push({ index, pointer: [0, 9], focus: focused });
      for (const [key, expected] of [
        ['Home', 0],
        ['End', 9],
        ['ArrowLeft', 8],
        ['ArrowRight', 9],
      ]) {
        await page.keyboard.press(key);
        assert.equal(Number(await plot.getAttribute('aria-valuenow')), expected, 'Native chart keys select exact samples');
        keyboard.push({ index, key, expected, value: await plot.getAttribute('aria-valuetext') });
      }
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      assert.match(await plot.getAttribute('aria-valuetext'), /Unavailable/);
      assert.equal(
        await plot.locator('..').locator('.metric-chart-tooltip strong').count(),
        0,
        'Missing samples do not become zero-valued inspection',
      );
      await page.keyboard.press('End');
    }
    const value = await metrics();
    verifyReadyValues(value, kind, keyboard);
    assert.ok(
      value.charts.every((chart) => chart.segments === 4),
      'Identity changes, null readings and collection gaps split four actual series',
    );
    return { keyboard, metrics: value };
  };
  try {
    report.provenance = { preview: base, controlledFixtures: true, widths, modes, textScales, stateGroups, interactions };
    for (const width of widths)
      for (const mode of modes)
        for (const scale of textScales) {
          await visit('ready', width, mode, 1);
          report.current = `${width}-${mode}-text${scale}-ocean-1h-layout`;
          await combo.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          assert.equal(await combo.evaluate((element) => element === document.activeElement), true);
          const selectorFocus = await focusClear();
          await page.keyboard.press('Space');
          await page.getByRole('listbox').waitFor();
          await scaleText(page, scale);
          const open = await metrics();
          assert.equal(await page.getByRole('option').count(), 4, 'Device menu includes every logical device');
          assert.equal(
            await page.getByRole('option', { name: `Network ${networkName}`, exact: true }).count(),
            1,
            'Long menu option has full accessible name',
          );
          await shot(`${report.current}-device-menu`);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => document.activeElement === document.querySelector('.host-history-device [role=combobox]'), null, {
            timeout: 2000,
          });
          assert.equal(await combo.evaluate((element) => element === document.activeElement), true, 'Settled menu close restores its opener');
          await wheelReveal(page, '.host-history-heading');
          const network = await inspectCharts('network');
          await shot(`${report.current}-network`);
          const networkInspection = await wheelReveal(page, '.host-history-chart:nth-child(2) .metric-chart-tooltip');
          await shot(`${report.current}-network-inspection`);
          await choose(2);
          assert.equal(new URL(page.url()).searchParams.get('range'), '1h', 'Choosing a device preserves time range');
          const disk = await inspectCharts('disk');
          await wheelReveal(page, '.host-history-chart:nth-child(3) h3');
          await shot(`${report.current}-disk`);
          const diskInspection = await wheelReveal(page, '.host-history-chart:nth-child(3) .metric-chart-tooltip');
          await shot(`${report.current}-disk-inspection`);
          await root.locator('.host-history-about summary').focus();
          await page.keyboard.press('Enter');
          assert.equal(await root.locator('.host-history-about').getAttribute('open'), '');
          const about = await metrics();
          const clearance = await wheelReveal(page, '.host-history-about p:last-child', true);
          await shot(`${report.current}-about`);
          report.layouts.push({
            width,
            mode,
            scale,
            open,
            selectorFocus,
            network,
            networkInspection,
            disk,
            diskInspection,
            about,
            clearance,
            passed: true,
          });
        }
    if (interactions) {
      await checkDefaultSelection(active, page);
      for (const group of stateGroups) {
        await visit('ready', group.width, group.mode, group.scale);
        await choose(2);
        for (const [range, label] of [
          ['5m', '5 min'],
          ['1h', '1 hour'],
          ['24h', '24 hours'],
          ['7d', '7 days'],
        ]) {
          await rangeButton(label).focus();
          await page.keyboard.press('Enter');
          await page.waitForFunction((range) => new URL(location.href).searchParams.get('range') === range, range);
          await page.waitForFunction(
            (label) => document.querySelector('.host-history-device-state')?.textContent.includes(label),
            range === '5m' ? 'Recent samples' : range === '1h' ? '1 min averages' : range === '24h' ? '5 min averages' : '30 min averages',
          );
          await page.waitForFunction(() => document.querySelector('.host-device-history')?.getAttribute('aria-busy') === 'false');
          assert.equal(await rangeButton(label).getAttribute('aria-pressed'), 'true');
          assert.equal(
            new URL(page.url()).searchParams.get('hostDevice'),
            keyOf(devices[2]),
            'Range selection preserves full device identifier in URL',
          );
          assert.equal(await root.locator('.host-history-chart').count(), 3, 'Range changes preserve disk chart fields');
          report.ranges.push({ ...group, range, metrics: await metrics() });
        }
        for (const variant of ['empty', 'unavailable', 'old-helper', 'storage', 'coverage', 'missing-device', 'null']) {
          await visit(variant, group.width, group.mode, group.scale);
          await wheelReveal(page, '.host-history-heading');
          const value = await metrics();
          if (['empty', 'unavailable', 'old-helper'].includes(variant)) {
            assert.equal(value.charts.length, 0);
            assert.equal(value.trigger.disabled, true);
          }
          if (variant === 'old-helper') assert.match(await root.textContent(), /3 devices lack a stable history identity/);
          if (variant === 'storage') assert.match(await root.textContent(), /storage is unavailable/);
          if (variant === 'coverage') assert.match(await root.textContent(), /4 additional devices[\s\S]*19 older device records/);
          if (variant === 'missing-device') assert.match(await root.textContent(), /Not currently reported · Last seen/);
          if (variant === 'null')
            assert.ok(
              value.charts.every((chart) => chart.segments === 0 && chart.empty.text.includes('Readings unavailable')),
              'Missing readings draw no phantom series',
            );
          await shot(`${report.current}-state`);
          report.states.push({ ...group, variant, metrics: value, passed: true });
        }
        let releaseLoading;
        setHold(
          new Promise((resolve) => {
            releaseLoading = resolve;
          }),
        );
        releases.push(releaseLoading);
        await visit('ready', group.width, group.mode, group.scale, { wait: false });
        await root.getByText('Loading device history…', { exact: true }).waitFor();
        await wheelReveal(page, '.host-history-heading');
        report.states.push({ ...group, variant: 'loading', metrics: await metrics(), passed: true });
        await shot(`${report.current}-loading`);
        releaseLoading();
        await page.waitForFunction(() => document.querySelectorAll('.host-history-chart').length === 2);
        await visit('error', group.width, group.mode, group.scale);
        const retry = root.getByRole('button', { name: 'Retry', exact: true });
        await retry.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        assert.equal(await retry.evaluate((element) => element === document.activeElement), true);
        const before = await dom.reading(page);
        const focused = await focusClear();
        const failed = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.status() === 503);
        void failed.catch(() => undefined);
        await page.keyboard.press('Enter');
        await failed;
        await retry.waitFor();
        await page.waitForFunction(() => !document.querySelector('.host-history-notice button')?.disabled);
        assert.equal(await retry.evaluate((element) => element === document.activeElement), true, 'Rejected retry retains focus');
        setScenario('ready');
        let release;
        setHold(
          new Promise((resolve) => {
            release = resolve;
          }),
        );
        releases.push(release);
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () =>
            document.querySelector('.host-device-history')?.getAttribute('aria-busy') === 'true' ||
            Boolean(document.querySelector('.host-history-notice button:disabled')),
        );
        const pending = await metrics();
        await shot(`${report.current}-retry-pending`);
        release();
        await root.locator('.host-history-notice').waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.activeElement?.id === 'host-device-history-title');
        const successFocus = await focusClear();
        report.retries.push({ ...group, before, after: await dom.reading(page), focused, pending, successFocus });
        await visit('ready', group.width, group.mode, group.scale, { range: '5m' });
        const plot = root.getByRole('slider').first();
        await plot.focus();
        await page.keyboard.press('End');
        await wheelReveal(page, '.host-history-chart:first-child .metric-chart-plot');
        await dom.settle(page);
        const readingBefore = await dom.reading(page);
        const initialAt = report.requests.at(-1).at;
        setScenario('refreshed');
        await page.waitForFunction(() => document.querySelector('.host-history-chart header output')?.textContent === '11.0 MB/s', null, {
          timeout: 14000,
        });
        await dom.settle(page);
        const readingAfter = await dom.reading(page);
        report.pendingRefresh = { ...group, before: readingBefore, after: readingAfter };
        assert.deepEqual(readingAfter, readingBefore, 'Timed history refresh preserves exact natural reading position');
        assert.equal(await plot.evaluate((element) => element === document.activeElement), true, 'Timed refresh retains chart focus');
        const interval = report.requests.at(-1).at - initialAt;
        assert.ok(interval >= 9000 && interval <= 13500, 'Recent history uses real ten-second polling');
        report.refresh.push({ ...group, before: readingBefore, after: readingAfter, interval, metrics: await metrics() });
        delete report.pendingRefresh;
      }
      await visit('error', 390, 'dark', 1);
      const retry = root.getByRole('button', { name: 'Retry', exact: true });
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
      await page.waitForFunction(
        () =>
          document.querySelector('.host-device-history')?.getAttribute('aria-busy') === 'true' ||
          Boolean(document.querySelector('.host-history-notice button:disabled')),
      );
      await rangeButton('7 days').focus();
      release();
      await root.locator('.host-history-notice').waitFor({ state: 'hidden' });
      assert.equal(
        await rangeButton('7 days').evaluate((element) => element === document.activeElement),
        true,
        'Successful retry never steals focus moved elsewhere',
      );
      report.focusAffinity = true;
      await visit('ready', 1440, 'dark', 1, { range: '5m' });
      await page.getByRole('button', { name: 'Minimize Monitor', exact: true }).click();
      await page.locator('.desktop-route-window').waitFor({ state: 'hidden' });
      const minimized = report.requests.length;
      await page.waitForTimeout(10600);
      assert.equal(report.requests.length, minimized, 'Minimized device history polling stops');
      await page.getByRole('button', { name: 'Restore Monitor', exact: true }).click();
      await root.waitFor();
      report.polling.push({ kind: 'minimized', reads: 0, duration: 10600 });
      await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
      const hidden = report.requests.length;
      await page.waitForTimeout(10600);
      assert.equal(report.requests.length, hidden, 'Hidden route device history polling stops');
      report.polling.push({ kind: 'hidden-route', reads: 0, duration: 10600 });
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    report.passed = true;
  } catch (error) {
    await active.failure(error);
  } finally {
    await active.finish();
  }
  return report;
};
module.exports.fixture = fixture;
module.exports.devices = devices;
module.exports.dom = { measure, check, wheelReveal, verifyReadyValues };

module.exports.contrast = async function inspectHostHistoryContrast({ page, base, preferences, capture }) {
  const active = await session({ page, base, preferences, capture });
  const { report, visit, shot } = active;
  report.samples = [];
  report.issues = [];
  try {
    for (const preset of ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'])
      for (const mode of ['light', 'dark']) {
        await visit('coverage', 1440, mode, 1, { preset });
        await page.locator('.host-history-about summary').click();
        await page.locator('.host-device-history [role=slider]').first().focus();
        await page.keyboard.press('End');
        const samples = await page.locator('.host-device-history').evaluate((root) => {
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
            const value = color
              .slice(0, 3)
              .map((channel) => channel / 255)
              .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
            return value[0] * 0.2126 + value[1] * 0.7152 + value[2] * 0.0722;
          };
          return [
            ['collection interval', '.host-history-state'],
            ['selected device state', '.host-history-device-state'],
            ['device kind', '.host-history-choice > span'],
            ['coverage', '.host-history-coverage'],
            ['about', '.host-history-about p'],
            ['axis', '.metric-chart-scale span'],
            ['axis time', '.metric-chart-times span'],
            ['inspection time', '.metric-chart-tooltip time'],
            ['inspection hint', '.metric-chart-tooltip small'],
          ].map(([family, selector]) => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--desktop-status-muted)';
            root.append(probe);
            const expected = rgba(getComputedStyle(probe).color);
            probe.remove();
            return {
              family,
              labels: [...root.querySelectorAll(selector)]
                .filter((element) => element.getClientRects().length)
                .map((element) => {
                  const foreground = rgba(getComputedStyle(element).color);
                  const layers = [];
                  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
                    const style = getComputedStyle(ancestor);
                    layers.push({
                      color: rgba(style.backgroundColor),
                      image: style.backgroundImage,
                      decorativeSelectArrow: ancestor.matches('.form-select') && style.backgroundImage.includes('data:image/svg+xml'),
                    });
                  }
                  const effective = [0, 255].map((bound) => {
                    let background = [bound, bound, bound, 255];
                    for (const layer of layers.toReversed()) {
                      background = over(layer.color, background);
                      if (layer.image !== 'none' && !layer.decorativeSelectArrow) background = [bound, bound, bound, 255];
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
        await wheelReveal(page, '.host-history-heading');
        await shot(`${preset}-${mode}-contrast`);
        report.samples.push({ preset, mode, samples });
      }
    assert.deepEqual(report.issues, []);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    report.minimum = Math.min(...report.samples.flatMap((sample) => sample.samples.flatMap((family) => family.labels.map((label) => label.minimum))));
    report.passed = true;
  } catch (error) {
    await active.failure(error);
  } finally {
    await active.finish();
  }
  return report;
};

async function anchorGeometry(page) {
  return page.evaluate(() => {
    const content = document.querySelector('.desktop-window-content');
    const offset = scrollY + (content?.scrollTop || 0);
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        documentTop: rect.top + offset,
        documentBottom: rect.bottom + offset,
      };
    };
    const root = document.querySelector('.host-device-history');
    const ink = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()]
        .filter((rect) => rect.width)
        .map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
    };
    return {
      offset,
      documentHeight: document.scrollingElement.scrollHeight,
      contentHeight: content?.scrollHeight || null,
      focused: box(document.activeElement),
      root: box(root),
      heading: box(root.querySelector('h2')),
      aggregate: [...document.querySelectorAll('.metric-chart')]
        .filter((chart) => !root.contains(chart))
        .map((chart) => ({
          metric: chart.dataset.metric,
          box: box(chart),
          times: [...chart.querySelectorAll('.metric-chart-times span')].map((time) => ({ text: time.textContent, box: box(time), ink: ink(time) })),
        })),
    };
  });
}

function checkAnchor(before, after, label) {
  assert.ok(
    Math.abs(after.focused.top - before.focused.top) <= 2 && Math.abs(after.focused.bottom - before.focused.bottom) <= 2,
    `${label}: focused control preserves its visual position`,
  );
  const geometryDelta = after.focused.documentTop - before.focused.documentTop;
  const scrollDelta = after.offset - before.offset;
  if (Math.abs(geometryDelta) <= 1) assert.ok(Math.abs(scrollDelta) <= 1, `${label}: unchanged upstream geometry preserves exact scroll`);
  else assert.ok(Math.abs(geometryDelta - scrollDelta) <= 2, `${label}: native scrolling compensates for actual upstream geometry change`);
}

module.exports.delayed = async function inspectDelayedHostHistory({ page, base, preferences, capture }) {
  const active = await session({ page, base, preferences, capture });
  const { report, visit, shot, setHold, releases } = active;
  report.delayed = [];
  const root = page.locator('.host-device-history');
  try {
    for (const group of [
      { width: 1440, mode: 'light', scale: 1 },
      { width: 320, mode: 'dark', scale: 2 },
    ]) {
      await visit('ready', group.width, group.mode, group.scale);
      const combo = root.getByRole('combobox', { name: 'Host device', exact: true });
      await combo.focus();
      await page.keyboard.press('Space');
      await page.getByRole('listbox').waitFor();
      await page.keyboard.press('Home');
      await page.waitForFunction((name) => document.activeElement?.getAttribute('aria-label') === name, `Network ${networkName}`);
      for (const name of [`Network ${devices[1].name}`, `Disk ${devices[2].name}`]) {
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction((name) => document.activeElement?.getAttribute('aria-label') === name, name);
      }
      const before = await dom.reading(page);
      let release;
      setHold(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      releases.push(release);
      const request = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === endpoint && url.searchParams.get('device') === keyOf(devices[2]);
      });
      await page.keyboard.press('Enter');
      await request;
      await page.getByRole('listbox').waitFor({ state: 'hidden' });
      await page.waitForTimeout(160);
      const pending = await root.evaluate((element) => ({
        focus: document.activeElement?.outerHTML.slice(0, 400),
        selectedDisabled: element.querySelector('[role=combobox]').disabled,
        charts: element.querySelectorAll('.host-history-chart').length,
        loading: element.textContent.includes('Loading selected history…'),
        curves: element.querySelectorAll('.host-history-chart polyline').length,
        focusedSelector: document.activeElement === element.querySelector('[role=combobox]'),
      }));
      report.delayed.push({ ...group, kind: 'device', before, after: await dom.reading(page), pending, metrics: await measure(page) });
      await shot(`${report.current}-delayed-device-pending`);
      assert.equal(pending.focusedSelector, true, 'Device loading must retain the native Select opener focus');
      assert.equal(pending.selectedDisabled, false, 'Device loading retains the existing catalogue and operable Select');
      assert.equal(pending.charts, 3, 'Device loading keeps requested disk chart frames mounted');
      assert.equal(pending.loading, true, 'Requested device visibly reports pending history');
      assert.equal(pending.curves, 0, 'Old device readings are not shown as the new device');
      release();
      await page.waitForFunction(
        () =>
          document.querySelectorAll('.host-history-chart').length === 3 &&
          document.querySelector('.host-device-history')?.getAttribute('aria-busy') === 'false',
      );
      assert.equal(await combo.evaluate((element) => element === document.activeElement), true, 'Device completion retains selector focus');
      const range = root.getByRole('button', { name: '7 days', exact: true });
      await range.focus();
      const rangeBeforeFocus = await dom.focusMetrics(page);
      const rangeBefore = await dom.reading(page);
      const rangeBeforeGeometry = await anchorGeometry(page);
      let releaseRange;
      setHold(
        new Promise((resolve) => {
          releaseRange = resolve;
        }),
      );
      releases.push(releaseRange);
      const rangeRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === endpoint && url.searchParams.get('range') === '7d';
      });
      await page.keyboard.press('Enter');
      await rangeRequest;
      await page.waitForTimeout(160);
      const rangePending = await root.evaluate((element) => ({
        charts: element.querySelectorAll('.host-history-chart').length,
        focusedRange: document.activeElement?.textContent === '7 days',
      }));
      const rangePendingGeometry = await anchorGeometry(page);
      report.delayed.push({
        ...group,
        kind: 'range',
        beforeFocus: rangeBeforeFocus,
        before: rangeBefore,
        after: await dom.reading(page),
        pending: rangePending,
        beforeGeometry: rangeBeforeGeometry,
        pendingGeometry: rangePendingGeometry,
      });
      await shot(`${report.current}-delayed-range-pending`);
      assert.equal(rangePending.focusedRange, true);
      assert.equal(rangePending.charts, 3, 'Range loading keeps previous charts mounted');
      checkAnchor(rangeBeforeGeometry, rangePendingGeometry, 'Pending range change');
      releaseRange();
      await page.waitForFunction(() => document.querySelector('.host-history-device-state')?.textContent.includes('30 min averages'));
      assert.equal(await range.evaluate((element) => element === document.activeElement), true);
      await dom.settle(page);
      const completeGeometry = await anchorGeometry(page);
      report.delayed.at(-1).completeGeometry = completeGeometry;
      checkAnchor(rangeBeforeGeometry, completeGeometry, 'Completed range change');
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    report.passed = true;
  } catch (error) {
    await active.failure(error);
  } finally {
    await active.finish();
  }
  return report;
};

async function checkDefaultSelection(active, page) {
  const { report, visit, setScenario, shot } = active;
  report.defaultSelection = [];
  for (const group of [
    { width: 1440, mode: 'light', scale: 1 },
    { width: 320, mode: 'dark', scale: 2 },
  ]) {
    const initialRequests = report.requests.length;
    await visit('ready', group.width, group.mode, group.scale, { range: '5m' });
    const selected = keyOf(devices[0]);
    await page.waitForFunction((value) => new URL(location.href).searchParams.get('hostDevice') === value, selected);
    assert.equal(report.requests.length - initialRequests, 1, 'Resolving default selection seeds its explicit query without another read');
    const plot = page.locator('.host-device-history [role=slider]').first();
    await plot.focus();
    await page.keyboard.press('End');
    await dom.focusMetrics(page);
    await wheelReveal(page, '.host-history-chart:first-child .metric-chart-plot');
    await dom.settle(page);
    const before = {
      reading: await dom.reading(page),
      geometry: await anchorGeometry(page),
      url: page.url(),
      selection: await page.locator('.host-history-device [role=combobox]').getAttribute('title'),
    };
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint, { timeout: 14000 });
    void response.catch(() => undefined);
    setScenario('catalogue-growth');
    const result = await (await response).json();
    assert.ok(
      result.devices.some((device) => device.name === 'aa0'),
      'Refreshed catalogue contains a newly earlier device',
    );
    assert.deepEqual(result.selected, devices[0], 'Pinned lookup keeps the same physical selection');
    await dom.settle(page);
    const after = {
      reading: await dom.reading(page),
      geometry: await anchorGeometry(page),
      url: page.url(),
      selection: await page.locator('.host-history-device [role=combobox]').getAttribute('title'),
    };
    const value = {
      ...group,
      before,
      after,
      request: report.requests.at(-1),
      selected: result.selected,
      catalogue: result.devices.map(keyOf),
      focusedPlot: await plot.evaluate((element) => element === document.activeElement),
    };
    report.defaultSelection.push(value);
    await shot(`${report.current}-catalogue-growth`);
    assert.equal(new URL(page.url()).searchParams.get('hostDevice'), selected, 'Catalogue growth never silently changes URL selection');
    assert.equal(after.selection, before.selection, 'Catalogue growth preserves the visible selected identifier');
    assert.equal(value.focusedPlot, true, 'Catalogue growth preserves the inspected chart focus');
    checkAnchor(before.geometry, after.geometry, 'Catalogue growth');
    assert.deepEqual(after.reading, before.reading, 'Catalogue-only growth preserves exact reading position');
  }
}
module.exports.selection = async function inspectPinnedHostSelection(options) {
  const active = await session(options);
  try {
    await checkDefaultSelection(active, options.page);
    assert.deepEqual(active.report.errors, []);
    assert.deepEqual(active.report.mutations, []);
    active.report.passed = true;
  } catch (error) {
    await active.failure(error);
  } finally {
    await active.finish();
  }
  return active.report;
};

module.exports.compactStates = async function inspectCompactHistoryStates(options) {
  const { page } = options;
  const active = await session(options);
  const { report, visit, shot, metrics, setHold, releases } = active;
  const root = page.locator('.host-device-history');
  try {
    for (const width of [390, 320])
      for (const mode of ['light', 'dark'])
        for (const scale of [1, 2]) {
          for (const variant of ['empty-range', 'null']) {
            await visit(variant, width, mode, scale);
            if (variant === 'null') {
              await root.getByRole('slider').first().focus();
              await page.keyboard.press('End');
              await dom.focusMetrics(page);
              assert.equal(await root.locator('.metric-chart-tooltip strong').count(), 0, 'Unavailable inspection has no invented number');
            }
            const value = await metrics();
            assert.equal(value.charts.length, 2);
            assert.ok(
              value.charts.every((chart) => chart.segments === 0 && chart.empty),
              'Unavailable or empty history has no phantom curve',
            );
            for (const chart of value.charts) {
              assert.ok(
                chart.empty.box.top >= chart.svg.top - 1 && chart.empty.box.bottom <= chart.svg.bottom + 1,
                'Empty message stays inside reserved plot area',
              );
              assert.ok(chart.empty.box.top >= chart.scale.bottom + 8, 'Empty message clears the range legend');
              for (const time of chart.times) assert.ok(time.box.top >= chart.empty.box.bottom + 8, 'Times clear the empty-state message');
            }
            await wheelReveal(page, '.host-history-chart:first-child .metric-chart-plot');
            await shot(`${report.current}-compact-state`);
            report.states.push({ width, mode, scale, variant, metrics: value, passed: true });
          }
          for (const selected of [false, true]) {
            let release;
            setHold(
              new Promise((resolve) => {
                release = resolve;
              }),
            );
            releases.push(release);
            await visit('ready', width, mode, scale, { selection: selected ? keyOf(devices[2]) : null, wait: false });
            await root
              .getByRole('status')
              .filter({ hasText: selected ? 'Loading selected history…' : 'Loading device history…' })
              .waitFor();
            assert.equal(
              await root.getByText('Loading device history…', { exact: true }).count(),
              selected ? 0 : 1,
              'Pending status is shown once for the relevant context',
            );
            const value = await metrics();
            if (selected) {
              assert.equal(value.charts.length, 3);
              assert.ok(
                value.charts.every((chart) => chart.segments === 0),
                'Pending selected target has only empty frames',
              );
              for (const chart of value.charts)
                assert.ok(chart.empty.text.includes('Loading history'), 'Each pending frame reports its own missing readings');
            } else assert.equal(value.charts.length, 0);
            await wheelReveal(page, '.host-history-heading');
            await shot(`${report.current}-${selected ? 'selected' : 'initial'}-compact-loading`);
            report.states.push({ width, mode, scale, variant: selected ? 'selected-loading' : 'initial-loading', metrics: value, passed: true });
            release();
            await page.waitForFunction(() => document.querySelector('.host-device-history')?.getAttribute('aria-busy') === 'false');
          }
        }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    report.passed = true;
  } catch (error) {
    await active.failure(error);
  } finally {
    await active.finish();
  }
  return report;
};

module.exports.narrow = async function inspectNarrowDesktopHistory(options) {
  const { page } = options;
  const active = await session(options);
  const { report, visit, shot, metrics } = active;
  report.windows = [];
  try {
    for (const mode of ['light', 'dark'])
      for (const scale of [1, 2]) {
        await visit('ready', 1440, mode, 1, { selection: keyOf(devices[2]) });
        await page.getByRole('button', { name: 'Window layout', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Floating window', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.desktop-route-window')?.dataset.windowMode === 'floating');
        await page.getByRole('button', { name: 'Resize Monitor', exact: true }).focus();
        await page.keyboard.press('Enter');
        await page.getByText('Resize: arrow keys', { exact: false }).waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'toolbar');
        for (let step = 0; step < 55; step++) await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('.desktop-window-keyboard-help'));
        assert.equal(
          Math.round((await page.locator('.desktop-route-window').boundingBox()).width),
          520,
          'Native keyboard resize reaches the supported narrow desktop width',
        );
        await scaleText(page, scale);
        await dom.settle(page);
        report.current = `1440-${mode}-text${scale}-520window-disk`;
        const plot = page.locator('.host-device-history [role=slider]').last();
        await plot.focus();
        await page.keyboard.press('Home');
        assert.equal(await plot.getAttribute('aria-valuenow'), '0');
        await page.keyboard.press('End');
        assert.equal(await plot.getAttribute('aria-valuenow'), '9');
        const focus = await dom.focusMetrics(page);
        assert.ok(focus.top >= focus.chromeBottom + 3 && focus.bottom <= focus.dockTop - 3, 'Narrow desktop chart focus clears both chrome edges');
        const value = await metrics();
        verifyReadyValues(value, 'disk');
        await wheelReveal(page, '.host-history-chart:nth-child(3) .metric-chart-tooltip');
        await shot(`${report.current}-inspection`);
        report.windows.push({
          mode,
          scale,
          frame: await page.locator('.desktop-route-window').boundingBox(),
          focus,
          metrics: value,
          reading: await dom.reading(page),
          passed: true,
        });
      }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    report.passed = true;
  } catch (error) {
    await active.failure(error);
  } finally {
    await active.finish();
  }
  return report;
};

module.exports.overview = async function captureHistoryOverview(options) {
  const { page } = options;
  const active = await session(options);
  try {
    await active.visit('ready', 1440, 'light', 1);
    await dom.wheelTo(page, '.host-device-history');
    const value = await active.metrics();
    const bounds = await page.locator('.host-device-history').evaluate((root) => {
      const rect = root.getBoundingClientRect();
      const content = root.closest('.desktop-window-content').getBoundingClientRect();
      const dock = document.querySelector('.desktop-dock').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, clipTop: content.top, clipBottom: Math.min(content.bottom, dock.top) };
    });
    assert.ok(bounds.top >= bounds.clipTop + 16 && bounds.bottom <= bounds.clipBottom - 16, 'Complete native overview clears the window and dock');
    assert.equal(value.charts.length, 2);
    assert.equal(await page.getByRole('listbox').count(), 0);
    await active.shot('1440-light-native-network-overview');
    active.report.overview = { metrics: value, bounds, reading: await dom.reading(page) };
    active.report.passed = true;
  } catch (error) {
    await active.failure(error);
  } finally {
    await active.finish();
  }
  return active.report;
};
