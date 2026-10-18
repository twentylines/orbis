const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dom, fixture: deviceFixture } = require('./host-devices-checks.cjs');
const { fixture: processFixture } = require('./host-processes-checks.cjs');
const { fixture: sensorFixture } = require('./host-sensors-checks.cjs');
const { fixture: historyFixture } = require('./host-device-history-checks.cjs');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const endpoint = '/api/system/host-processes';
const selector = '.host-processes-sort button:first-of-type';

async function restoreText(page) {
  await page.evaluate(() => {
    const state = window.__orbisMonitorClampTextScale;
    if (!state) return;
    state.observer.disconnect();
    for (const [element, value] of state.entries)
      for (const [name, original, priority] of value.original) {
        if (original) element.style.setProperty(name, original, priority);
        else element.style.removeProperty(name);
      }
    delete window.__orbisMonitorClampTextScale;
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
    window.__orbisMonitorClampTextScale = { factor, entries, observer };
  }, factor);
  await dom.settle(page);
}

async function snapshot(page) {
  return page.locator(selector).evaluate((target) => {
    const frame = target.closest('.desktop-route-window');
    const content = frame.querySelector('.desktop-window-content');
    const desktop = frame.dataset.windowNavigation === 'desktop';
    const scroller = desktop ? content : document.scrollingElement;
    const bounds = content.getBoundingClientRect();
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
        contentTop: r.top + scroller.scrollTop - (desktop ? bounds.top : 0),
      };
    };
    const outline = getComputedStyle(target);
    const extent =
      outline.outlineStyle === 'none' ? 0 : Number.parseFloat(outline.outlineWidth) + Math.max(0, Number.parseFloat(outline.outlineOffset));
    const clip = {
      top: Math.max(document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom, desktop ? bounds.top : 0),
      bottom: Math.min(document.querySelector('.desktop-dock').getBoundingClientRect().top, desktop ? bounds.bottom : innerHeight),
    };
    const targetBox = box(target);
    return {
      at: Date.now(),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      navigation: frame.dataset.windowNavigation,
      rawScroll: { x: scrollX, y: scrollY, content: content.scrollTop, frame: frame.scrollTop },
      scroller: {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        maxScroll: scroller.scrollHeight - scroller.clientHeight,
        atEnd: Math.abs(scroller.scrollTop - scroller.scrollHeight + scroller.clientHeight) <= 1,
        overflowAnchor: getComputedStyle(scroller).overflowAnchor,
      },
      target: targetBox,
      clip,
      frame: box(frame),
      content: box(content),
      focus: {
        same: document.activeElement === target,
        visible: target.matches(':focus-visible'),
        extent,
        top: targetBox.top - extent,
        bottom: targetBox.bottom + extent,
        label: target.textContent.trim(),
      },
      rows: document.querySelectorAll('.host-process-list li').length,
      processes: box(document.querySelector('.host-processes')),
      sensors: box(document.querySelector('.host-sensors')),
      sections: [...document.querySelector('.desktop-monitor').children].map((element) => ({ classes: String(element.className), ...box(element) })),
      position: {
        beforeRows: Boolean(target.compareDocumentPosition(document.querySelector('.host-process-list')) & Node.DOCUMENT_POSITION_FOLLOWING),
        documentScrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      },
    };
  });
}
async function processData(page) {
  return page.locator('.host-processes').evaluate((root) => ({
    state: root.querySelector('.host-processes-state').textContent.trim(),
    timestamp: root.querySelector('.host-processes-stale time')?.dateTime || null,
    notice: root.querySelector('.host-processes-stale')?.textContent.trim() || null,
    coverage: [...root.querySelectorAll('.host-processes-coverage')].map((element) => element.textContent.trim()),
    rows: [...root.querySelectorAll('.host-process-list li')].map((row) => ({
      pid: Number(row.dataset.processPid),
      name: row.querySelector('bdi').textContent,
      cpu: row.querySelectorAll('dd')[0].textContent,
      memory: row.querySelectorAll('dd')[1].textContent,
    })),
  }));
}
function checkFocus(value) {
  assert.ok(value.focus.same && value.focus.visible, 'The CPU sort control must retain native keyboard focus');
  assert.ok(
    value.focus.top >= value.clip.top && value.focus.bottom <= value.clip.bottom,
    'The complete actual focus marker must remain inside chrome/scroll clipping',
  );
}
async function prepare(page) {
  for (let attempt = 0; attempt < 70; attempt++) {
    const state = await snapshot(page);
    const goal = state.clip.top + 16;
    if (state.target.top >= goal - 1 && state.target.top <= goal + 8) break;
    await page.mouse.move(Math.min(state.viewport.width - 40, state.target.left + 50), Math.min(state.clip.bottom - 30, state.clip.top + 100));
    await page.mouse.wheel(0, Math.max(-800, Math.min(800, state.target.top - goal)));
    await page.waitForTimeout(90);
    if (attempt === 69) throw new Error('Native wheel did not place CPU sort above its long list');
  }
  await page.locator(selector).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await dom.settle(page);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(250);
  const value = await snapshot(page);
  checkFocus(value);
  assert.equal(value.rows, 20, 'The pre-update CPU list must contain exactly20 actual rendered fixture rows');
  assert.equal(value.position.beforeRows, true, 'Focused sort must precede its shrinking list');
  assert.ok(value.target.top <= value.clip.top + 32, 'Near-top reading position must match the published R2 setup');
  return value;
}
async function prepareWarmupCapture(page) {
  for (let attempt = 0; attempt < 55; attempt++) {
    const state = await snapshot(page);
    const fitting = state.processes.height <= state.clip.bottom - state.clip.top - 32;
    const target = fitting ? state.processes : state.target;
    if (target.top >= state.clip.top + 16 && target.bottom <= state.clip.bottom - 16) return;
    const delta = target.top < state.clip.top + 16 ? target.top - state.clip.top - 16 : target.bottom - state.clip.bottom + 16;
    await page.mouse.move(Math.min(state.viewport.width - 40, target.left + 45), Math.min(state.clip.bottom - 30, state.clip.top + 100));
    await page.mouse.wheel(0, Math.max(-800, Math.min(800, delta)));
    await page.waitForTimeout(90);
  }
  throw new Error('Native wheel could not reveal initial warmup reading');
}
module.exports = async function inspectMonitorClamp({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.ok(
    ['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8080' && ['http:'].includes(origin.protocol),
    'Only isolated static8080 source fixtures are allowed',
  );
  const originalViewport = page.viewportSize();
  const report = {
    passed: false,
    cases: [],
    errors: [],
    mutations: [],
    external: [],
    requests: [],
    preferenceShadowWrites: 0,
    cleanup: {},
    cleanupFailures: [],
    provenance: {
      controlledFixtures: true,
      source: 'Compiled static8080 only; no actual homelab reads, cookies or API writes.',
      update: 'Unmodified existing10s HostProcesses query timer; typed20 CPU rows change to firstCPU/compared0 on next timer response.',
      oracle:
        'Complete focus visibility and same viewport anchor <=1px; raw offsets and actual max recorded separately. No post-update focus/scroll.',
      helperSha256: hash(fs.readFileSync(__filename)),
      runnerSha256: hash(fs.readFileSync(require.resolve('./visual-qa.cjs'))),
      compiledIndexSha256: hash(fs.readFileSync(path.join(__dirname, '../packages/frontend/dist/client/index.html'))),
      productSources: Object.fromEntries(
        [
          'packages/frontend/src/modules/dashboard/components/host-processes.tsx',
          'packages/frontend/src/modules/dashboard/components/host-processes.css',
        ].map((file) => [file, hash(fs.readFileSync(path.join(__dirname, '..', file)))]),
      ),
    },
  };
  let shadow = structuredClone(preferences);
  let processBody;
  let version = 0;
  const devices = deviceFixture();
  const sensors = sensorFixture('empty');
  const history = historyFixture('1h');
  const onError = (error) => report.errors.push({ name: error.name, message: error.message });
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) {
      report.external.push(url.origin);
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/desktop-preferences') {
      if (request.method() === 'PUT') {
        shadow = request.postDataJSON();
        report.preferenceShadowWrites++;
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(shadow) });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    const fixture = {
      '/api/system/host-telemetry': devices,
      '/api/system/host-sensors': sensors,
      '/api/system/host-history': history,
      '/api/system/containers': { available: true, sampledAt: sensors.sampledAt, omitted: 0, containers: [] },
    };
    if (url.pathname === endpoint) {
      report.requests.push({ at: Date.now(), version, rows: processBody.byCpu.length, compared: processBody.compared });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'x-orbis-clamp-version': String(version) },
        body: JSON.stringify(processBody),
      });
    }
    if (Object.hasOwn(fixture, url.pathname))
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture[url.pathname]) });
    return route.fallback();
  };
  page.on('pageerror', onError);
  await page.route('**/*', handler);
  try {
    for (const group of [
      { width: 1440, height: 1120, scale: 1 },
      { width: 1100, height: 640, scale: 1 },
      { width: 320, height: 800, scale: 2 },
    ]) {
      report.current = `${group.width}x${group.height}-text${group.scale}`;
      shadow = { ...structuredClone(preferences), mode: 'dark', preset: 'frost', windows: {} };
      processBody = processFixture('growth');
      processBody.stale = true;
      processBody.sampledAt = new Date(Date.now() - 45000).toISOString();
      version = 0;
      await restoreText(page);
      await page.setViewportSize({ width: group.width, height: group.height });
      await page.goto(`${base}/monitor`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.querySelectorAll('.host-process-list li').length === 20 && document.querySelector('.host-sensors-about summary'),
      );
      await dom.settle(page);
      await scaleText(page, group.scale);
      const item = { ...group, passed: false, before: await prepare(page), after: null };
      const original = structuredClone(processBody);
      item.originalCpu = await processData(page);
      report.cases.push(item);
      await capture(`monitor-clamp-${report.current}-before`, { scrollTop: false, fullPage: false });
      const received = page.waitForResponse(
        (response) => new URL(response.url()).pathname === endpoint && response.headers()['x-orbis-clamp-version'] === '1',
        { timeout: 15000 },
      );
      void received.catch(() => undefined);
      item.armedAt = Date.now();
      processBody = {
        ...structuredClone(processBody),
        sampledAt: new Date().toISOString(),
        stale: false,
        byCpu: [],
        byMemory: processBody.byMemory.map((row) => ({ ...row, cpuPercent: null })),
        compared: 0,
      };
      version = 1;
      processBody.readable = 40;
      processBody.scanned = 41;
      processBody.unreadable = 1;
      processBody.byMemory = processBody.byMemory.map((row, index) => ({ ...row, memoryBytes: (500 - index) * 1024 ** 2 }));
      await received;
      item.receivedAt = Date.now();
      await page.waitForFunction(() =>
        document.querySelector('.host-processes-stale')?.textContent.includes('CPU comparisons are pending. Previous sample:'),
      );
      await dom.settle(page);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForTimeout(250);
      item.after = await snapshot(page);
      item.delta = {
        viewportTop: item.after.target.top - item.before.target.top,
        viewportBottom: item.after.target.bottom - item.before.target.bottom,
        contentTop: item.after.target.contentTop - item.before.target.contentTop,
        scrollTop: item.after.scroller.scrollTop - item.before.scroller.scrollTop,
        max: item.after.scroller.maxScroll - item.before.scroller.maxScroll,
      };
      item.clampEvidence = {
        beforeScrollExceedsAfterMax: item.before.scroller.scrollTop > item.after.scroller.maxScroll + 1,
        afterAtMax: item.after.scroller.atEnd,
        unchangedControlContentCoordinate: Math.abs(item.delta.contentTop) <= 1,
        predictedClampScroll: Math.min(item.before.scroller.scrollTop, item.after.scroller.maxScroll),
        actualScroll: item.after.scroller.scrollTop,
      };
      await capture(`monitor-clamp-${report.current}-after`, { scrollTop: false, fullPage: false });
      item.pendingCpu = await processData(page);
      assert.deepEqual(item.pendingCpu.rows, item.originalCpu.rows, 'Pending comparisons retain exact original CPU and RSS values/names/order');
      assert.equal(item.pendingCpu.timestamp, original.sampledAt, 'Previous CPU timestamp must remain the original sample time');
      assert.deepEqual(item.pendingCpu.coverage, item.originalCpu.coverage, 'Previous CPU coverage must remain bound to the original sample');
      assert.equal(item.pendingCpu.state, 'Readings delayed');
      assert.ok(
        item.pendingCpu.notice.includes('CPU comparisons are pending. Previous sample:') &&
          item.pendingCpu.notice.includes('Select Memory for current memory readings.'),
        'Retained ranking must be explicitly described as previous CPU data',
      );
      checkFocus(item.after);
      assert.ok(
        Math.abs(item.delta.viewportTop) <= 1 && Math.abs(item.delta.viewportBottom) <= 1,
        'Timer list shrink must retain the sort-before-list visible reading anchor within1px',
      );
      await page.locator('.host-processes-sort button').nth(1).click();
      await dom.settle(page);
      item.currentMemory = await processData(page);
      assert.deepEqual(
        item.currentMemory.rows.map((row) => [row.pid, row.cpu, row.memory]),
        processBody.byMemory.map((row) => [row.pid, 'Pending', `${(row.memoryBytes / 1024 ** 2).toFixed(1)} MB`]),
        'Memory must render exact current RSS rows instead of the retained CPU snapshot',
      );
      assert.ok(item.currentMemory.coverage.at(-1).includes('40 readable processes'), 'Memory coverage must use current readings');
      assert.equal(item.currentMemory.notice, null, 'Current fresh Memory must not claim previous CPU values');
      await capture(`monitor-clamp-${report.current}-current-memory`, { scrollTop: false, fullPage: false });
      await page.locator(selector).click();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await dom.settle(page);
      item.recoveryBefore = await snapshot(page);
      const recovery = page.waitForResponse(
        (response) => new URL(response.url()).pathname === endpoint && response.headers()['x-orbis-clamp-version'] === '2',
        { timeout: 15000 },
      );
      void recovery.catch(() => undefined);
      const recoveredRows = original.byCpu.map((row, index) => ({ ...row, cpuPercent: 500 + index, memoryBytes: (1000 + index) * 1024 ** 2 }));
      processBody = {
        ...original,
        sampledAt: new Date().toISOString(),
        stale: false,
        byCpu: recoveredRows.toSorted((a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid),
        byMemory: recoveredRows.toSorted((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid),
      };
      version = 2;
      await recovery;
      await page.waitForFunction(() => !document.querySelector('.host-processes-stale'));
      await dom.settle(page);
      item.recoveredCpu = await processData(page);
      item.recoveryAfter = await snapshot(page);
      assert.deepEqual(
        item.recoveredCpu.rows.map((row) => [row.pid, row.cpu, row.memory]),
        processBody.byCpu.map((row) => [row.pid, `${row.cpuPercent.toFixed(1)}%`, `${(row.memoryBytes / 1024 ** 2).toFixed(1)} MB`]),
        'Successful comparisons replace the retained ranking with exact new CPU/RSS/order',
      );
      assert.equal(item.recoveredCpu.timestamp, null);
      assert.equal(item.recoveredCpu.state, 'Updates every 10 seconds');
      checkFocus(item.recoveryAfter);
      assert.ok(Math.abs(item.recoveryAfter.target.top - item.recoveryBefore.target.top) <= 1, 'Recovery must retain the same visible sort anchor');
      await capture(`monitor-clamp-${report.current}-recovered-cpu`, { scrollTop: false, fullPage: false });
      await restoreText(page);
      processBody = { ...processBody, byCpu: [], compared: 0, byMemory: processBody.byMemory.map((row) => ({ ...row, cpuPercent: null })) };
      version = 3;
      await page.goto(`${base}/monitor`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('.host-processes')?.textContent.includes('Collecting CPU comparisons'));
      await dom.settle(page);
      await scaleText(page, group.scale);
      item.initialWarmup = await processData(page);
      assert.equal(item.initialWarmup.rows.length, 0, 'A new mount with no prior CPU sample must show empty first-sample warmup');
      assert.equal(item.initialWarmup.notice, null, 'No-history warmup must not invent a previous sample');
      assert.equal(item.initialWarmup.timestamp, null);
      await prepareWarmupCapture(page);
      await capture(`monitor-clamp-${report.current}-initial-warmup`, { scrollTop: false, fullPage: false });
      item.passed = true;
    }
    assert.equal(report.cases.length, 3);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.external, []);
    report.passed = true;
  } catch (error) {
    report.failure = { current: report.current, type: error.name, message: error.message };
    await capture(`monitor-clamp-${report.current}-FIRST-FAILURE`, { scrollTop: false, fullPage: false }).catch(() => {
      report.failure.captureUnavailable = true;
    });
  } finally {
    for (const [name, action] of [
      ['textRestored', () => restoreText(page)],
      ['routesRestored', () => page.unroute('**/*', handler)],
      [
        'listenerRestored',
        async () => {
          page.off('pageerror', onError);
          assert.equal(page.listeners('pageerror').includes(onError), false);
        },
      ],
      ['viewportRestored', () => page.setViewportSize(originalViewport)],
    ]) {
      try {
        await action();
        report.cleanup[name] = true;
      } catch (error) {
        report.cleanup[name] = false;
        report.cleanupFailures.push({ name, message: error.message });
        report.passed = false;
      }
    }
  }
  return report;
};
