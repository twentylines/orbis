const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { dom } = require('./host-devices-checks.cjs');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const unmanaged = 'synthetic_worker';
const managed = 'Managed archive and transcoding application with a deliberately long resource label';
const secondary = 'managed_archive_transcoding_worker_with_a_deliberately_long_identifier';

async function measure(page, selector) {
  return page
    .locator(selector)
    .first()
    .evaluate((root) => {
      const box = (element) => {
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const names = [...root.querySelectorAll('.container-resource-name strong,.container-resource-name small')].map((element) => {
        const style = getComputedStyle(element);
        const allocation = element.closest('.container-resource-name');
        const range = document.createRange();
        range.selectNodeContents(element);
        const words = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode())
          for (const match of walker.currentNode.textContent.matchAll(/[A-Za-z]{3,}/g)) {
            const word = document.createRange();
            word.setStart(walker.currentNode, match.index);
            word.setEnd(walker.currentNode, match.index + match[0].length);
            const rects = [...word.getClientRects()].filter((r) => r.width && r.height).map(boxed);
            if (new Set(rects.map((r) => Math.round(r.top))).size > 1) words.push({ word: match[0], rects });
          }
        function boxed(r) {
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }
        return {
          text: element.textContent,
          title: element.title,
          box: box(element),
          allocation: box(allocation),
          font: Number.parseFloat(style.fontSize),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          style: { whiteSpace: style.whiteSpace, overflow: style.overflowX, textOverflow: style.textOverflow },
          ink: [...range.getClientRects()].filter((r) => r.width && r.height).map(boxed),
          words,
        };
      });
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        scroll: { document: scrollY, content: root.closest('.desktop-window-content')?.scrollTop || 0 },
        box: box(root),
        padding: [getComputedStyle(root).paddingLeft, getComputedStyle(root).paddingRight].map(Number.parseFloat),
        names,
      };
    });
}

function check(value, expected) {
  assert.ok(value.documentWidth <= value.viewport.width, 'Source fixture must not overflow the viewport');
  for (const text of expected)
    assert.ok(
      value.names.some((item) => item.text === text),
      'Complete synthetic primary/secondary names must remain in DOM',
    );
  for (const item of value.names) {
    assert.equal(item.title, item.text, 'Every primary/secondary name needs its full matching title');
    assert.equal(item.style.whiteSpace, 'nowrap');
    assert.equal(item.style.overflow, 'hidden');
    assert.equal(item.style.textOverflow, 'ellipsis');
    assert.ok(item.box.left >= item.allocation.left - 1 && item.box.right <= item.allocation.right + 1, 'Name box must fit its copy column');
    assert.ok(
      item.box.left >= value.box.left + value.padding[0] - 1 && item.box.right <= value.box.right - value.padding[1] + 1,
      'Name boxes must retain the resource panel padding',
    );
    assert.deepEqual(item.words, [], 'No identifier segment may fracture into orphan letters');
    assert.ok(item.box.width > 40, 'Names need usable painted width');
  }
}

async function wheelVisible(page, selector) {
  for (let attempt = 0; attempt < 65; attempt++) {
    const value = await page
      .locator(selector)
      .first()
      .evaluate((element) => {
        const r = element.getBoundingClientRect();
        const top = document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom + 16;
        const bottom = document.querySelector('.desktop-dock').getBoundingClientRect().top - 16;
        return { top: r.top, bottom: r.bottom, limitTop: top, limitBottom: bottom, x: r.left + 20, y: Math.min(bottom - 20, top + 50) };
      });
    if (value.top >= value.limitTop && value.bottom <= value.limitBottom) return;
    const delta = value.top < value.limitTop ? value.top - value.limitTop : value.bottom - value.limitBottom;
    await page.mouse.move(value.x, value.y);
    await page.mouse.wheel(0, Math.max(-900, Math.min(900, delta)));
    await page.waitForTimeout(90);
  }
  throw new Error('Native wheel could not reveal the complete fitting name');
}

module.exports = async function inspectContainerNames({ page, base, preferences, fixtures, capture }) {
  const origin = new URL(base);
  assert.ok(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8080');
  const viewport = page.viewportSize();
  const apps = structuredClone(fixtures.apps);
  apps[0].info.name = managed;
  const rows = [
    { id: 'qa-unmanaged', name: unmanaged, appUrn: null, cpuPercent: 40 },
    { id: 'qa-managed', name: secondary, appUrn: apps[0].info.urn, cpuPercent: 20 },
  ].map((item) => ({
    ...item,
    service: 'worker',
    state: 'running',
    health: 'healthy',
    memoryBytes: 268435456,
    memoryLimitBytes: 2147483648,
    receivedBytes: 0,
    transmittedBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0,
    statsAvailable: true,
  }));
  const shadow = { ...structuredClone(preferences), mode: 'dark', preset: 'frost', windows: {} };
  const report = {
    passed: false,
    groups: [],
    sharedSurfaces: [],
    errors: [],
    mutations: [],
    external: [],
    cleanup: {},
    cleanupFailures: [],
    provenance: {
      sourceFixturesOnly: true,
      helperSha256: hash(fs.readFileSync(__filename)),
      runnerSha256: hash(fs.readFileSync(require.resolve('./visual-qa.cjs'))),
      compiledIndexSha256: hash(fs.readFileSync(`${__dirname}/../packages/frontend/dist/client/index.html`)),
    },
  };
  const handler = (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) {
      report.external.push(url.origin);
      return route.abort('blockedbyclient');
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    const body = {
      '/api/desktop-preferences': shadow,
      '/api/apps/installed': { installed: apps },
      '/api/system/containers': { available: true, sampledAt: new Date().toISOString(), omitted: 0, containers: rows },
    }[url.pathname];
    return body ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.fallback();
  };
  const onError = (error) => report.errors.push({ name: error.name, message: error.message });
  await page.route('**/*', handler);
  page.on('pageerror', onError);
  let negativeStyle;
  const visit = async (route, selector, width, scale, expected) => {
    await dom.restoreText(page);
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 800 });
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    await page.locator(`${selector} .container-resource-name strong`).first().waitFor();
    await dom.settle(page);
    await dom.scaleText(page, scale);
    await wheelVisible(page, `${selector} .container-resource-name`);
    const value = await measure(page, selector);
    check(value, expected);
    return value;
  };
  try {
    for (const width of [320, 390, 768])
      for (const textScale of [1, 2]) {
        report.current = `${width}-text${textScale}-monitor`;
        const item = { width, textScale, passed: false };
        report.groups.push(item);
        item.metrics = await visit('/monitor', '.desktop-monitor .container-resources', width, textScale, [unmanaged, managed, secondary]);
        await capture(`container-names-${report.current}`, { scrollTop: false, fullPage: false });
        if (width === 320 && textScale === 2) {
          negativeStyle = await page.addStyleTag({
            content:
              '.container-resource-name strong,.container-resource-name small{max-width:none;overflow:visible;white-space:normal;text-overflow:clip;overflow-wrap:anywhere}',
          });
          await dom.settle(page);
          item.originalWrapNegative = await measure(page, '.desktop-monitor .container-resources');
          assert.ok(
            item.originalWrapNegative.names.some((name) => name.text === unmanaged && name.words.length > 0),
            'Original wrap CSS must reproduce synthetic_worker word fracture',
          );
          await capture('container-names-original-wrap-negative-320-text2', { scrollTop: false, fullPage: false });
          await negativeStyle.evaluate((element) => element.remove());
          negativeStyle = undefined;
          await dom.settle(page);
          item.restored = await measure(page, '.desktop-monitor .container-resources');
          check(item.restored, [unmanaged, managed, secondary]);
        }
        item.passed = true;
        await wheelVisible(page, '.desktop-monitor .container-resource-list > li:nth-child(2) .container-resource-name');
        await capture(`container-names-${report.current}-managed`, { scrollTop: false, fullPage: false });
      }
    for (const [name, route, selector, expected] of [
      ['home', '/dashboard', '.workspace-activity .container-resources', [unmanaged, managed, secondary]],
      ['app-resources', '/apps/test/media?tab=resources', '.app-workspace .container-resources', [managed, secondary]],
    ]) {
      report.current = `320-text2-${name}`;
      const metrics = await visit(route, selector, 320, 2, expected);
      report.sharedSurfaces.push({ name, passed: true, metrics });
      await capture(`container-names-${report.current}`, { scrollTop: false, fullPage: false });
    }
    assert.equal(report.groups.length, 6);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.external, []);
    report.passed = true;
  } catch (error) {
    report.failure = { phase: report.current, name: error.name, message: error.message };
    await capture(`container-names-${report.current}-FAILED`, { scrollTop: false, fullPage: false }).catch(() => undefined);
  } finally {
    for (const [name, action] of [
      ['negativeStyleRestored', async () => negativeStyle?.evaluate((element) => element.remove())],
      ['textRestored', () => dom.restoreText(page)],
      ['routeRestored', () => page.unroute('**/*', handler)],
      ['listenerRestored', async () => page.off('pageerror', onError)],
      ['viewportRestored', () => page.setViewportSize(viewport)],
    ])
      try {
        await action();
        report.cleanup[name] = true;
      } catch (error) {
        report.cleanup[name] = false;
        report.cleanupFailures.push({ name, message: error.message });
        report.passed = false;
      }
  }
  return report;
};
