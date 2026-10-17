const assert = require('node:assert/strict');

module.exports = async function inspectCustomWorkspace({
  page,
  base,
  fixtures,
  capture,
  modes = ['light', 'dark'],
  textScales = [1, 2],
  negativeControl = false,
}) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8080', 'Custom workspace checks require static8080 fixtures');
  assert.ok(fixtures?.preferences && fixtures.apps?.length >= 2);
  const width = page.viewportSize().width;
  const fixturesApps = structuredClone(fixtures.apps.slice(0, 2));
  const names = [
    'Home Assistant',
    'Jellyfin Media Library and Transcoding Server',
    'Paperless document archive',
    'Immich Photo Library',
    'Vaultwarden',
    'Audiobookshelf',
  ];
  fixturesApps.push(
    ...names.map((name, index) => ({
      ...structuredClone(fixturesApps[0]),
      info: { ...fixturesApps[0].info, urn: `custom-layout-${index}:test`, name },
      app: { ...fixturesApps[0].app, id: 100 + index },
    })),
  );
  const scenarios = [
    { id: 'exact-saved-wide-two', count: 2, wide: ['applications', 'activity'], hidden: [], showAllApps: false },
    { id: 'default-two', count: 2, wide: ['applications'], hidden: [], showAllApps: false, defaultLayout: true },
    { id: 'half-two', count: 2, wide: [], hidden: [], showAllApps: false },
    {
      id: 'mixed-seven-five-two',
      count: 2,
      order: ['activity', 'applications', 'storage', 'attention'],
      wide: ['applications'],
      hidden: [],
      showAllApps: false,
      mixed: true,
    },
    { id: 'wide-empty', count: 0, wide: ['applications', 'activity'], hidden: [], showAllApps: false },
    { id: 'wide-eight-bounded', count: 8, wide: ['applications', 'activity'], hidden: [], showAllApps: true },
    { id: 'wide-eight-unbounded', count: 8, wide: ['applications', 'activity'], hidden: ['storage', 'attention'], showAllApps: true },
  ];
  const report = {
    viewport: page.viewportSize(),
    source: 'Static8080 HTML/assets and development API fixtures, with browser-local shadow workspace preferences only',
    negativeControl,
    samples: [],
    shadowPreferenceWrites: [],
    blockedMutations: [],
  };
  let preferences = structuredClone(fixtures.preferences);
  let count = 2;
  const handler = (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const respond = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (pathname === '/api/desktop-preferences') {
      if (request.method() === 'GET') return respond(preferences);
      if (request.method() === 'PUT') {
        report.shadowPreferenceWrites.push(JSON.parse(request.postData() || '{}'));
        return respond(preferences);
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      report.blockedMutations.push({ pathname, method: request.method() });
      return route.abort('blockedbyclient');
    }
    if (pathname === '/api/apps/installed') return respond({ installed: fixturesApps.slice(0, count) });
    if (pathname === '/api/links') return respond({ links: [] });
    return route.fallback();
  };
  const settle = async () => {
    await page.locator('.workspace-grid').evaluate(async (grid) => {
      const animations = [...grid.querySelectorAll('.workspace-widget,.workspace-app')].flatMap((element) => element.getAnimations());
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    });
    await page.waitForTimeout(100);
  };
  const scaleText = (scale) =>
    page.evaluate((factor) => {
      if (factor === 1) return;
      const baseline = [...document.querySelectorAll('body,body *')]
        .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName))
        .map((element) => {
          const style = getComputedStyle(element);
          return { element, font: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight) };
        });
      for (const { element, font, line } of baseline) {
        if (Number.isFinite(font)) element.style.setProperty('font-size', `${font * factor}px`, 'important');
        if (Number.isFinite(line)) element.style.setProperty('line-height', `${line * factor}px`, 'important');
      }
    }, scale);
  const measure = () =>
    page.locator('.workspace-grid').evaluate((grid) => {
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const launcher = grid.querySelector('.workspace-apps');
      const launcherStyle = getComputedStyle(launcher);
      const lastChild = [...launcher.children].filter((element) => element.getBoundingClientRect().height > 0).at(-1);
      const pane = launcher.querySelector('.workspace-app-scroll');
      const words = [];
      const walker = document.createTreeWalker(grid, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim() || node.parentElement.closest('svg,[aria-hidden="true"],.visually-hidden')) continue;
        let ellipsis = null;
        for (let ancestor = node.parentElement; ancestor && ancestor !== grid; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.textOverflow === 'ellipsis' && style.overflowX === 'hidden' && ancestor.scrollWidth > ancestor.clientWidth + 1) {
            ellipsis = { title: ancestor.title, text: ancestor.textContent.trim() };
            break;
          }
        }
        if (ellipsis) {
          words.push({ text: node.textContent.trim(), ellipsis });
          continue;
        }
        for (const match of node.textContent.matchAll(/[A-Za-z]{4,}/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
          const section = node.parentElement.closest('.workspace-widget > *');
          const bounds = box(section);
          const inset = section === launcher ? 0 : 8;
          words.push({
            text: match[0],
            lines: new Set(rects.map((rect) => Math.round(rect.top * 10))).size,
            outside: rects.some((rect) => rect.left < bounds.left + inset - 0.5 || rect.right > bounds.right - inset + 0.5),
          });
        }
      }
      return {
        grid: {
          ...box(grid),
          display: getComputedStyle(grid).display,
          defaultLayout: grid.dataset.defaultLayout,
          gap: Number.parseFloat(getComputedStyle(grid).columnGap),
        },
        widgets: [...grid.children].map((widget) => ({
          id: [...widget.classList]
            .find((name) => /^workspace-widget-(applications|activity|storage|attention)$/.test(name))
            ?.replace('workspace-widget-', ''),
          wide: widget.classList.contains('workspace-widget-wide'),
          gridColumn: getComputedStyle(widget).gridColumn,
          ...box(widget),
          body: box(widget.firstElementChild),
        })),
        launcher: {
          ...box(launcher),
          minHeight: launcherStyle.minHeight,
          paddingBottom: Number.parseFloat(launcherStyle.paddingBottom),
          lastChild: box(lastChild),
          forcedBlank: box(launcher).bottom - box(lastChild).bottom - Number.parseFloat(launcherStyle.paddingBottom),
          emptyVisible: Boolean(launcher.querySelector('.workspace-empty')),
          tiles: launcher.querySelectorAll('.workspace-app').length,
        },
        pane: pane
          ? {
              ...box(pane),
              enabled: pane.dataset.scroll,
              overflowY: getComputedStyle(pane).overflowY,
              maxHeight: getComputedStyle(pane).maxHeight,
              clientHeight: pane.clientHeight,
              scrollHeight: pane.scrollHeight,
              scrollTop: pane.scrollTop,
              tabIndex: pane.getAttribute('tabindex'),
            }
          : null,
        words,
        documentWidth: document.documentElement.scrollWidth,
        scrollY,
      };
    });
  const defects = (metrics, scenario) => {
    const failures = [];
    const fail = (condition, message) => {
      if (!condition) failures.push(message);
    };
    const near = (left, right) => Math.abs(left - right) <= 1;
    fail(metrics.documentWidth <= width + 1, 'workspace widens the document');
    fail(metrics.grid.defaultLayout === String(Boolean(scenario.defaultLayout)), 'default layout detection changed');
    fail(metrics.launcher.tiles === scenario.count, 'installed app count is incomplete');
    fail(metrics.launcher.emptyVisible === (scenario.count === 0), 'empty app state is incorrect');
    fail(metrics.widgets.length === 4 - scenario.hidden.length, 'hidden widget count is incorrect');
    for (const word of metrics.words) {
      if (word.ellipsis)
        fail(Boolean(word.ellipsis.title) && word.ellipsis.title === word.ellipsis.text, `identifier ellipsis lacks its full title: ${word.text}`);
      else {
        fail(word.lines <= 1, `ordinary word fractures: ${word.text}`);
        fail(!word.outside, `text presses past widget gutter: ${word.text}`);
      }
    }
    if (!scenario.defaultLayout) {
      const rows = [];
      for (const widget of metrics.widgets) {
        let row = rows.find((items) => near(items[0].top, widget.top));
        if (!row) {
          row = [];
          rows.push(row);
        }
        row.push(widget);
      }
      for (const widget of metrics.widgets) {
        const row = rows.find((items) => items.includes(widget));
        if (row.length === 1) fail(near(widget.width, metrics.grid.width), `${widget.id} does not use its full width`);
        fail(widget.left >= metrics.grid.left - 1 && widget.right <= metrics.grid.right + 1, `${widget.id} escapes the outer grid`);
        fail(near(widget.body.left, widget.left) && near(widget.body.right, widget.right), `${widget.id} body does not align to its widget`);
      }
      for (const row of rows) {
        row.sort((left, right) => left.left - right.left);
        fail(near(row[0].left, metrics.grid.left) && near(row.at(-1).right, metrics.grid.right), 'custom row leaves unfilled outer columns');
        for (let index = 1; index < row.length; index++)
          fail(near(row[index].left - row[index - 1].right, metrics.grid.gap), 'paired widgets do not retain the grid gap');
      }
      const appRow = rows.find((row) => row.some((widget) => widget.id === 'applications'));
      if (width <= 760)
        fail(
          rows.every((row) => row.length === 1),
          'small custom workspace must use single-column pages',
        );
      else if (scenario.mixed) {
        const apps = metrics.widgets.find((widget) => widget.id === 'applications');
        const status = metrics.widgets.find((widget) => widget.id === 'activity');
        fail(
          near(apps.top, status.top) && Math.abs(apps.width / status.width - 7 / 5) < 0.01,
          'mixed wide/normal widgets must preserve the7/5 paired ratio',
        );
      } else if (scenario.wide.length === 0) {
        fail(
          appRow.length === 2 && appRow.every((widget) => near(widget.width, (metrics.grid.width - metrics.grid.gap) / 2)),
          'two normal widgets must share their row equally',
        );
      }
      fail(metrics.launcher.minHeight === '0px', 'launcher retains a forced minimum height');
      if (appRow.length === 1) fail(metrics.launcher.forcedBlank <= 2, 'launcher has forced blank space after its content');
      if (scenario.wide.includes('applications') && scenario.wide.includes('activity')) {
        const apps = metrics.widgets.find((widget) => widget.id === 'applications');
        const status = metrics.widgets.find((widget) => widget.id === 'activity');
        fail(near(apps.left, status.left) && near(apps.right, status.right), 'full-width launcher/status edges disagree');
        fail(near(status.top - apps.bottom, metrics.grid.gap), 'launcher/status row gap contains unexplained space');
      }
    } else if (width > 760) {
      const apps = metrics.widgets.find((widget) => widget.id === 'applications');
      const status = metrics.widgets.find((widget) => widget.id === 'activity');
      fail(
        near(apps.left, metrics.grid.left) && near(status.right, metrics.grid.right) && near(apps.top, status.top),
        'default split layout lost its outer edges or top alignment',
      );
    }
    if (metrics.pane) {
      const bounded = scenario.showAllApps && scenario.hidden.length < 2;
      fail(metrics.pane.enabled === String(bounded), 'show-all scroll policy is wrong');
      fail(
        bounded
          ? metrics.pane.overflowY === 'auto' && metrics.pane.tabIndex === '0'
          : metrics.pane.maxHeight === 'none' && metrics.pane.tabIndex === null,
        'app pane scrolling semantics are incorrect',
      );
      if (!bounded) fail(metrics.pane.scrollHeight <= metrics.pane.clientHeight + 1, 'unbounded apps are clipped');
    }
    return [...new Set(failures)];
  };
  await page.route('**/api/**', handler);
  try {
    for (const mode of negativeControl ? ['light'] : modes)
      for (const textScale of negativeControl ? [1] : textScales)
        for (const scenario of negativeControl ? scenarios.slice(0, 1) : scenarios) {
          count = scenario.count;
          preferences = {
            ...structuredClone(fixtures.preferences),
            mode,
            windows: {},
            workspace: {
              order: scenario.order || ['applications', 'activity', 'storage', 'attention'],
              hidden: scenario.hidden,
              wide: scenario.wide,
              pinnedApps: [],
              showAllApps: scenario.showAllApps,
            },
          };
          const name = `${mode}-text${textScale * 100}-${scenario.id}`;
          await page.evaluate((value) => localStorage.setItem('server-desktop-preferences-v1', JSON.stringify(value)), preferences);
          await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
          await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
          await page.waitForFunction(
            (expected) =>
              document.querySelectorAll('.workspace-app').length === expected && (expected !== 0 || document.querySelector('.workspace-empty')),
            count,
          );
          await page.evaluate(() => document.fonts.ready);
          await settle();
          await scaleText(textScale);
          await settle();
          const initial = await measure();
          const failures = defects(initial, scenario);
          await capture?.(name, { scrollTop: true });
          if (negativeControl) {
            assert.ok(failures.includes('applications does not use its full width'), 'Old bundle must reproduce the saved wide-layout defect');
            assert.ok(failures.includes('launcher retains a forced minimum height'), 'Old bundle must reproduce forced launcher height');
          } else assert.deepEqual(failures, [], `${name}: ${JSON.stringify(initial)}`);
          let keyboardScroll;
          if (!negativeControl && initial.pane?.enabled === 'true' && initial.pane.scrollHeight > initial.pane.clientHeight + 1) {
            const pane = page.getByRole('region', { name: 'Installed applications', exact: true });
            await pane.focus();
            await page.keyboard.press('End');
            await page.waitForTimeout(200);
            keyboardScroll = await pane.evaluate((element) => ({
              scrollTop: element.scrollTop,
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
            }));
            assert.ok(keyboardScroll.scrollTop > 0, 'Keyboard must reach the bounded pane contents');
            await capture?.(`${name}-keyboard-end`, { scrollTop: false });
          }
          report.samples.push({ scenario: scenario.id, mode, textScale, count, initial, failures, keyboardScroll });
        }
    assert.deepEqual(report.blockedMutations, [], 'Workspace geometry checks must not write to apps or hosts');
    assert.deepEqual(report.shadowPreferenceWrites, [], 'Read-only workspace checks must not initiate a preference save');
    return report;
  } finally {
    await page.unroute('**/api/**', handler);
  }
};
