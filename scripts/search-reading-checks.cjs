const assert = require('node:assert/strict');
const { browser } = require('./live-compact-ui-qa.cjs');

const reading = (page) =>
  page.evaluate(() => ({
    x: scrollX,
    y: scrollY,
    content: document.querySelector('.desktop-window-content')?.scrollTop || 0,
    frame: document.querySelector('.desktop-route-window')?.scrollTop || 0,
  }));

function sameReading(actual, expected, phase) {
  for (const key of Object.keys(expected))
    assert.ok(Math.abs(actual[key] - expected[key]) <= 1, `${phase} must preserve ${key}: ${expected[key]} → ${actual[key]}`);
}

async function pointer(page, button) {
  const point = await button.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    return { x, y, clear: element.contains(document.elementFromPoint(x, y)) };
  });
  assert.equal(point.clear, true, 'The actual pointer target must already be visible and unobscured');
  await page.mouse.click(point.x, point.y);
}

module.exports = async function inspectSearchReading({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.equal(origin.origin, 'http://localhost:8080', 'Reading checks use source fixtures only');
  const report = { passed: false, sourceFixturesOnly: true, samples: [], mutations: [], external: [], preferenceWritesMocked: 0, cleanup: {} };
  let shadow = { ...structuredClone(preferences), mode: 'dark', preset: 'frost', windows: {} };
  const viewport = page.viewportSize();
  const handler = (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) {
      report.external.push(url.origin);
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/desktop-preferences' && ['GET', 'PUT'].includes(request.method())) {
      if (request.method() === 'PUT') {
        shadow = request.postDataJSON();
        report.preferenceWritesMocked++;
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(shadow) });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  };
  await page.route('**/*', handler);
  const cases = [
    { name: 'tablet-home', width: 768, height: 1024, scale: 1, path: '/dashboard', target: '.container-resources-sort button' },
    { name: 'phone-home-text2', width: 320, height: 800, scale: 2, path: '/dashboard', target: '.container-resources-sort button' },
    { name: 'desktop-monitor', width: 1440, height: 1120, scale: 1, path: '/monitor', target: '.host-processes-sort button' },
    { name: 'phone-reduced-text2', width: 320, height: 800, scale: 2, reduced: true, path: '/dashboard', target: '.container-resources-sort button' },
  ];
  try {
    for (const sample of cases)
      for (const method of ['Escape', 'Close button', 'Control+k']) {
        await browser.restoreText(page);
        await page.emulateMedia({ reducedMotion: sample.reduced ? 'reduce' : 'no-preference' });
        await page.setViewportSize({ width: sample.width, height: sample.height });
        shadow.windows = {};
        await page.goto(`${base}${sample.path}`, { waitUntil: 'domcontentloaded' });
        const target = page.locator(sample.target).first();
        await target.waitFor();
        await browser.settled(page);
        await browser.scaleText(page, sample.scale);
        await browser.wheelVisible(page, target);
        await target.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await browser.settled(page);
        let before = await reading(page);
        if (before.y + before.content + before.frame <= 30) {
          await page.mouse.move(sample.width - 30, sample.height / 2);
          await page.mouse.wheel(0, 160);
          await browser.settled(page);
          before = await reading(page);
        }
        assert.ok(before.y + before.content + before.frame > 30, 'The regression must start at a scrolled reading position');
        if (method === 'Escape') await capture(`${sample.name}-before`, { scrollTop: false });
        const trigger = page.locator('.desktop-search-trigger');
        if (method === 'Escape') await pointer(page, trigger);
        else await page.keyboard.press('Control+k');
        const dialog = page.getByRole('dialog', { name: 'Search Orbis', exact: true });
        await dialog.waitFor();
        await browser.settled(page);
        assert.equal(await dialog.locator('input').evaluate((element) => element === document.activeElement), true);
        const open = await reading(page);
        sameReading(open, before, 'Opening Search');
        if (method === 'Escape') await capture(`${sample.name}-open`, { scrollTop: false });
        if (method === 'Close button') await pointer(page, dialog.getByRole('button', { name: 'Close search', exact: true }));
        else await page.keyboard.press(method);
        await dialog.waitFor({ state: 'detached' });
        await browser.settled(page);
        const after = await reading(page);
        sameReading(after, before, 'Closing Search');
        assert.equal(await trigger.evaluate((element) => element === document.activeElement), true, 'Closing must restore the real trigger');
        if (method !== 'Close button') assert.equal(await trigger.evaluate((element) => element.matches(':focus-visible')), true);
        await capture(`${sample.name}-${method === 'Close button' ? 'button' : method.replace('+', '-')}-closed`, { scrollTop: false });
        report.samples.push({ ...sample, method, before, open, after, triggerFocusRestored: true });
      }
    assert.equal(report.samples.length, 12);
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.external, []);
    report.passed = true;
    return report;
  } finally {
    await browser.restoreText(page);
    report.cleanup.textRestored = true;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    report.cleanup.mediaRestored = true;
    await page.setViewportSize(viewport);
    report.cleanup.viewportRestored = true;
    await page.unroute('**/*', handler);
    report.cleanup.routesRestored = true;
  }
};
