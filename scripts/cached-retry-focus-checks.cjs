const assert = require('node:assert/strict');
const { dom } = require('./host-devices-checks.cjs');

const surfaces = [
  {
    name: 'history',
    endpoint: '/api/system/host-history',
    root: '.host-device-history',
    heading: '#host-device-history-title',
    ready: '.host-history-chart',
    away: '.host-history-ranges button',
  },
  {
    name: 'devices',
    endpoint: '/api/system/host-telemetry',
    root: '.desktop-host-devices',
    heading: '#host-devices-title',
    ready: '.host-device',
    away: '.host-device-history-action',
  },
  {
    name: 'processes',
    endpoint: '/api/system/host-processes',
    root: '.host-processes',
    heading: '#host-processes-title',
    ready: '.host-process-list li',
    away: '.host-processes-sort button',
  },
];

function fixture(name) {
  const now = new Date().toISOString();
  if (name === 'devices')
    return {
      available: true,
      sampledAt: now,
      stale: false,
      filesystems: [],
      network: [
        {
          interface: 'eth0',
          historyId: 'a'.repeat(64),
          state: 'up',
          speedMbps: 1000,
          receivedBytes: 2048,
          transmittedBytes: 1024,
          rxBytesPerSecond: 200,
          txBytesPerSecond: 100,
        },
      ],
      disks: [],
      omitted: { filesystems: 0, network: 0, disks: 0 },
      unavailable: [],
    };
  if (name === 'processes') {
    const rows = [{ pid: 20, name: 'backup-worker', cpuPercent: 20, memoryBytes: 1024 ** 3 }];
    return {
      available: true,
      sampledAt: now,
      stale: false,
      scanned: 1,
      readable: 1,
      unreadable: 0,
      compared: 1,
      limited: false,
      byCpu: rows,
      byMemory: rows,
    };
  }
  const summary = { average: 100, peak: 100, samples: 1 };
  return {
    range: '5m',
    from: new Date(Date.now() - 300000).toISOString(),
    to: now,
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
    lastSampleAt: now,
    persistedThrough: now,
    devices: [{ kind: 'network', name: 'eth0', lastSeenAt: now, present: true }],
    selected: { kind: 'network', name: 'eth0' },
    points: [
      {
        at: now,
        until: now,
        intervalSeconds: 10,
        samples: 1,
        sourceId: 'a'.repeat(64),
        inbound: summary,
        outbound: summary,
        busy: { average: null, peak: null, samples: 0 },
      },
    ],
  };
}

async function refreshTextScale(page, scale) {
  if (scale === 1) return;
  await page.evaluate((scale) => {
    for (const [element, originals] of window.__hostDeviceTextOriginals || []) {
      for (const [name, value, priority] of originals) {
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
      }
    }
    const baseline = [...document.querySelectorAll('body,body *')]
      .filter((element) => element instanceof HTMLElement && !element.matches('script,style,link,meta'))
      .map((element) => ({
        element,
        font: Number.parseFloat(getComputedStyle(element).fontSize),
        line: getComputedStyle(element).lineHeight,
        originals: ['font-size', 'line-height'].map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
      }));
    window.__hostDeviceTextOriginals = baseline.map(({ element, originals }) => [element, originals]);
    for (const { element, font, line } of baseline) {
      if (Number.isFinite(font)) element.style.setProperty('font-size', `${font * scale}px`, 'important');
      if (line !== 'normal' && Number.isFinite(Number.parseFloat(line)))
        element.style.setProperty('line-height', `${Number.parseFloat(line) * scale}px`, 'important');
    }
  }, scale);
  await dom.settle(page);
}

module.exports = async function inspectCachedRetryFocus({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.port === '8080', 'Only static8080 source fixtures are permitted');
  const viewport = page.viewportSize();
  const report = {
    passed: false,
    cases: [],
    failures: [],
    requests: [],
    errors: [],
    mutations: [],
    preferencePuts: 0,
    cleanup: {},
    cleanupFailures: [],
    provenance: { controlledFixtures: true, base, textStress: 'computed font/line-height doubled without changing root size' },
  };
  let shadow = structuredClone(preferences);
  let target = null;
  let phase = 'ready';
  let hold = null;
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
    const surface = surfaces.find((item) => item.endpoint === url.pathname);
    if (!surface) return route.fallback();
    const failed = surface.name === target && phase === 'error';
    report.requests.push({ surface: surface.name, status: failed ? 503 : 200, at: Date.now() });
    if (surface.name === target && hold) {
      const pending = hold;
      hold = null;
      await pending;
    }
    return route.fulfill({
      status: failed ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(failed ? { message: 'Controlled cached read failure' } : fixture(surface.name)),
    });
  };
  await page.route('**/api/**', handler);
  const record = (condition, message, metrics) => {
    if (!condition) report.failures.push({ phase: report.current, message, metrics });
    return Boolean(condition);
  };
  const shot = (suffix) => capture(`cached-retry-${report.current}-${suffix}`, { scrollTop: false, fullPage: false });
  const keyboardFocus = async (control) => {
    await control.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await dom.focusMetrics(page);
    assert.equal(await control.evaluate((element) => element === document.activeElement), true, 'Native keyboard traversal reaches Retry');
  };
  const gate = () => {
    let release;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    releases.push(release);
    return release;
  };
  const response = (surface, status) =>
    page.waitForResponse((value) => new URL(value.url()).pathname === surface.endpoint && value.status() === status, { timeout: 14000 });
  const visibility = (metrics) => metrics.top >= metrics.chromeBottom + 3 && metrics.bottom <= metrics.dockTop - 3;
  try {
    for (const group of [
      { width: 1440, height: 1120, mode: 'light', scale: 1 },
      { width: 320, height: 800, mode: 'dark', scale: 2 },
    ]) {
      for (const surface of surfaces) {
        report.current = `${surface.name}-${group.width}-${group.mode}-text${group.scale}`;
        target = surface.name;
        phase = 'ready';
        shadow = { ...structuredClone(preferences), mode: group.mode, preset: 'ocean', windows: {} };
        await page.setViewportSize({ width: group.width, height: group.height });
        await page.goto(`${base}/monitor?range=5m`, { waitUntil: 'domcontentloaded' });
        const root = page.locator(surface.root);
        const ready = root.locator(surface.ready);
        await ready.first().waitFor();
        await dom.settle(page);
        await refreshTextScale(page, group.scale);
        const rowCount = await ready.count();
        phase = 'error';
        const firstFailure = response(surface, 503);
        await firstFailure;
        const retry = root.getByRole('button', { name: 'Retry', exact: true });
        await retry.waitFor();
        await refreshTextScale(page, group.scale);
        assert.equal(await ready.count(), rowCount, 'A failed refresh retains the successful rendered data');
        await keyboardFocus(retry);
        const before = await dom.focusMetrics(page);
        const beforeVisible = record(visibility(before), 'Keyboard Retry remains fully visible below sticky chrome and above the dock', before);
        const rejectedResponse = response(surface, 503);
        const reject = gate();
        await page.keyboard.press('Enter');
        await root.getByRole('button', { name: 'Checking…', exact: true }).waitFor();
        reject();
        await rejectedResponse;
        await retry.waitFor();
        await page.waitForFunction((selector) => !document.querySelector(`${selector} button:disabled`), surface.root);
        const rejectedFocus = await dom.focusMetrics(page);
        const rejectedRetained = record(
          await retry.evaluate((element) => element === document.activeElement),
          'Rejected retry with cached data must retain the surviving Retry',
          rejectedFocus,
        );
        const rejectedVisible = record(visibility(rejectedFocus), 'Rejected retry retains a fully visible focus target', rejectedFocus);
        await shot('rejected');
        phase = 'ready';
        await keyboardFocus(retry);
        const successResponse = response(surface, 200);
        const succeed = gate();
        await page.keyboard.press('Enter');
        await root.getByRole('button', { name: 'Checking…', exact: true }).waitFor();
        succeed();
        await successResponse;
        await retry.waitFor({ state: 'hidden' });
        const successFocus = await dom.focusMetrics(page);
        const successHeading = record(
          await root.locator(surface.heading).evaluate((element) => element === document.activeElement),
          'Successful retry returns removed-opener focus to its surviving heading',
          successFocus,
        );
        const successVisible = record(
          visibility(successFocus),
          'Successful retry reveals the complete focused heading above the dock and below sticky chrome',
          successFocus,
        );
        await shot('success');
        phase = 'error';
        await response(surface, 503);
        await retry.waitFor();
        await refreshTextScale(page, group.scale);
        await keyboardFocus(retry);
        phase = 'ready';
        const movedResponse = response(surface, 200);
        const complete = gate();
        await page.keyboard.press('Enter');
        await root.getByRole('button', { name: 'Checking…', exact: true }).waitFor();
        const away = root.locator(surface.away).first();
        await away.focus();
        await dom.focusMetrics(page);
        complete();
        await movedResponse;
        await retry.waitFor({ state: 'hidden' });
        const movedFocus = await dom.focusMetrics(page);
        const noSteal = record(
          await away.evaluate((element) => element === document.activeElement),
          'Retry completion must not steal focus moved elsewhere',
          movedFocus,
        );
        await shot('moved-away');
        report.cases.push({
          surface: surface.name,
          ...group,
          rowCount,
          before,
          beforeVisible,
          rejectedRetained,
          rejectedVisible,
          rejectedFocus,
          successHeading,
          successVisible,
          successFocus,
          noSteal,
          movedFocus,
        });
      }
    }
    report.passed = report.cases.length === 6 && report.failures.length === 0 && report.errors.length === 0 && report.mutations.length === 0;
  } catch (error) {
    report.failure = { phase: report.current, name: error.name, message: error.message };
    await shot('FAILED').catch((captureError) => {
      report.captureFailure = captureError.message;
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
