const assert = require('node:assert/strict');

const endpoint = '/api/system/host-telemetry';
const fixture = (variant = 'ready') => {
  if (variant === 'collecting') return { available: false, reason: 'Collecting host readings.' };
  if (variant === 'unavailable')
    return { available: false, reason: 'The Orbis host service is not connected. Check the host service and try again.' };
  const value = {
    available: true,
    sampledAt: '2026-10-18T08:24:10.000Z',
    stale: variant === 'stale',
    filesystems: [
      {
        mount: '/mnt/archive/family-media/photographs-and-documents',
        filesystem: 'btrfs',
        sizeBytes: 8796093022208,
        usedBytes: 2199023255552,
        availableBytes: 6597069766656,
        readOnly: false,
      },
      {
        mount: '/srv/backups/secondary-vault',
        filesystem: 'ext4',
        sizeBytes: 1099511627776,
        usedBytes: 274877906944,
        availableBytes: 824633720832,
        readOnly: true,
      },
    ],
    network: [
      {
        interface: 'enp193s0f0np0.4094-storage-replication-bond',
        state: 'up',
        speedMbps: 100000,
        receivedBytes: 1099511627776,
        transmittedBytes: 549755813888,
        rxBytesPerSecond: 12582912,
        txBytesPerSecond: 524288,
      },
      {
        interface: 'br-secondary-backup-network',
        state: 'down',
        speedMbps: null,
        receivedBytes: 0,
        transmittedBytes: 0,
        rxBytesPerSecond: 0,
        txBytesPerSecond: 0,
      },
      {
        interface: 'tun-home-services',
        state: 'unknown',
        speedMbps: null,
        receivedBytes: null,
        transmittedBytes: null,
        rxBytesPerSecond: null,
        txBytesPerSecond: null,
      },
    ],
    disks: [
      {
        device: 'nvme0n1',
        readBytes: 1099511627776,
        writtenBytes: 549755813888,
        readBytesPerSecond: 2097152,
        writeBytesPerSecond: 1048576,
        busyPercent: 12.5,
        inFlight: 1234,
      },
      {
        device: 'dm-production-backup-mirror',
        readBytes: 0,
        writtenBytes: 0,
        readBytesPerSecond: 0,
        writeBytesPerSecond: 0,
        busyPercent: 0,
        inFlight: 0,
      },
    ],
    omitted: { filesystems: 0, network: 0, disks: 0 },
    unavailable: [],
  };
  if (variant === 'first-sample') {
    for (const item of value.network) item.rxBytesPerSecond = item.txBytesPerSecond = null;
    for (const item of value.disks) item.readBytesPerSecond = item.writeBytesPerSecond = item.busyPercent = null;
  }
  if (variant === 'partial') {
    value.network = [];
    value.unavailable = ['network'];
  }
  if (variant === 'omitted') value.omitted = { filesystems: 2, network: 3, disks: 1 };
  if (variant === 'empty') value.filesystems = value.network = value.disks = [];
  if (variant === 'refreshed') value.network[0].rxBytesPerSecond = 25165824;
  return value;
};

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.effect.getComputedTiming().endTime < 4000)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.waitForTimeout(160);
}

async function scaleText(page, factor) {
  if (factor === 1) return;
  await page.evaluate((factor) => {
    const values = [...document.querySelectorAll('body,body *')]
      .filter((element) => element instanceof HTMLElement && !element.matches('script,style,link,meta'))
      .map((element) => ({
        element,
        font: Number.parseFloat(getComputedStyle(element).fontSize),
        line: getComputedStyle(element).lineHeight,
        original: ['font-size', 'line-height'].map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
      }));
    window.__hostDeviceTextOriginals = values.map(({ element, original }) => [element, original]);
    for (const { element, font, line } of values) {
      if (Number.isFinite(font)) element.style.setProperty('font-size', `${font * factor}px`, 'important');
      if (line !== 'normal') element.style.setProperty('line-height', `${Number.parseFloat(line) * factor}px`, 'important');
    }
  }, factor);
  await settle(page);
}

async function restoreText(page) {
  await page.evaluate(() => {
    for (const [element, original] of window.__hostDeviceTextOriginals || [])
      for (const [name, value, priority] of original) {
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
      }
    delete window.__hostDeviceTextOriginals;
  });
}

async function settleScroll(page) {
  await page.evaluate(async () => {
    let previous = '';
    let stable = 0;
    for (let attempt = 0; attempt < 35; attempt++) {
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 70)));
      const element = document.activeElement;
      const rect = element.getBoundingClientRect();
      const value = [scrollY, document.querySelector('.desktop-window-content')?.scrollTop || 0, rect.top, rect.bottom]
        .map((item) => Math.round(item * 10))
        .join(',');
      stable = previous === value ? stable + 1 : 0;
      if (stable >= 3) return;
      previous = value;
    }
    throw new Error('Native focus scrolling did not settle');
  });
}

async function wheelTo(page, selector) {
  for (let attempt = 0; attempt < 65; attempt++) {
    const geometry = await page
      .locator(selector)
      .first()
      .evaluate((element) => {
        const r = element.getBoundingClientRect();
        const bar = document.querySelector('.desktop-system-bar').getBoundingClientRect();
        const dock = document.querySelector('.desktop-dock').getBoundingClientRect();
        const frame = element.closest('.desktop-route-window');
        const header = frame?.querySelector('.desktop-window-bar').getBoundingClientRect();
        const top = Math.max(bar.bottom, frame?.dataset.windowNavigation === 'desktop' ? header.bottom : 0) + 24;
        return { target: r.top, top, dock: dock.top, x: Math.min(innerWidth - 50, Math.max(80, r.left + 70)), y: Math.min(dock.top - 45, top + 150) };
      });
    if (geometry.target >= geometry.top - 3 && geometry.target < geometry.top + 90) {
      await settleScroll(page);
      const top = await page
        .locator(selector)
        .first()
        .evaluate((element) => element.getBoundingClientRect().top);
      if (top >= geometry.top - 3 && top < geometry.top + 90) return;
      continue;
    }
    await page.mouse.move(geometry.x, geometry.y);
    await page.mouse.wheel(0, Math.max(-900, Math.min(900, geometry.target - geometry.top)));
    await page.waitForTimeout(90);
  }
  throw new Error('Native wheel could not reveal the requested host-device section');
}

async function reading(page) {
  return page.evaluate(() => ({
    x: scrollX,
    y: scrollY,
    frame: document.querySelector('.desktop-route-window')?.scrollTop || 0,
    content: document.querySelector('.desktop-window-content')?.scrollTop || 0,
  }));
}

async function inspect(page) {
  return page.locator('.desktop-host-devices').evaluate((root) => {
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const ink = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].filter((r) => r.width > 0).map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
    };
    const words = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement.closest('svg,time,[aria-hidden="true"]') || !node.parentElement.getClientRects().length) continue;
      for (const match of node.textContent.matchAll(/[A-Za-z][A-Za-z'-]{2,}/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        const identifier = node.parentElement.closest('.host-device-identifier');
        const ordinary =
          !identifier ||
          /^(archive|family|media|photographs|documents|backups|secondary|vault|storage|replication|bond|backup|network|home|services|production|mirror)$/i.test(
            match[0],
          );
        if (ordinary && new Set(rects.map((r) => Math.round(r.top))).size > 1) {
          const style = getComputedStyle(node.parentElement);
          const context = document.createElement('canvas').getContext('2d');
          context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          words.push({
            text: match[0],
            reason: 'ordinary-word-fracture',
            naturalWidth: context.measureText(match[0]).width,
            available: node.parentElement.clientWidth,
            font: context.font,
            identifier: identifier?.textContent,
          });
        }
      }
    }
    const chrome = (element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        blur: style.backdropFilter,
        shadow: style.boxShadow,
        borders: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
      };
    };
    const frame = root.closest('.desktop-route-window');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      root: box(root),
      monitor: box(root.closest('.desktop-monitor')),
      inner: {
        left: box(root).left + Number.parseFloat(getComputedStyle(root).paddingLeft) + Number.parseFloat(getComputedStyle(root).borderLeftWidth),
        right: box(root).right - Number.parseFloat(getComputedStyle(root).paddingRight) - Number.parseFloat(getComputedStyle(root).borderRightWidth),
      },
      peerHeading: box(root.closest('.desktop-telemetry-grid').querySelector(':scope > section > h2')),
      heading: box(root.querySelector('h2')),
      state: { text: root.querySelector('.host-devices-state').textContent, box: box(root.querySelector('.host-devices-state')) },
      words,
      sections: [...root.querySelectorAll('.host-device-sections > section')].map((section) => ({
        title: section.querySelector('h3').textContent,
        box: box(section),
        heading: box(section.querySelector('h3')),
        cards: [...section.querySelectorAll('.host-device')].map((card) => ({
          box: box(card),
          padding: Number.parseFloat(getComputedStyle(card).paddingLeft),
          identifier: {
            text: card.querySelector('h4').textContent,
            title: card.querySelector('h4').title,
            ink: ink(card.querySelector('h4')),
            segmentCount: card.querySelectorAll('.host-device-segment').length,
            ellipses: [card.querySelector('h4'), ...card.querySelectorAll('h4 *')]
              .filter((element) => getComputedStyle(element).textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + 1)
              .map((element) => ({
                box: box(element),
                text: element.textContent,
                title: element.title,
                singleLine: getComputedStyle(element).whiteSpace === 'nowrap',
                overflowX: getComputedStyle(element).overflowX,
                textOverflow: getComputedStyle(element).textOverflow,
              })),
          },
          link: card.querySelector('.host-device-link')
            ? { box: box(card.querySelector('.host-device-link')), text: card.querySelector('.host-device-link').textContent }
            : null,
          facts: [...card.querySelectorAll('.host-device-facts > div')].map((fact) => ({
            box: box(fact),
            label: fact.querySelector('dt').textContent,
            value: fact.querySelector('dd').textContent,
            labelInk: ink(fact.querySelector('dt')),
            valueInk: ink(fact.querySelector('dd')),
            overflow: fact.querySelector('dd').scrollWidth > fact.querySelector('dd').clientWidth + 1,
          })),
        })),
      })),
      notice: root.querySelector('.host-devices-notice')
        ? {
            text: root.querySelector('.host-devices-notice p').textContent,
            button: root.querySelector('.host-devices-notice button').textContent,
            box: box(root.querySelector('.host-devices-notice')),
            buttonBox: box(root.querySelector('.host-devices-notice button')),
          }
        : null,
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
  const near = (left, right, message) => assert.ok(Math.abs(left - right) <= 1, message);
  assert.ok(metrics.documentWidth <= metrics.viewport.width + 1, 'Host devices must not cause document overflow');
  assert.deepEqual(metrics.words, [], 'Ordinary host-device words must remain complete');
  near(metrics.root.left, metrics.monitor.left, 'Host devices must use the Monitor content gutter');
  near(metrics.root.right, metrics.monitor.right, 'Host-device right edge must align with Monitor');
  near(metrics.heading.left, metrics.inner.left, 'Host-devices heading must use the card content gutter');
  near(metrics.heading.left, metrics.peerHeading.left, 'Host-devices and CPU headings must share the intended card gutter');
  if (metrics.sections.length) {
    near(metrics.sections[0].box.left, metrics.inner.left, 'Device columns start at the heading gutter');
    near(Math.max(...metrics.sections.map((section) => section.box.right)), metrics.inner.right, 'Device columns fill the padded content width');
  }
  const sameHeadingRow = Math.min(metrics.heading.bottom, metrics.state.box.bottom) > Math.max(metrics.heading.top, metrics.state.box.top);
  if (sameHeadingRow) assert.ok(metrics.state.box.left >= metrics.heading.right + 12, 'Host heading and update label need meaningful separation');
  for (const section of metrics.sections) {
    near(section.heading.left, section.box.left, 'Device category heading and body must align');
    for (const card of section.cards) {
      near(card.box.left, section.box.left, 'Device card left edge must align');
      near(card.box.right, section.box.right, 'Device card right edge must align');
      assert.ok(card.padding >= 16, 'Device facts need comfortable card padding');
      assert.equal(card.identifier.title, card.identifier.text, 'Long identifiers must retain full accessible text');
      assert.ok(card.identifier.segmentCount <= 32, 'Path markup must remain bounded');
      for (const ellipse of card.identifier.ellipses) {
        assert.ok(
          ellipse.singleLine &&
            ['hidden', 'clip'].includes(ellipse.overflowX) &&
            ellipse.textOverflow === 'ellipsis' &&
            ellipse.text &&
            (ellipse.title === ellipse.text || card.identifier.title.includes(ellipse.text)),
          'A clipped identifier segment must have full accessible text',
        );
        assert.ok(
          ellipse.box.left >= card.box.left + 16 && ellipse.box.right <= card.box.right - 16,
          'Identifier ellipsis must remain inside card padding',
        );
      }
      for (const rect of card.identifier.ink) {
        const bounded = rect.left >= card.box.left + 16 && rect.right <= card.box.right - 16;
        const accessibleEllipsis = card.identifier.ellipses.some(
          (ellipse) =>
            rect.top < ellipse.box.bottom && rect.bottom > ellipse.box.top && rect.left >= ellipse.box.left - 1 && rect.left <= ellipse.box.right + 1,
        );
        assert.ok(bounded || accessibleEllipsis, 'Identifier ink must clear card edges unless deliberately ellipsized with full accessible text');
      }
      if (card.link)
        assert.ok(
          card.link.box.left >= card.box.left + 16 && card.link.box.right <= card.box.right - 16,
          'Network link status must clear card edges',
        );
      for (const fact of card.facts) {
        assert.equal(fact.overflow, false, 'Complete host values must fit their own fact cell');
        assert.ok(new Set(fact.valueInk.map((r) => Math.round(r.top))).size <= 1, 'Numeric values and units must remain together');
        for (const rect of [...fact.labelInk, ...fact.valueInk])
          assert.ok(
            rect.left >= card.box.left + 16 && rect.right <= card.box.right - 16 && rect.right <= fact.box.right + 1,
            'Facts must retain interior edge and column clearance',
          );
        const lastLabel = Math.max(...fact.labelInk.map((r) => r.bottom));
        assert.ok(Math.min(...fact.valueInk.map((r) => r.top)) - lastLabel >= 4, 'Fact labels and values must not crowd');
      }
    }
  }
  for (const chrome of [metrics.chrome.bar, metrics.chrome.dock]) {
    assert.equal(chrome.blur, 'blur(28px) saturate(1.45)', 'System bar and dock must retain matching glass');
    assert.ok(chrome.background.startsWith('rgba(') && !chrome.background.endsWith(', 1)'), 'Chrome must remain translucent');
    assert.ok(chrome.borders.every((color) => color === 'rgba(0, 0, 0, 0)') && !chrome.shadow.includes('inset'), 'No bright chrome rims');
  }
  if (metrics.chrome.navigation === 'desktop') {
    assert.equal(metrics.chrome.header.blur, metrics.chrome.dock.blur);
    assert.equal(metrics.chrome.frame.background, 'rgba(0, 0, 0, 0)');
    assert.ok(
      metrics.chrome.frame.borders.every((color) => color === 'rgba(0, 0, 0, 0)') && !metrics.chrome.frame.shadow.includes('inset'),
      'No bright tool-frame rims',
    );
  }
}

async function focusMetrics(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(250);
  await settleScroll(page);
  return page.evaluate(() => {
    const element = document.activeElement;
    const r = element.getBoundingClientRect();
    const frame = element.closest('.desktop-route-window');
    const top = Math.max(
      document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
      frame?.dataset.windowNavigation === 'desktop' ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0,
    );
    const style = getComputedStyle(element);
    return {
      tag: element.tagName,
      owner: element.closest('.desktop-host-devices') ? 'host-devices' : element.closest('.desktop-route-window') ? 'tool' : 'outside',
      frameMode: frame?.dataset.windowNavigation,
      desktopQuery: matchMedia('(min-width: 1100px) and (min-height: 640px)').matches,
      documentScroll: {
        scrollHeight: document.scrollingElement.scrollHeight,
        clientHeight: document.scrollingElement.clientHeight,
        scrollTop: document.scrollingElement.scrollTop,
        maxScroll: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight,
      },
      expectedRevealDelta:
        r.top < top + 8
          ? r.top - top - 8
          : r.bottom > document.querySelector('.desktop-dock').getBoundingClientRect().top - 8
            ? r.bottom - document.querySelector('.desktop-dock').getBoundingClientRect().top + 8
            : 0,
      text: element.textContent.trim(),
      scroll: { y: scrollY, content: document.querySelector('.desktop-window-content')?.scrollTop || 0 },
      top: r.top,
      bottom: r.bottom,
      documentTop: r.top + scrollY,
      chromeBottom: top,
      dockTop: document.querySelector('.desktop-dock').getBoundingClientRect().top,
      outline: style.outline,
      shadow: style.boxShadow,
    };
  });
}

async function cleanupFixture(report, page, handler, onError, viewport) {
  report.cleanup = { routesRestored: false, textRestored: false, viewportRestored: false, listenersRestored: false };
  report.cleanupFailures = [];
  const attempt = async (name, operation) => {
    try {
      await operation();
      report.cleanup[name] = true;
    } catch (error) {
      report.cleanupFailures.push({ operation: name, name: error.name, message: error.message });
      report.passed = false;
    }
  };
  await attempt('textRestored', () => restoreText(page));
  await attempt('routesRestored', () => page.unroute('**/api/**', handler));
  await attempt('listenersRestored', async () => {
    page.off('pageerror', onError);
    assert.equal(page.listeners('pageerror').includes(onError), false);
  });
  await attempt('viewportRestored', () => page.setViewportSize(viewport));
}

module.exports = async function inspectHostDevices({
  page,
  base,
  preferences,
  capture,
  widths = [1440, 768, 390, 320],
  modes = ['light', 'dark'],
  textScales = [1, 2],
  stateVariants = ['first-sample', 'stale', 'partial', 'omitted', 'empty', 'unavailable', 'error'],
  refresh = true,
  stateGroups = [
    { width: 1440, mode: 'light', scale: 1 },
    { width: 768, mode: 'dark', scale: 2 },
    { width: 390, mode: 'dark', scale: 1 },
    { width: 320, mode: 'light', scale: 2 },
    { width: 320, mode: 'dark', scale: 2 },
  ],
}) {
  const origin = new URL(base);
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.port === '8080',
    'Only the static8080 source fixture preview is permitted',
  );
  const originalViewport = page.viewportSize();
  let shadow = structuredClone(preferences);
  let scenario = 'ready';
  let hold;
  const releases = [];
  const report = {
    passed: false,
    layouts: [],
    states: [],
    refresh: [],
    collecting: [],
    focusAffinity: [],
    requests: [],
    preferencePuts: 0,
    mutations: [],
    errors: [],
    cleanup: {},
  };
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
    const requestedScenario = scenario;
    report.requests.push({ scenario: requestedScenario, at: Date.now() });
    if (hold) {
      const gate = hold;
      hold = undefined;
      await gate;
    }
    return route.fulfill({
      status: requestedScenario === 'error' ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(requestedScenario === 'error' ? { message: 'Controlled host-device read failure' } : fixture(requestedScenario)),
    });
  };
  await page.route('**/api/**', handler);
  const shot = (name) => capture(`host-devices-${name}`, { scrollTop: false, fullPage: false });
  const visit = async (variant, width, mode, scale) => {
    scenario = variant;
    report.current = `${width}-${mode}-text${scale}-${variant}`;
    shadow = { ...structuredClone(preferences), mode, preset: 'ocean', windows: {} };
    await page.setViewportSize({ width, height: width === 1440 ? 1120 : width === 768 ? 1024 : width === 390 ? 844 : 800 });
    await page.goto(`${base}/monitor`, { waitUntil: 'domcontentloaded' });
    await page.locator(`.desktop[data-desktop-mode="${mode}"] .desktop-host-devices`).waitFor();
    await page.locator('.desktop-host-devices').getByRole('status').filter({ hasText: 'Loading host devices' }).waitFor({ state: 'hidden' });
    await page.locator(['unavailable', 'error', 'collecting'].includes(variant) ? '.host-devices-notice' : '.host-device-sections').waitFor();
    await settle(page);
    await scaleText(page, scale);
  };
  const verifyReady = async (variant) => {
    const value = fixture(variant);
    const identifiers = [
      ...value.filesystems.map((item) => item.mount),
      ...value.network.map((item) => item.interface),
      ...value.disks.map((item) => item.device),
    ];
    assert.deepEqual(await page.locator('.host-device-identifier').allTextContents(), identifiers, 'All long host identifiers must be complete');
    for (const [label, expected] of [
      ['Mounted filesystems', value.filesystems.length],
      ['Network interfaces', value.network.length],
      ['Disk activity', value.disks.length],
    ])
      assert.equal(
        await page
          .locator('.host-device-sections > section')
          .filter({ has: page.getByRole('heading', { name: label, exact: true }) })
          .locator('.host-device')
          .count(),
        expected,
      );
    if (variant === 'ready')
      for (const expected of ['2.0 TB', '8.0 TB', '6.0 TB', '12 MB/s', '512 KB/s', '12.5%', '1,234'])
        assert.ok(
          (await page.locator('.host-device-facts dd').allTextContents()).includes(expected),
          `Complete expected value ${expected} is required`,
        );
  };
  try {
    for (const width of widths)
      for (const mode of modes)
        for (const textScale of textScales) {
          await visit('ready', width, mode, textScale);
          await verifyReady('ready');
          await wheelTo(page, '.host-devices-heading');
          const metrics = await inspect(page);
          report.pending = metrics;
          check(metrics);
          await wheelTo(page, '.host-devices-heading');
          await shot(`${report.current}-heading`);
          await wheelTo(page, '#host-network-title');
          await shot(`${report.current}-network`);
          await wheelTo(page, '#host-disk-activity-title');
          await shot(`${report.current}-disks`);
          report.layouts.push({ width, mode, textScale, metrics, nativeScroll: await reading(page), passed: true });
          delete report.pending;
        }
    for (const group of stateGroups) {
      for (const variant of stateVariants) {
        await visit(variant, group.width, group.mode, group.scale);
        if (!['unavailable', 'error'].includes(variant)) await verifyReady(variant);
        if (variant === 'first-sample')
          assert.ok(
            (await page.locator('.host-device-facts dd').allTextContents()).filter((value) => value === 'Unavailable').length >= 8,
            'First rates must remain honestly unavailable',
          );
        if (variant === 'stale') {
          await page.getByText('Readings delayed', { exact: true }).waitFor();
          await page.locator('.host-devices-stale time').waitFor();
        }
        if (variant === 'partial') {
          await page.getByText('No network interface readings available.', { exact: true }).waitFor();
          await page.getByText('Some readings are unavailable.', { exact: true }).waitFor();
        }
        if (variant === 'omitted')
          for (const count of [2, 3, 1])
            await page.getByText(`${count} additional ${count === 1 ? 'item is' : 'items are'} not shown.`, { exact: true }).waitFor();
        if (variant === 'empty')
          for (const label of [
            'No mounted filesystem readings available.',
            'No network interface readings available.',
            'No disk activity readings available.',
          ])
            await page.getByText(label, { exact: true }).waitFor();
        const metrics = await inspect(page);
        report.pending = metrics;
        check(metrics);
        await wheelTo(page, '.host-devices-heading');
        const state = { ...group, variant, metrics, passed: true };
        if (['unavailable', 'error'].includes(variant)) {
          const retry = page.locator('.host-devices-notice').getByRole('button', { name: 'Retry', exact: true });
          await retry.waitFor();
          await retry.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          assert.equal(await retry.evaluate((element) => element === document.activeElement), true, 'Native Tab must return to Retry');
          state.focus = await focusMetrics(page);
          report.pendingFocus = state.focus;
          assert.ok(
            state.focus.top >= state.focus.chromeBottom + 3 && state.focus.bottom <= state.focus.dockTop - 3,
            'Retry focus must clear chrome',
          );
          await shot(`${report.current}`);
          if (variant === 'error') {
            scenario = 'error';
            const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.status() === 503);
            void rejected.catch(() => undefined);
            await page.keyboard.press('Enter');
            await rejected;
            await page.waitForFunction(() => {
              const button = document.querySelector('.host-devices-notice button');
              return button && !button.disabled;
            });
            await page.waitForTimeout(260);
            assert.equal(
              await retry.evaluate((element) => element === document.activeElement),
              true,
              'A rejected Retry must restore the retained Retry control',
            );
            state.rejectedRetry = await focusMetrics(page);
            assert.ok(
              state.rejectedRetry.top >= state.rejectedRetry.chromeBottom + 3 && state.rejectedRetry.bottom <= state.rejectedRetry.dockTop - 3,
              'A rejected Retry must keep its full focus marker clear of chrome',
            );
          }
          scenario = 'ready';
          const before = await reading(page);
          const beforeHeading = await page.locator('#host-devices-title').evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const frame = element.closest('.desktop-route-window');
            const top = Math.max(
              document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
              frame.dataset.windowNavigation === 'desktop' ? frame.querySelector('.desktop-window-bar').getBoundingClientRect().bottom : 0,
            );
            return {
              top: rect.top,
              bottom: rect.bottom,
              chromeBottom: top,
              dockTop: document.querySelector('.desktop-dock').getBoundingClientRect().top,
              documentTop: rect.top + scrollY,
              scrollPaddingTop: Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0,
              scrollPaddingBottom: Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0,
              scrollMarginTop: Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0,
              scrollMarginBottom: Number.parseFloat(getComputedStyle(element).scrollMarginBottom) || 0,
              viewportHeight: innerHeight,
            };
          });
          let release;
          hold = new Promise((resolve) => {
            release = resolve;
          });
          releases.push(release);
          const checked = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.ok());
          void checked.catch(() => undefined);
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => {
            const root = document.querySelector('.desktop-host-devices');
            const button = root.querySelector('.host-devices-notice button');
            return (
              (button?.disabled && button.textContent.includes('Checking')) ||
              [...root.querySelectorAll('output')].some((element) => element.textContent.includes('Loading host devices'))
            );
          });
          state.pending = await page.locator('.desktop-host-devices').evaluate((root) => ({
            checking: Boolean(root.querySelector('.host-devices-notice button:disabled')),
            loading: [...root.querySelectorAll('output')].some((element) => element.textContent.includes('Loading host devices')),
          }));
          assert.ok(state.pending.checking || state.pending.loading, 'Retry must expose an honest pending state');
          release();
          await checked;
          await page.locator('.host-devices-notice').waitFor({ state: 'hidden' });
          await verifyReady('ready');
          await settle(page);
          state.retry = {
            before,
            beforeHeading,
            after: await reading(page),
            active: await page.evaluate(() => ({
              tag: document.activeElement.tagName,
              insideTool: Boolean(document.activeElement.closest('.desktop-route-window')),
            })),
          };
          state.retry.focus = await focusMetrics(page);
          report.pendingRetry = state.retry;
          const headingWasVisible = beforeHeading.top >= beforeHeading.chromeBottom + 8 && beforeHeading.bottom <= beforeHeading.dockTop - 8;
          if (headingWasVisible)
            assert.deepEqual(state.retry.after, before, 'Retry must preserve reading position when its surviving target is visible');
          else {
            const correction = state.retry.after.y - before.y;
            const top = Math.max(beforeHeading.chromeBottom + 8, beforeHeading.scrollPaddingTop + beforeHeading.scrollMarginTop);
            const bottom = Math.min(
              beforeHeading.dockTop - 8,
              beforeHeading.viewportHeight - beforeHeading.scrollPaddingBottom - beforeHeading.scrollMarginBottom,
            );
            const above = beforeHeading.top < top;
            const minimum = above ? beforeHeading.top - top : beforeHeading.bottom - bottom;
            assert.ok(above ? correction < 0 : correction > 0, 'Retry must reveal its surviving target in the required direction');
            assert.ok(Math.abs(correction - minimum) <= 1, 'Retry focus reveal must match the minimum padded chrome-clearance correction');
            assert.ok(
              Math.abs(state.retry.focus.documentTop - beforeHeading.documentTop) <= 1,
              'Retry must preserve the surviving heading document position',
            );
            assert.equal(state.retry.after.x, before.x);
            assert.equal(state.retry.after.frame, before.frame);
            assert.equal(state.retry.after.content, before.content);
            state.retry.requiredFocusReveal = { correction, minimum, top, bottom };
          }
          assert.ok(state.retry.active.insideTool, 'A completed Retry must retain focus on a surviving tool target');
          assert.ok(
            state.retry.focus.top >= state.retry.focus.chromeBottom + 3 && state.retry.focus.bottom <= state.retry.focus.dockTop - 3,
            'Surviving Retry focus must clear fixed chrome',
          );
          assert.ok(
            !state.retry.focus.outline.startsWith('0px') || state.retry.focus.shadow !== 'none',
            'Surviving Retry focus needs a visible marker',
          );
        } else await shot(`${report.current}`);
        report.states.push(state);
        delete report.pendingRetry;
        delete report.pending;
      }
      if (!refresh) continue;
      await visit('collecting', group.width, group.mode, group.scale);
      await page.getByText('Collecting host readings.', { exact: true }).waitFor();
      const collectingAt = report.requests.at(-1).at;
      scenario = 'ready';
      await page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.ok(), { timeout: 6000 });
      await page.locator('.host-device-identifier').first().waitFor();
      await verifyReady('ready');
      const collectedAfter = report.requests.at(-1).at - collectingAt;
      assert.ok(collectedAfter >= 1500 && collectedAfter <= 5000, 'Initial collecting response must use the bounded2-second poll');
      report.collecting.push({ ...group, collectedAfter, passed: true });
      // Wait for actual production polling, without clock replacement or direct query manipulation.
      await visit('ready', group.width, group.mode, group.scale);
      await wheelTo(page, '#host-network-title');
      const before = await reading(page);
      const sampled = report.requests.length;
      scenario = 'refreshed';
      await page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.ok(), { timeout: 15000 });
      await page.getByText('24 MB/s', { exact: true }).waitFor();
      await settle(page);
      const after = await reading(page);
      assert.deepEqual(after, before, 'Automatic host refresh must preserve actual native scroll');
      report.refresh.push({ ...group, requests: report.requests.length - sampled, before, after, passed: true });
    }
    if (stateGroups.length) {
      await visit('unavailable', 1440, 'light', 1);
      const retry = page.locator('.host-devices-notice button');
      await retry.focus();
      let release;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      releases.push(release);
      scenario = 'ready';
      const returned = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.ok());
      void returned.catch(() => undefined);
      await page.keyboard.press('Enter');
      await page.locator('.host-devices-notice button').filter({ hasText: 'Checking…' }).waitFor();
      const other = page.locator('.desktop-mode-toggle');
      await other.focus();
      release();
      await returned;
      await page.locator('.host-devices-notice').waitFor({ state: 'hidden' });
      await settle(page);
      assert.equal(
        await other.evaluate((element) => element === document.activeElement),
        true,
        'Retry completion must not steal deliberately moved focus',
      );
      report.focusAffinity.push({ movedToHeader: true, retainedOnCompletion: true, passed: true });
    }
    assert.equal(report.layouts.length, widths.length * modes.length * textScales.length);
    assert.equal(report.states.length, stateGroups.length * stateVariants.length);
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.failure = { phase: report.current, name: error.name, message: error.message };
    await shot(`failure-${report.current}`).catch(() => undefined);
    if (report.pending?.words?.length) {
      for (const ordinal of [1, 2]) {
        await wheelTo(page, `.host-device-sections > section:first-child .host-device:nth-child(${ordinal})`).catch(() => undefined);
        await shot(`failure-${report.current}-mount${ordinal}`).catch(() => undefined);
      }
    }
  } finally {
    for (const release of releases) release();
    await cleanupFixture(report, page, handler, onError, originalViewport);
  }
  return report;
};
module.exports.fixture = fixture;
module.exports.dom = { inspect, check, scaleText, restoreText, wheelTo, reading, settle, focusMetrics };

module.exports.contrast = async function inspectHostDeviceContrast({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.ok(
    ['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8080',
    'Host-device palette checks require isolated8080 fixtures',
  );
  const originalViewport = page.viewportSize();
  const report = { passed: false, samples: [], fallbackCopy: null, mutations: [], errors: [], issues: [], cleanup: {} };
  let shadow;
  let fallback = false;
  const host = fixture('stale');
  host.omitted = { filesystems: 2, network: 3, disks: 1 };
  host.unavailable = ['filesystems', 'network', 'disks'];
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) return route.abort('blockedbyclient');
    const respond = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/desktop-preferences') {
      if (request.method() === 'PUT') shadow = request.postDataJSON();
      return respond(shadow);
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === endpoint) return respond(host);
    if (fallback && url.pathname === '/api/system/telemetry')
      return respond({
        sampledAt: '2026-10-18T08:24:10.000Z',
        cpu: { scope: 'runtime', totalPercent: 15.2, perCorePercent: [], uptimeSeconds: 345600 },
        memory: { scope: 'host-proc', totalBytes: 8589934592, availableBytes: 4294967296, swapTotalBytes: 0, swapFreeBytes: 0 },
        filesystems: [],
        network: [],
      });
    return route.fallback();
  };
  const onError = (error) => report.errors.push({ name: error.name, message: error.message });
  page.on('pageerror', onError);
  await page.route('**/api/**', handler);
  try {
    await page.setViewportSize({ width: 1440, height: 1120 });
    for (const preset of ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'])
      for (const mode of ['light', 'dark']) {
        report.current = `${preset}-${mode}`;
        shadow = { ...structuredClone(preferences), mode, preset, windows: {} };
        await page.goto(`${base}/monitor`, { waitUntil: 'domcontentloaded' });
        await page.locator(`.desktop[data-desktop-mode="${mode}"][data-desktop-preset="${preset}"] .host-devices-stale`).waitFor();
        await settle(page);
        const samples = await page.locator('.desktop-monitor').evaluate((root) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          const rgba = (color) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
          };
          const over = (foreground, behind) => {
            const alpha = foreground[3] / 255;
            const behindAlpha = behind[3] / 255;
            const combined = alpha + behindAlpha * (1 - alpha);
            return [
              ...foreground.slice(0, 3).map((channel, index) => (channel * alpha + behind[index] * behindAlpha * (1 - alpha)) / combined),
              combined * 255,
            ];
          };
          const luminance = (color) => {
            const values = color.slice(0, 3).map((channel) => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
          };
          const tokens = {};
          for (const token of ['--desktop-status-muted', '--desktop-warning']) {
            const probe = document.createElement('span');
            probe.style.cssText = `position:absolute;visibility:hidden;color:var(${token})`;
            root.append(probe);
            tokens[token] = rgba(getComputedStyle(probe).color);
            probe.remove();
          }
          const families = [
            ['fact label', '.host-device-facts dt', '--desktop-status-muted'],
            ['filesystem kind', '.host-device-kind', '--desktop-status-muted'],
            ['network link', '.host-device-link', '--desktop-status-muted'],
            ['coverage', '.host-device-coverage', '--desktop-status-muted'],
            ['footnote', '.host-device-footnote', '--desktop-status-muted'],
            ['stale timestamp', '.host-devices-stale', '--desktop-warning'],
            ['delayed status', '.host-devices-state[data-stale="true"]', '--desktop-warning'],
            ['chart axis', '.metric-chart-scale span', '--desktop-status-muted'],
            ['chart timestamps', '.metric-chart-times span', '--desktop-status-muted'],
          ];
          return families.map(([family, selector, token]) => ({
            family,
            selector,
            token,
            labels: [...root.querySelectorAll(selector)].map((element) => {
              const style = getComputedStyle(element);
              const foreground = rgba(style.color);
              const layers = [];
              for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
                const ancestorStyle = getComputedStyle(ancestor);
                layers.push({ className: ancestor.className, color: rgba(ancestorStyle.backgroundColor), image: ancestorStyle.backgroundImage });
              }
              const effective = [0, 255].map((bound) => {
                let background = [bound, bound, bound, 255];
                for (const layer of layers.toReversed()) {
                  background = over(layer.color, background);
                  if (layer.image !== 'none') background = [bound, bound, bound, 255];
                }
                const text = over(foreground, background);
                const ratio = (Math.max(luminance(text), luminance(background)) + 0.05) / (Math.min(luminance(text), luminance(background)) + 0.05);
                return { unknownWallpaperBound: bound, backgroundRGBA: background, foregroundRGBA: text, ratio };
              });
              return {
                text: element.textContent.trim(),
                color: style.color,
                foregroundRGBA: foreground,
                expectedTokenRGBA: tokens[token],
                fontSize: style.fontSize,
                layers,
                effective,
                minimum: Math.min(...effective.map((entry) => entry.ratio)),
              };
            }),
          }));
        });
        for (const family of samples) {
          if (!family.labels.length) report.issues.push({ preset, mode, family: family.family, reason: 'missing-label-family' });
          for (const label of family.labels) {
            if (!label.foregroundRGBA.every((channel, index) => channel === label.expectedTokenRGBA[index]))
              report.issues.push({
                preset,
                mode,
                family: family.family,
                text: label.text,
                reason: 'theme-token-mismatch',
                computed: label.foregroundRGBA,
                expected: label.expectedTokenRGBA,
              });
            if (label.minimum < 4.5)
              report.issues.push({
                preset,
                mode,
                family: family.family,
                text: label.text,
                reason: 'small-label-contrast',
                minimum: label.minimum,
                foreground: label.foregroundRGBA,
                effective: label.effective,
              });
          }
        }
        await wheelTo(page, '.host-devices-heading');
        await capture(`host-devices-palette-${preset}-${mode}-heading`, { scrollTop: false, fullPage: false });
        await wheelTo(page, '#host-network-title');
        await capture(`host-devices-palette-${preset}-${mode}-network`, { scrollTop: false, fullPage: false });
        report.samples.push({
          preset,
          mode,
          samples,
          minimum: Math.min(...samples.flatMap((family) => family.labels.map((label) => label.minimum))),
        });
      }
    report.current = '320-dark-text2-runtime-cpu-copy';
    fallback = true;
    shadow = { ...structuredClone(preferences), mode: 'dark', preset: 'ocean', windows: {} };
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${base}/monitor`, { waitUntil: 'domcontentloaded' });
    await page.locator('.desktop-host-overview-readings').getByText('Core CPU', { exact: true }).waitFor();
    await settle(page);
    await scaleText(page, 2);
    const scope = await page.locator('.desktop-monitor-scope').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const words = [];
      const node = element.firstChild;
      for (const match of node.textContent.matchAll(/[A-Za-z]{2,}/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        if (new Set([...range.getClientRects()].filter((r) => r.width).map((r) => Math.round(r.top))).size > 1) words.push(match[0]);
      }
      return {
        text: element.textContent,
        words,
        left: rect.left,
        right: rect.right,
        monitorLeft: element.closest('.desktop-monitor').getBoundingClientRect().left,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
      };
    });
    assert.equal(scope.text, 'History charts show CPU, host memory and Orbis core network traffic.');
    assert.deepEqual(scope.words, [], 'Runtime CPU scope copy must retain whole words');
    assert.ok(
      Math.abs(scope.left - scope.monitorLeft) <= 1 && scope.right <= scope.viewportWidth && scope.documentWidth <= scope.viewportWidth,
      'Narrow scope copy must retain its gutter and bounds',
    );
    await capture('host-devices-runtime-cpu-scope-320-dark-text2', { scrollTop: false, fullPage: false });
    report.fallbackCopy = { ...scope, passed: true };
    assert.equal(report.samples.length, 12);
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.errors, []);
    report.passed = report.issues.length === 0;
  } catch (error) {
    report.failure = { phase: report.current, name: error.name, message: error.message };
    await capture(`host-devices-palette-failure-${report.current}`, { scrollTop: false, fullPage: false }).catch(() => undefined);
  } finally {
    await cleanupFixture(report, page, handler, onError, originalViewport);
  }
  return report;
};

module.exports.charts = async function inspectHostDeviceCharts({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.port === '8080', 'Charts use isolated8080 source fixtures only');
  const originalViewport = page.viewportSize();
  const report = { passed: false, samples: [], extraStates: [], errors: [], mutations: [], cleanup: {} };
  let shadow;
  let scenario = 'normal';
  const onError = (error) => report.errors.push({ name: error.name, message: error.message });
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) return route.abort('blockedbyclient');
    const respond = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/desktop-preferences') {
      if (request.method() === 'PUT') shadow = request.postDataJSON();
      return respond(shadow);
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ path: url.pathname, method: request.method() });
      return route.abort('blockedbyclient');
    }
    if (scenario !== 'normal' && url.pathname === '/api/system/history') {
      const now = Date.now();
      const missing = { average: null, peak: null, samples: 0 };
      return respond({
        range: '1h',
        from: new Date(now - 3600000).toISOString(),
        to: new Date(now).toISOString(),
        resolutionSeconds: 60,
        sampledEverySeconds: 10,
        retentionDays: 7,
        storage: 'persistent',
        collectorAvailable: true,
        lastSampleAt: new Date(now).toISOString(),
        persistedThrough: new Date(now).toISOString(),
        points:
          scenario === 'empty'
            ? []
            : [
                {
                  at: new Date(now - 60000).toISOString(),
                  until: new Date(now - 10000).toISOString(),
                  intervalSeconds: 60,
                  samples: 0,
                  cpuScope: 'host-proc',
                  cpu: missing,
                  memory: missing,
                  download: missing,
                  upload: missing,
                },
              ],
      });
    }
    return route.fallback();
  };
  page.on('pageerror', onError);
  await page.route('**/api/**', handler);
  const measure = (chart) => {
    const box = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const ink = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].filter((r) => r.width).map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
    };
    const words = [];
    const walker = document.createTreeWalker(chart, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement.getClientRects().length || node.parentElement.closest('svg')) continue;
      for (const match of node.textContent.matchAll(/[A-Za-z]{2,}/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        if (new Set([...range.getClientRects()].filter((r) => r.width).map((r) => Math.round(r.top))).size > 1) words.push(match[0]);
      }
    }
    const tooltip = chart.querySelector('.metric-chart-tooltip');
    const empty = chart.querySelector('.metric-chart-empty');
    return {
      scrollY,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      chart: box(chart),
      next: box(chart.nextElementSibling),
      plot: box(chart.querySelector('.metric-chart-plot')),
      svg: box(chart.querySelector('svg')),
      scaleBox: box(chart.querySelector('.metric-chart-scale')),
      labels: [...chart.querySelectorAll('.metric-chart-scale span')].map((element) => ({
        text: element.textContent,
        box: box(element),
        ink: ink(element),
        font: getComputedStyle(element).fontSize,
      })),
      times: [...chart.querySelectorAll('.metric-chart-times span')]
        .filter((element) => element.getClientRects().length)
        .map((element) => ({ text: element.textContent, box: box(element), ink: ink(element) })),
      tooltip: tooltip
        ? {
            text: tooltip.textContent,
            box: box(tooltip),
            ink: ink(tooltip),
            position: getComputedStyle(tooltip).position,
            children: [...tooltip.children].map((element) => ({
              text: element.textContent,
              box: box(element),
              ink: ink(element),
              font: getComputedStyle(element).fontSize,
            })),
          }
        : null,
      empty: empty ? { text: empty.textContent, box: box(empty), ink: ink(empty) } : null,
      historySegments: chart.querySelectorAll('[data-history-segment], svg circle').length,
      words,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    };
  };
  const checkChart = (metrics) => {
    assert.equal(metrics.scrollBehavior, 'auto');
    assert.ok(metrics.documentWidth <= metrics.viewportWidth, 'Chart must not overflow the document');
    assert.deepEqual(metrics.words, [], 'Chart labels and inspection text must retain whole ordinary words');
    for (const label of metrics.labels) {
      assert.ok(new Set(label.ink.map((r) => Math.round(r.top))).size === 1, 'Axis values must remain on one readable line');
      for (const rect of label.ink) {
        assert.ok(
          rect.left >= metrics.scaleBox.left - 1 && rect.right <= metrics.scaleBox.right + 1,
          'Complete axis ink must fit its intrinsic column',
        );
        assert.ok(rect.right <= metrics.svg.left - 8, 'Axis ink must retain a comfortable graph gap');
      }
    }
    assert.ok(metrics.svg.width >= 40, 'Intrinsic axis must leave a usable graph width');
    for (const time of metrics.times)
      for (const rect of time.ink)
        assert.ok(rect.left >= metrics.plot.left + 10 && rect.right <= metrics.plot.right - 10, 'Timestamps must fit the plot gutter');
    if (metrics.tooltip) {
      const panel = metrics.tooltip;
      assert.ok(
        panel.box.top >= metrics.plot.bottom + 8 && panel.box.bottom <= metrics.chart.bottom + 1,
        'Inspection must flow below the plot inside the chart',
      );
      assert.ok(panel.box.left >= metrics.chart.left && panel.box.right <= metrics.chart.right, 'Inspection must fit the chart width');
      assert.ok(!['absolute', 'fixed'].includes(panel.position), 'Inspection must reserve flow height');
      if (metrics.next) assert.ok(metrics.next.top >= panel.box.bottom + 8, 'Following content must clear the entire inspection panel');
      for (const child of panel.children)
        for (const rect of child.ink)
          assert.ok(
            rect.left >= panel.box.left + 12 &&
              rect.right <= panel.box.right - 12 &&
              rect.top >= panel.box.top + 10 &&
              rect.bottom <= panel.box.bottom - 10,
            'Inspection text must retain full inner padding',
          );
    }
    if (metrics.empty)
      for (const rect of metrics.empty.ink)
        assert.ok(
          rect.left >= metrics.empty.box.left + 10 && rect.right <= metrics.empty.box.right - 10,
          'Empty-history message must retain readable padding',
        );
  };
  const visit = async (width, textScale, metric, state) => {
    scenario = state;
    report.current = `${width}-dark-text${textScale}-${metric}-${state}`;
    shadow = { ...structuredClone(preferences), mode: 'dark', preset: 'ocean', windows: {} };
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 800 });
    await page.goto(`${base}/monitor`, { waitUntil: 'domcontentloaded' });
    const selector = `.metric-chart[data-metric="${metric}"]`;
    const chart = page.locator(selector).first();
    const plot = chart.locator('.metric-chart-plot');
    await chart.waitFor();
    await settle(page);
    if (state !== 'empty') {
      await plot.focus();
      await chart.locator('.metric-chart-tooltip').waitFor();
    }
    await scaleText(page, textScale);
    const keyboard = [];
    if (state === 'normal') {
      const maximum = Number(await plot.getAttribute('aria-valuemax'));
      for (const [key, expected] of [
        ['Home', 0],
        ['End', maximum],
        ['ArrowLeft', maximum - 1],
        ['ArrowRight', maximum],
      ]) {
        await page.keyboard.press(key);
        assert.equal(Number(await plot.getAttribute('aria-valuenow')), expected, 'Native history keys must select the expected sample');
        keyboard.push({ key, selected: expected, accessibleValue: await plot.getAttribute('aria-valuetext') });
      }
    }
    await wheelTo(page, `${selector} .metric-chart-plot`);
    const metrics = await chart.evaluate(measure);
    report.pending = metrics;
    checkChart(metrics);
    if (state === 'empty') {
      assert.equal(metrics.empty.text, 'No samples recorded in this range');
      assert.equal(metrics.tooltip, null);
      assert.equal(metrics.historySegments, 0, 'Empty history must not draw phantom data');
    }
    if (state === 'null') {
      assert.ok(
        metrics.tooltip.children.some((child) => child.text === 'Unavailable' && child.font === '24px'),
        'Missing selected value must use regular doubled inspection text',
      );
      assert.equal(await chart.locator('.metric-chart-tooltip strong').count(), 0);
      assert.equal(metrics.historySegments, 0, 'Missing history must not draw phantom data');
    }
    await capture(`host-chart-${report.current}-plot`, { scrollTop: false, fullPage: false });
    if (state !== 'empty') {
      await wheelTo(page, `${selector} .metric-chart-tooltip`);
      await capture(`host-chart-${report.current}-inspection`, { scrollTop: false, fullPage: false });
    }
    delete report.pending;
    return { width, textScale, metric, state, keyboard, metrics, passed: true };
  };
  try {
    for (const width of [768, 320])
      for (const textScale of [1, 2]) for (const metric of ['cpu', 'memory']) report.samples.push(await visit(width, textScale, metric, 'normal'));
    for (const state of ['empty', 'null']) report.extraStates.push(await visit(320, 2, 'cpu', state));
    assert.equal(report.samples.length, 8);
    assert.equal(report.extraStates.length, 2);
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.failure = { phase: report.current, name: error.name, message: error.message };
    await capture(`host-chart-failure-${report.current}`, { scrollTop: false, fullPage: false }).catch(() => undefined);
  } finally {
    await cleanupFixture(report, page, handler, onError, originalViewport);
  }
  return report;
};
