const assert = require('node:assert/strict');

// Run: ORBIS_VISUAL_TEXT_ONLY=1 ORBIS_VISUAL_SCREENSHOT_DIR=/tmp/orbis-text node scripts/visual-qa.cjs
// textScale2 doubles computed text/line-height while leaving root size, icons and CSS viewport unchanged.
// ORBIS_VISUAL_TEXT_SCALE=1 checks the native viewport (for example3840x2160); default2 is text stress.
// ORBIS_VISUAL_ZOOM instead approximates full-page zoom and must stay1 for this text-only mode.
// The initial unscaled dock is checked before focus/scrolling; the stressed dock is then checked in both Tab directions.
module.exports = async function inspectEnlargedText({ page, base, viewport, capture, resetPreferences, textScale = 2 }) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '8080', 'text checks require static8080 fixtures');
  assert.equal(typeof resetPreferences, 'function', 'the fixture runner must reset preferences between modes');
  assert.ok([1, 2].includes(textScale), 'textScale must be1 (native viewport) or2 (text-only stress)');
  const report = {
    viewport: viewport ?? page.viewportSize(),
    textScale,
    method: 'computed text and pixel line-height; root size unchanged',
    modes: [],
    mutations: [],
  };
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.pathname !== '/api/desktop-preferences') {
      report.mutations.push({ path: url.pathname, method: request.method() });
    }
  };
  page.on('request', onRequest);
  const settle = async () => {
    await page.waitForTimeout(350);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const shot = (name) => capture?.(name, { scrollTop: false });
  const restoreText = () =>
    page.evaluate(() => {
      for (const [element, properties] of window.__orbisTextStressOriginals ?? []) {
        if (!element.isConnected) continue;
        for (const [name, value, priority] of properties) {
          if (value) element.style.setProperty(name, value, priority);
          else element.style.removeProperty(name);
        }
      }
      window.__orbisTextStressOriginals = [];
    });
  const scaleText = async () => {
    await restoreText();
    if (textScale === 1) return [];
    return page.evaluate((scale) => {
      const elements = [...document.querySelectorAll('body,body *')].filter(
        (element) =>
          (element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName)) ||
          element.tagName.toLowerCase() === 'text',
      );
      const baseline = elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          element,
          font: Number.parseFloat(style.fontSize),
          line: style.lineHeight,
          original: ['font-size', 'line-height'].map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
        };
      });
      for (const { element, font, line, original } of baseline) {
        if (!Number.isFinite(font)) continue;
        window.__orbisTextStressOriginals.push([element, original]);
        element.style.setProperty('font-size', `${font * scale}px`, 'important');
        if (line !== 'normal' && Number.isFinite(Number.parseFloat(line))) {
          element.style.setProperty('line-height', `${Number.parseFloat(line) * scale}px`, 'important');
        }
      }
      return baseline
        .filter(({ element }) => element.matches('h1,.desktop-current,.desktop-dock-item span'))
        .map(({ element, font }) => ({
          text: element.textContent.trim().slice(0, 80),
          normal: font,
          enlarged: Number.parseFloat(getComputedStyle(element).fontSize),
        }));
    }, textScale);
  };
  const measureText = (selector, containerSelector = null) =>
    page.locator(selector).evaluateAll((elements, containerSelector) => {
      const rect = (element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
      };
      const visible = (element) => {
        const r = element.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('.visually-hidden,[hidden]');
      };
      return elements.filter(visible).map((element) => {
        const parent = containerSelector ? element.closest(containerSelector) : element;
        if (!parent) throw new Error(`Missing text container: ${containerSelector}`);
        const bounds = rect(parent);
        const parts = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim() || node.parentElement.closest('svg,.visually-hidden,[hidden]') || !visible(node.parentElement)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of range.getClientRects()) parts.push({ x: r.x, y: r.y, right: r.right, bottom: r.bottom });
        }
        return {
          text: element.textContent.trim(),
          rect: rect(element),
          container: bounds,
          parts,
          contained: parts.every(
            (part) => part.x >= bounds.x - 1 && part.right <= bounds.right + 1 && part.y >= bounds.y - 1 && part.bottom <= bounds.bottom + 1,
          ),
        };
      });
    }, containerSelector);
  const assertContained = (measurements, label) => {
    assert.ok(measurements.length > 0, `${label} must have visible text`);
    for (const item of measurements) assert.ok(item.contained, `${label} text escaped its surface: ${JSON.stringify(item)}`);
  };
  const assertPageFits = async () => {
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      content: document.documentElement.scrollWidth,
      rootFont: getComputedStyle(document.documentElement).fontSize,
    }));
    assert.ok(geometry.content <= geometry.width, `document overflows: ${JSON.stringify(geometry)}`);
    return geometry;
  };
  const headerGeometry = async () => {
    const text = await measureText('.desktop-brand');
    assertContained(text, 'header brand');
    const geometry = await page.evaluate(() => {
      const brand = document.querySelector('.desktop-brand');
      const controls = document.querySelector('.desktop-system-actions');
      const bar = document.querySelector('.desktop-system-bar');
      const br = brand.getBoundingClientRect();
      const cr = controls.getBoundingClientRect();
      const rr = bar.getBoundingClientRect();
      return {
        aria: brand.getAttribute('aria-label'),
        brandRight: br.right,
        controlsLeft: cr.x,
        bar: { x: rr.x, right: rr.right, width: rr.width },
        separated: br.right + 4 <= cr.x,
        controlsContained: cr.x >= rr.x + 1 && cr.right <= rr.right - 1 && cr.y >= rr.y + 1 && cr.bottom <= rr.bottom - 1,
      };
    });
    assert.match(geometry.aria, /Orbis workspace/, 'the compact brand must retain its accessible name');
    assert.ok(geometry.separated, `brand overlaps header controls: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.controlsContained, 'header controls must stay inside the bar');
    return geometry;
  };
  const inspectInitialDock = async () => {
    const geometry = await page.locator('.desktop-dock').evaluate((dock) => {
      const r = dock.getBoundingClientRect();
      return {
        bounds: { x: r.x, right: r.right, y: r.y, bottom: r.bottom },
        scrollLeft: dock.scrollLeft,
        items: [...dock.querySelectorAll('.desktop-dock-item')].map((element) => {
          const item = element.getBoundingClientRect();
          const label = element.querySelector('span');
          const lr = label.getBoundingClientRect();
          return {
            text: element.textContent.trim(),
            bounds: { x: item.x, right: item.right, y: item.y, bottom: item.bottom, width: item.width, height: item.height },
            labelPadding: { left: lr.x - item.x, right: item.right - lr.right },
            fullyVisible: item.x >= r.x + 1 && item.right <= r.right - 1 && item.y >= 0 && item.bottom <= innerHeight,
            labelComplete:
              getComputedStyle(label).display !== 'none' && label.scrollWidth <= label.clientWidth + 1 && lr.x >= r.x + 1 && lr.right <= r.right - 1,
          };
        }),
      };
    });
    assert.equal(geometry.items.length, 6, 'the unscrolled normal dock must contain all six tools');
    for (const item of geometry.items) {
      assert.ok(item.fullyVisible && item.labelComplete, `normal dock item is cropped before focus: ${JSON.stringify(item)}`);
      assert.ok(item.labelPadding.left >= 8 && item.labelPadding.right >= 8, `dock labels need8px side padding: ${JSON.stringify(item)}`);
      assert.ok(item.bounds.width >= 44 && item.bounds.height >= 44, `dock hit target is smaller than44px: ${JSON.stringify(item)}`);
    }
    return geometry;
  };
  const focusedDockItem = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      const dock = element.closest('.desktop-dock');
      if (!dock) throw new Error('keyboard focus left the dock unexpectedly');
      const r = element.getBoundingClientRect();
      const dr = dock.getBoundingClientRect();
      const label = element.querySelector('span');
      const style = getComputedStyle(element);
      const outline = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
      return {
        text: element.textContent.trim(),
        scrollY,
        bounds: { x: r.x, right: r.right, y: r.y, bottom: r.bottom },
        dock: { x: dr.x, right: dr.right, y: dr.y, bottom: dr.bottom, scrollLeft: dock.scrollLeft },
        visible: r.x >= dr.x + 1 && r.right <= dr.right - 1 && r.y >= 0 && r.bottom <= innerHeight,
        ringContained:
          r.x - outline >= dr.x + 1 && r.right + outline <= dr.right - 1 && r.y - outline >= dr.y + 1 && r.bottom + outline <= dr.bottom - 1,
        labelComplete: getComputedStyle(label).display !== 'none' && label.scrollWidth <= label.clientWidth + 1,
      };
    });
  const inspectDock = async (mode) => {
    const count = await page.locator('.desktop-dock-item').count();
    assert.equal(count, 6, 'all six desktop tools must be present');
    const startY = await page.evaluate(() => scrollY);
    const forward = [];
    const reverse = [];
    await page.locator('.desktop-dock-item').first().focus();
    for (let index = 0; index < count; index += 1) {
      if (index > 0) await page.keyboard.press('Tab');
      await page.waitForTimeout(100);
      forward.push(await focusedDockItem());
      if (index === count - 2) await shot(`${mode}-text-dock-updates`);
    }
    await shot(`${mode}-text-dock-settings`);
    for (let index = 1; index < count; index += 1) {
      await page.keyboard.press('Shift+Tab');
      await page.waitForTimeout(100);
      reverse.push(await focusedDockItem());
    }
    for (const item of [...forward, ...reverse]) {
      assert.ok(item.visible && item.ringContained && item.labelComplete, `focused dock item is clipped: ${JSON.stringify(item)}`);
      assert.equal(item.scrollY, startY, 'dock focus must not move the document vertically');
    }
    assert.equal(forward[0].text, 'Home');
    assert.equal(forward.at(-1).text, 'Settings');
    assert.equal(reverse.at(-1).text, 'Home');
    return { startY, forward, reverse };
  };
  const open = async (path, mode, readySelector, enlarge = true) => {
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.locator(`.desktop[data-desktop-mode="${mode}"]`).first().waitFor();
    await page.locator(readySelector).first().waitFor();
    await settle();
    const probes = enlarge ? await scaleText() : [];
    await settle();
    return probes;
  };
  try {
    for (const mode of ['light', 'dark']) {
      if (page.url().startsWith(origin.origin)) await page.evaluate(() => localStorage.removeItem('server-desktop-preferences-v1'));
      await page.goto('about:blank');
      await resetPreferences(mode);
      await open('/dashboard', mode, '.workspace-status-storage', false);
      const initialDock = await inspectInitialDock();
      await shot(`${mode}-native-dock`);
      const probes = await scaleText();
      await settle();
      for (const probe of probes)
        assert.ok(Math.abs(probe.enlarged - probe.normal * textScale) < 0.1, 'font scaling must not compound across states');
      const result = { mode, probes, initialDock, page: await assertPageFits(), header: await headerGeometry() };
      result.homeActions = await measureText('.workspace-home-app-actions a', '.workspace-apps');
      assertContained(result.homeActions, 'Home View all');
      await shot(`${mode}-text-home`);
      result.dock = await inspectDock(mode);

      result.status = await measureText(
        '.workspace-status-storage strong,.workspace-status-storage > small,.workspace-activity .container-resource-values b',
        '.workspace-activity',
      );
      assertContained(result.status, 'Home storage and resource values');
      result.resourceNames = await measureText(
        '.workspace-activity .container-resource-name strong,.workspace-activity .container-resource-name small',
      );
      assertContained(result.resourceNames, 'resource identity');
      for (const name of result.resourceNames)
        assert.ok(name.parts.length <= 2, `resource identity collapsed into narrow letter columns: ${JSON.stringify(name)}`);
      await page.locator('.workspace-status-storage').scrollIntoViewIfNeeded();
      await shot(`${mode}-text-status`);

      await page.getByRole('button', { name: 'Edit workspace', exact: true }).first().click();
      await page.locator('.workspace-pin-list').waitFor();
      await settle();
      await scaleText();
      await settle();
      result.pins = await measureText('.workspace-pin-list button');
      assertContained(result.pins, 'pin picker');
      await page.locator('.workspace-pin-list').scrollIntoViewIfNeeded();
      await shot(`${mode}-text-pins`);

      await open('/apps/test/media?tab=resources', mode, '[role="tablist"][aria-label="Application sections"]');
      result.windowTitle = await measureText('.desktop-window-label h1', '.desktop-window-bar');
      assertContained(result.windowTitle, 'application window title');
      assert.equal(result.windowTitle[0].parts.length, 1, 'Applications title must not split its final letter onto another line');
      result.tabs = await measureText('[role="tablist"][aria-label="Application sections"] button');
      assertContained(result.tabs, 'application tabs');
      await shot(`${mode}-text-window`);
      await page.getByRole('tablist', { name: 'Application sections', exact: true }).scrollIntoViewIfNeeded();
      await shot(`${mode}-text-tabs`);
      await assertPageFits();
      report.modes.push(result);
    }
    assert.equal(report.mutations.length, 0, 'text/layout checks must not issue app or host mutations');
    return report;
  } finally {
    page.off('request', onRequest);
    await restoreText();
  }
};
