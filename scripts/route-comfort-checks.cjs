const assert = require('node:assert/strict');

// open() must mount a fresh fixture route and apply text scaling from one computed baseline.
module.exports = async function inspectRouteComfort({ page, base, open, capture, mode, textScale, routeNames }) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '8080', 'comfort checks require static8080 fixtures');
  assert.equal(typeof open, 'function', 'provide the fixture runner fresh-route/scaling callback');
  assert.ok(['light', 'dark'].includes(mode));
  assert.ok([1, 2].includes(textScale));
  if (routeNames) {
    assert.ok(routeNames.length > 0 && routeNames.every((name) => ['apps', 'store', 'monitor', 'updates', 'settings', 'appdetail'].includes(name)));
  }
  const report = { mode, textScale, viewport: page.viewportSize(), routes: [], mutations: [] };
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.pathname !== '/api/desktop-preferences') {
      report.mutations.push({ path: url.pathname, method: request.method() });
    }
  };
  page.on('request', onRequest);
  const screenshot = async (name, target) => {
    if (target) {
      await page
        .locator(target)
        .first()
        .evaluate((node) => window.scrollTo(0, Math.max(0, node.getBoundingClientRect().top + scrollY - 150)));
    } else {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    await capture?.(`${mode}-comfort-${name}`, { scrollTop: false });
  };
  const measure = (selectors) =>
    page.evaluate((selectors) => {
      const box = (node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y + scrollY, right: r.right, bottom: r.bottom + scrollY, width: r.width, height: r.height };
      };
      const shown = (node) => {
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== 'hidden' && !node.closest('.visually-hidden,[hidden]');
      };
      const records = selectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)].filter(shown).map((node) => {
          const style = getComputedStyle(node);
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
          const brokenWords = [];
          const brokenTokens = [];
          const architecture = node.matches('.desktop-host-package-title strong') ? node.textContent.match(/:([A-Za-z0-9_-]+)$/)?.[1] : null;
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const text = walker.currentNode;
            if (!shown(text.parentElement) || text.parentElement.closest('svg')) continue;
            for (const match of text.textContent.matchAll(/[A-Za-z]{4,}/g)) {
              range.setStart(text, match.index);
              range.setEnd(text, match.index + match[0].length);
              const pieces = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
              if (new Set(pieces.map((r) => Math.round(r.y))).size > 1) brokenWords.push(match[0]);
            }
            if (architecture && text.textContent.includes(architecture)) {
              const start = text.textContent.lastIndexOf(architecture);
              range.setStart(text, start);
              range.setEnd(text, start + architecture.length);
              const pieces = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
              if (new Set(pieces.map((r) => Math.round(r.y))).size > 1) brokenTokens.push(architecture);
            }
          }
          return {
            selector,
            text: node.textContent.trim(),
            box: box(node),
            font: Number.parseFloat(style.fontSize),
            lines: new Set(rects.map((r) => Math.round(r.y))).size,
            brokenWords,
            brokenTokens,
          };
        }),
      );
      return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, records };
    }, selectors);
  const wholeWords = (result, label) => {
    assert.ok(result.records.length, `${label} requires fixture text`);
    for (const item of result.records) {
      assert.deepEqual(item.brokenWords, [], `${label} fractured ordinary words: ${JSON.stringify(item)}`);
      assert.deepEqual(item.brokenTokens, [], `${label} fractured technical tokens: ${JSON.stringify(item)}`);
    }
  };
  const pageFits = (result, label) => {
    assert.ok(result.documentWidth <= result.viewportWidth, `${label} exceeds the viewport: ${JSON.stringify(result)}`);
  };
  const contained = (items, label) => {
    for (const item of items) {
      assert.ok(
        item.box.x >= item.parent.x - 1 && item.box.right <= item.parent.right + 1,
        `${label} extends beyond its surface: ${JSON.stringify(item)}`,
      );
    }
  };
  const parentBounds = (selector, parentSelector) =>
    page.locator(selector).evaluateAll(
      (nodes, parentSelector) =>
        nodes.map((node) => {
          const rect = (element) => {
            const r = element.getBoundingClientRect();
            return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width, height: r.height };
          };
          const parent = node.closest(parentSelector);
          if (!parent) throw new Error(`Missing comfort surface: ${parentSelector}`);
          return { text: node.textContent.trim(), box: rect(node), parent: rect(parent) };
        }),
      parentSelector,
    );
  try {
    for (const route of [
      { name: 'apps', path: '/apps', ready: '.desktop-installed-grid .app-tile-copy' },
      { name: 'store', path: '/app-store', ready: '.catalogue-tile .card-body' },
      { name: 'monitor', path: '/monitor', ready: '.desktop-telemetry-lead' },
      { name: 'updates', path: '/updates', ready: '.desktop-update-release-title' },
      { name: 'settings', path: '/settings?tab=settings', ready: '.desktop-settings form' },
      { name: 'appdetail', path: '/apps/test/media?tab=resources', ready: '.container-resources-heading' },
    ]) {
      if (routeNames && !routeNames.includes(route.name)) continue;
      await open(route.path, mode, route.ready);
      const result = await measure(['.desktop-window-label h1']);
      pageFits(result, route.name);
      await screenshot(`${route.name}-top`);
      if (route.name === 'apps' || route.name === 'store') {
        result.copy = await measure([
          '.app-tile-copy',
          '.desktop-installed-grid .button-tile .card-body > div:last-child',
          '.catalogue-tile .card-body',
        ]);
        wholeWords(result.copy, `${route.name} card copy`);
        result.cards = await page.evaluate(() => {
          const records = [];
          for (const parent of document.querySelectorAll('.app-tile-body,.catalogue-tile,.button-tile .card-body')) {
            const logo = parent.querySelector('.app-logo,svg');
            const copy = parent.querySelector('.app-tile-copy,.card-body') ?? parent.lastElementChild;
            if (!logo || !copy) continue;
            const p = parent.getBoundingClientRect();
            const l = logo.getBoundingClientRect();
            const c = copy.getBoundingClientRect();
            const style = getComputedStyle(parent);
            const font = Number.parseFloat(getComputedStyle(copy).fontSize);
            const usable = parent.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
            records.push({
              text: copy.textContent.trim(),
              width: c.width,
              font,
              usable,
              stacked: c.y >= l.bottom - 1,
              contained: c.x >= p.x - 1 && c.right <= p.right + 1,
              readable: c.width >= Math.min(usable, font * 8) - 1,
            });
          }
          return records;
        });
        assert.ok(result.cards.length >= 3, 'card comfort needs the retained installed/store fixtures');
        for (const card of result.cards) assert.ok(card.contained && card.readable, `card copy is squeezed: ${JSON.stringify(card)}`);
        if (page.viewportSize().width === 320 && textScale === 2) {
          assert.ok(
            result.cards.every((card) => card.stacked),
            'enlarged narrow card copy needs its own readable row',
          );
        }
        await screenshot(`${route.name}-cards`, route.name === 'apps' ? '.desktop-installed-grid .app-link:nth-child(2)' : '.catalogue-tile');
      }
      if (route.name === 'monitor') {
        result.leads = await measure(['.desktop-telemetry-lead strong', '.desktop-telemetry-lead > span']);
        wholeWords(result.leads, 'Monitor value and label');
        for (const item of result.leads.records)
          assert.equal(item.lines, 1, `Monitor value/label is squeezed into fragments: ${JSON.stringify(item)}`);
        result.leadBounds = await parentBounds('.desktop-telemetry-lead > *', '.desktop-telemetry-lead');
        contained(result.leadBounds, 'Monitor value and label');
        result.cores = await measure(['.desktop-core-grid > div > span:first-child', '.desktop-core-grid > div > strong']);
        wholeWords(result.cores, 'per-core label and value');
        for (const item of result.cores.records) assert.equal(item.lines, 1, `per-core label/value is squeezed: ${JSON.stringify(item)}`);
        result.coreBounds = await parentBounds(
          '.desktop-core-grid > div > span:first-child,.desktop-core-grid > div > strong',
          '.desktop-core-grid > div',
        );
        contained(result.coreBounds, 'per-core labels and values');
        await screenshot('monitor-values', '.desktop-telemetry-lead');
        await screenshot('monitor-memory', '.desktop-telemetry-memory');
        await screenshot('monitor-cores', '.desktop-core-grid');
      }
      if (route.name === 'updates') {
        result.release = await parentBounds('.desktop-update-release-title > *', '.desktop-update-release-title');
        assert.ok(result.release.length >= 2, 'release/date comfort requires ORBIS_VISUAL_HOST_UPDATE=1');
        contained(result.release, 'release and date');
        result.packages = await measure(['.desktop-host-package-title strong', '.desktop-host-package-foot button']);
        wholeWords(result.packages, 'package name and changelog control');
        assert.deepEqual(
          result.packages.records.filter((item) => item.selector === '.desktop-host-package-title strong').map((item) => item.text),
          ['linux-image-generic:arm64', 'openssh-server:arm64', 'base-files:arm64'],
          'semantic breaks must preserve the complete package fixture names',
        );
        result.packageCheckboxes = await page.locator('.desktop-host-package-title').evaluateAll((titles) =>
          titles.map((title) => {
            const name = title.querySelector('strong');
            const input = title.querySelector('input');
            const n = name.getBoundingClientRect();
            const i = input.getBoundingClientRect();
            const line = Number.parseFloat(getComputedStyle(name).lineHeight);
            return { name: name.textContent, delta: Math.abs(i.y + i.height / 2 - n.y - line / 2), checkboxRight: i.right, nameLeft: n.x };
          }),
        );
        for (const item of result.packageCheckboxes) {
          assert.ok(
            item.delta <= 1.5 && item.checkboxRight < item.nameLeft,
            `package checkbox must align with the name's first line: ${JSON.stringify(item)}`,
          );
        }
        result.packageBounds = await parentBounds('.desktop-host-package-foot button', '.desktop-host-package');
        contained(result.packageBounds, 'package changelog controls');
        await screenshot('updates-release', '.desktop-update-release-title');
        await screenshot('updates-package', '.desktop-host-package');
      }
      if (route.name === 'settings') {
        result.form = await measure(['.desktop-settings form label', '.desktop-settings form button']);
        wholeWords(result.form, 'Settings labels and controls');
        result.buttons = await parentBounds('.desktop-settings form .btn', '.desktop-settings form');
        assert.ok(
          result.buttons.some((button) => button.text === 'Download certificate'),
          'certificate button must be exercised',
        );
        contained(result.buttons, 'Settings controls');
        for (const button of result.buttons) assert.ok(button.box.height >= 40, 'Settings buttons must remain usable hit targets');
        await screenshot('settings-controls', '.desktop-settings form button.btn.mt-2.mb-2');
      }
      if (route.name === 'appdetail') {
        result.usage = await measure(['.container-resources-note', '.container-resource-values b', '.container-resource-name', '.docker-health']);
        wholeWords(result.usage, 'application resource text');
        result.resourceBounds = await parentBounds('.container-resource-values b', '.container-resources');
        contained(result.resourceBounds, 'application resource values');
        await screenshot('appdetail-usage', '.container-resources-heading');
        await screenshot('appdetail-values', '.container-resource-values');
      }
      report.routes.push({ name: route.name, ...result });
    }
    assert.equal(report.mutations.length, 0, 'route comfort checks must not mutate apps or the host');
    return report;
  } finally {
    page.off('request', onRequest);
  }
};
