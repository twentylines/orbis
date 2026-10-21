const assert = require('node:assert/strict');
const { dom } = require('./host-devices-checks.cjs');
const placeholders = require('./input-placeholder-checks.cjs');
const { browser } = require('./live-compact-ui-qa.cjs');

module.exports = async function inspectPackageField({ page, base, preferences, capture }) {
  assert.equal(base, 'http://localhost:8080', 'Package-field checks require isolated source fixtures');
  const report = { passed: false, samples: [], negatives: [], mutations: [], errors: [], cleanup: {} };
  const viewport = page.viewportSize();
  const key = 'server-desktop-preferences-v1';
  const storage = await page.evaluate((key) => localStorage.getItem(key), key);
  const shadow = structuredClone(preferences);
  const handler = (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base || !['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/desktop-preferences')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(shadow) });
    return route.fallback();
  };
  const onError = (error) => report.errors.push(error.message);
  await page.route('**/*', handler);
  page.on('pageerror', onError);
  try {
    for (const mode of ['light', 'dark'])
      for (const width of [1440, 768, 390, 320])
        for (const scale of [1, 2]) {
          const tag = `${mode}-${width}-text${scale}`;
          shadow.mode = mode;
          await dom.restoreText(page);
          await page.setViewportSize({ width, height: width === 1440 ? 1120 : width === 768 ? 1024 : 800 });
          await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key, value: shadow });
          await page.goto(`${base}/updates`, { waitUntil: 'domcontentloaded' });
          const label = page.locator('.desktop-host-package-search');
          const input = label.locator('input');
          await input.waitFor();
          await page.waitForFunction((mode) => document.querySelector('.desktop[data-desktop-mode]')?.dataset.desktopMode === mode, mode);
          await dom.settle(page);
          await dom.scaleText(page, scale);
          await browser.wheelVisible(page, label);
          assert.equal(await input.getAttribute('placeholder'), null, 'Package search must not repeat a label inside the field');
          assert.equal(await input.getAttribute('type'), 'search');
          assert.equal(await input.evaluate((input) => input.labels[0].textContent.trim()), 'Name or repository');
          placeholders.check(await placeholders.measure(page, '.desktop-host-package-search'));
          const geometry = await label.evaluate((label) => {
            const input = label.querySelector('input');
            const text = label.querySelector('span');
            const a = text.getBoundingClientRect();
            const b = input.getBoundingClientRect();
            const words = [...text.textContent.matchAll(/[A-Za-z]+/g)].map((word) => {
              const range = document.createRange();
              range.setStart(text.firstChild, word.index);
              range.setEnd(text.firstChild, word.index + word[0].length);
              return { word: word[0], lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size };
            });
            return { labelLeft: a.left, inputLeft: b.left, labelRight: a.right, inputRight: b.right, gap: b.top - a.bottom, words };
          });
          assert.ok(Math.abs(geometry.labelLeft - geometry.inputLeft) <= 1 && Math.abs(geometry.labelRight - geometry.inputRight) <= 1);
          assert.ok(geometry.gap >= 7, 'Wrapped label must retain its field gap');
          assert.ok(
            geometry.words.every((word) => word.lines === 1),
            'Package-search label words must remain whole',
          );
          await capture(`${tag}-label`, { scrollTop: false });
          if (width === 320 && scale === 2) {
            await input.evaluate((input) => {
              input.placeholder = 'Name or repository';
            });
            try {
              const fields = await placeholders.measure(page, '.desktop-host-package-search');
              assert.throws(() => placeholders.check(fields), /placeholder/);
              await capture(`${tag}-old-placeholder-negative`, { scrollTop: false });
              report.negatives.push({ mode, width, scale, fields });
            } finally {
              await input.evaluate((input) => input.removeAttribute('placeholder'));
            }
          }
          await input.focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
          assert.equal(await input.evaluate((input) => input === document.activeElement && input.matches(':focus-visible')), true);
          await input.fill('openssh');
          await page.getByRole('checkbox', { name: 'Select openssh-server:arm64 for update', exact: true }).waitFor();
          assert.equal(await page.locator('.desktop-host-package').count(), 1);
          assert.match(await page.locator('.desktop-host-package-title').innerText(), /openssh-server/);
          await browser.wheelVisible(page, label);
          await capture(`${tag}-name-filter-focus`, { scrollTop: false });
          await input.fill('noble-security');
          await page.getByRole('checkbox', { name: 'Select linux-image-generic:arm64 for update', exact: true }).waitFor();
          assert.equal(await page.locator('.desktop-host-package').count(), 1);
          assert.match(await page.locator('.desktop-host-package-title').innerText(), /linux-image-generic/);
          await input.fill('no-such-package');
          await page.getByText('No packages match that search.', { exact: true }).waitFor();
          assert.equal(await page.locator('.desktop-host-package').count(), 0);
          assert.equal(await page.getByText('No packages match that search.', { exact: true }).count(), 1);
          report.samples.push({ mode, width, scale, geometry, nameFilter: true, repositoryFilter: true, emptyFilter: true, nativeFocus: true });
        }
    assert.equal(report.samples.length, 16);
    assert.equal(report.negatives.length, 2);
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
    return report;
  } finally {
    await dom.restoreText(page);
    await page.setViewportSize(viewport);
    await page.evaluate(({ key, storage }) => (storage === null ? localStorage.removeItem(key) : localStorage.setItem(key, storage)), {
      key,
      storage,
    });
    await page.unroute('**/*', handler);
    page.off('pageerror', onError);
    report.cleanup = { textRestored: true, viewportRestored: true, storageRestored: true, routesRestored: true };
  }
};
