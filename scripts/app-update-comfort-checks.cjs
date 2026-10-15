const assert = require('node:assert/strict');

// Published-image callers verify the owned build before supplying controlled metadata.
module.exports = async function inspectAppUpdateComfort({ page, base, capture, verifiedPublished = false, updatePath = '/apps/test/media/update' }) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === (verifiedPublished ? '18080' : '8080'));
  assert.match(updatePath, /^\/apps\/[^/?#]+\/[^/?#]+\/update$/);
  const report = { source: verifiedPublished ? 'published assets with controlled metadata' : 'static fixtures', samples: [], mutations: [] };
  const guard = (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && path !== '/api/desktop-preferences') {
      report.mutations.push({ path, method: request.method() });
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  };
  await page.route('**/api/**', guard);
  const wizard = () => page.getByTestId('app-update');
  const scaleText = (scale) =>
    page.evaluate((scale) => {
      for (const [element, values] of window.__orbisUpdateText ?? []) {
        if (!element.isConnected) continue;
        for (const [name, value, priority] of values) {
          if (value) element.style.setProperty(name, value, priority);
          else element.style.removeProperty(name);
        }
      }
      window.__orbisUpdateText = [];
      if (scale === 1) return;
      const baseline = [...document.querySelectorAll('body,body *')]
        .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName))
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            element,
            font: Number.parseFloat(style.fontSize),
            line: Number.parseFloat(style.lineHeight),
            values: ['font-size', 'line-height'].map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
          };
        });
      for (const { element, font, line, values } of baseline) {
        if (!Number.isFinite(font)) continue;
        window.__orbisUpdateText.push([element, values]);
        element.style.setProperty('font-size', `${font * scale}px`, 'important');
        if (Number.isFinite(line)) element.style.setProperty('line-height', `${line * scale}px`, 'important');
      }
    }, scale);
  const inspect = async (mode, scale, step, selector = '[data-testid="app-update"]') => {
    await scaleText(scale);
    await page.waitForTimeout(350);
    const geometry = await page.locator(selector).evaluate((root) => {
      const box = (element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const visible = (element) => element.getBoundingClientRect().width > 0 && !element.closest('[hidden],.visually-hidden');
      const copy = [];
      const brokenWords = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!node.textContent.trim() || !visible(parent) || parent.closest('svg,.cm-editor')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const surface = parent.closest('.card-header,.card-body,.card-footer,.app-workspace-hero,.app-workspace-facts') ?? root;
        const bounds = box(surface);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom }));
        copy.push({ text: node.textContent.trim(), bounds, rects });
        if (!parent.closest('.badge') && !/\d/.test(node.textContent)) {
          for (const match of node.textContent.matchAll(/[A-Za-z]{3,}/g)) {
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.y)));
            if (lines.size > 1) brokenWords.push(match[0]);
          }
        }
      }
      const labels = [...root.querySelectorAll('.breadcrumb button')].map((button) => {
        const range = document.createRange();
        range.selectNodeContents(button);
        return { text: button.textContent, button: box(button), textBounds: box({ getBoundingClientRect: () => range.getBoundingClientRect() }) };
      });
      const content = document.querySelector('.desktop-window-content');
      return {
        copy,
        brokenWords,
        labels,
        root: box(root),
        window: box(root.closest('.desktop-route-window')),
        header: box(root.querySelector('.card-header,.app-workspace-hero')),
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        contentOverflow: content.scrollWidth > content.clientWidth + 1,
      };
    });
    await capture?.(`${mode}-update-text-${scale}-${step}`, { scrollTop: false, fullPage: true });
    assert.equal(geometry.documentOverflow || geometry.contentOverflow, false, `${mode}/${scale}/${step}: horizontal overflow`);
    assert.deepEqual(geometry.brokenWords, [], `${mode}/${scale}/${step}: ordinary words must remain whole`);
    for (const item of geometry.copy) {
      for (const rect of item.rects) {
        assert.ok(
          rect.x >= item.bounds.x - 1 && rect.right <= item.bounds.right + 1,
          `${mode}/${scale}/${step}: text escapes its surface: ${item.text}`,
        );
        assert.ok(
          rect.x >= geometry.window.x + 12 && rect.right <= geometry.window.right - 12,
          `${mode}/${scale}/${step}: text lacks window edge clearance: ${item.text}`,
        );
      }
    }
    for (const item of geometry.labels) {
      assert.ok(item.textBounds.x >= item.button.x + 8 && item.textBounds.right <= item.button.right - 8, `step padding: ${item.text}`);
      assert.ok(item.textBounds.y >= item.button.y + 6 && item.textBounds.bottom <= item.button.bottom - 6, `step vertical padding: ${item.text}`);
    }
    report.samples.push({ mode, scale, step, ...geometry });
  };
  try {
    for (const mode of ['light', 'dark']) {
      for (const scale of [1, 2]) {
        await page.goto(`${base}${updatePath}`, { waitUntil: 'domcontentloaded' });
        await wizard().waitFor();
        if (!(await page.locator(`.desktop[data-desktop-mode="${mode}"]`).count())) {
          await page.getByRole('button', { name: `Switch to ${mode} mode`, exact: true }).click();
          await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
        }
        for (const step of ['Information', 'Configuration', 'Compose file', 'Backup']) {
          await scaleText(1);
          await wizard().getByRole('button', { name: step, exact: true }).click();
          if (['Configuration', 'Compose file'].includes(step)) await wizard().locator('.cm-content').first().waitFor();
          await inspect(mode, scale, step.toLowerCase().replaceAll(' ', '-'));
        }
        await page.goto(`${base}${updatePath.slice(0, -'/update'.length)}`, { waitUntil: 'domcontentloaded' });
        await page.locator('.app-workspace-identity').waitFor();
        await inspect(mode, scale, 'app-detail', '.app-workspace');
      }
    }
    assert.deepEqual(report.mutations, []);
    return report;
  } finally {
    await scaleText(1);
    await page.unroute('**/api/**', guard);
  }
};
