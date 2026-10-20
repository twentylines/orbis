const assert = require('node:assert/strict');
const { dom } = require('./host-devices-checks.cjs');
const placeholders = require('./input-placeholder-checks.cjs');

module.exports = async function inspectAuthFields({ page, base, preferences, capture }) {
  assert.equal(new URL(base).origin, 'http://localhost:8080', 'Account-field checks require isolated source fixtures');
  const report = { passed: false, samples: [], negatives: [], mutations: [], external: [], errors: [], cleanup: {} };
  const originalViewport = page.viewportSize();
  const key = 'server-desktop-preferences-v1';
  const originalStorage = await page.evaluate((key) => localStorage.getItem(key), key);
  const version = { current: '4.10.1', latest: '4.10.1', body: '', releases: [] };
  let screen = 'login';
  const shadow = structuredClone(preferences);
  const handler = (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      report.external.push(url.origin);
      return route.abort('blockedbyclient');
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    const body =
      url.pathname === '/api/user-context'
        ? {
            version,
            isLoggedIn: false,
            isConfigured: screen !== 'register',
            isGuestDashboardEnabled: false,
            allowAutoThemes: false,
            allowErrorMonitoring: false,
            themeColor: 'blue',
            themeBase: 'slate',
            localDomain: 'local.test',
            sslPort: 443,
          }
        : url.pathname === '/api/desktop-preferences'
          ? shadow
          : null;
    return body ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.fallback();
  };
  const onError = (error) => report.errors.push(error.message);
  await page.route('**/*', handler);
  page.on('pageerror', onError);
  try {
    for (const mode of ['light', 'dark'])
      for (const width of [320, 390])
        for (const scale of [1, 2])
          for (screen of ['login', 'register']) {
            const tag = `${mode}-${width}-text${scale}-${screen}`;
            shadow.mode = mode;
            await dom.restoreText(page);
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key, value: shadow });
            await page.goto(`${base}/${screen}`, { waitUntil: 'domcontentloaded' });
            await page.locator('.desktop-auth input[name=email]').waitFor();
            await dom.settle(page);
            await dom.scaleText(page, scale);
            const fields = await page.locator('.desktop-auth form input').evaluateAll((inputs) =>
              inputs.map((input) => ({
                name: input.name,
                type: input.type,
                autocomplete: input.autocomplete,
                placeholder: input.getAttribute('placeholder'),
                label: [...input.labels].map((label) => label.textContent.trim()).join(' '),
              })),
            );
            assert.equal(fields.length, screen === 'login' ? 2 : 3);
            for (const field of fields) {
              assert.ok(field.label, 'Every account field must keep its associated visible label');
              assert.equal(field.placeholder, null, 'Labelled account fields must not repeat placeholder copy');
              assert.equal(field.autocomplete, field.name === 'email' ? 'username' : screen === 'login' ? 'current-password' : 'new-password');
            }
            placeholders.check(await placeholders.measure(page, '.desktop-auth'));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Account page must not overflow');
            await capture(`${tag}-empty`, { scrollTop: false });
            if (width === 320 && scale === 2 && screen === 'login') {
              await page.locator('input[name=email]').evaluate((input) => {
                input.placeholder = 'you@example.com';
              });
              await page.locator('input[name=password]').evaluate((input) => {
                input.placeholder = 'Enter your password';
              });
              try {
                const negative = await placeholders.measure(page, '.desktop-auth');
                assert.equal(negative.length, 2);
                assert.ok(
                  negative.every((field) => field.textWidth + 8 > field.available),
                  'Both original clipped placeholders must be rejected',
                );
                assert.throws(() => placeholders.check(negative), /placeholder/);
                await capture(`${tag}-original-placeholder-negative`, { scrollTop: false });
                report.negatives.push({ mode, width, scale, fields: negative });
              } finally {
                await page.locator('.desktop-auth input[placeholder]').evaluateAll((inputs) => {
                  for (const input of inputs) input.removeAttribute('placeholder');
                });
              }
            }
            await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('qa@lab.test');
            await page.locator('input[name=email]').focus();
            await page.keyboard.press('Tab');
            assert.equal(await page.locator('input[name=password]').evaluate((input) => input === document.activeElement), true);
            await page.locator('input[name=password]').fill('sample12');
            if (screen === 'register') {
              await page.keyboard.press('Tab');
              assert.equal(await page.locator('input[name=passwordConfirm]').evaluate((input) => input === document.activeElement), true);
              await page.locator('input[name=passwordConfirm]').fill('sample12');
            }
            await dom.settle(page);
            const focus = await page.locator(':focus').evaluate((input) => {
              const r = input.getBoundingClientRect();
              const s = getComputedStyle(input);
              return { name: input.name, top: r.top, bottom: r.bottom, focusVisible: input.matches(':focus-visible'), outline: s.outline };
            });
            assert.ok(focus.top >= 8 && focus.bottom <= 792, 'Native account-field focus must reveal the complete field');
            assert.equal(focus.focusVisible, true, 'Native account-field focus must retain a visible marker');
            await capture(`${tag}-filled-native-focus`, { scrollTop: false });
            report.samples.push({ mode, width, scale, screen, fields, focus });
          }
    assert.equal(report.samples.length, 16);
    assert.equal(report.negatives.length, 2);
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.external, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
    return report;
  } catch (error) {
    await capture('failure', { scrollTop: false }).catch(() => undefined);
    error.authFieldReport = report;
    throw error;
  } finally {
    await dom.restoreText(page);
    report.cleanup.textRestored = true;
    await page.setViewportSize(originalViewport);
    report.cleanup.viewportRestored = true;
    await page.evaluate(({ key, original }) => (original === null ? localStorage.removeItem(key) : localStorage.setItem(key, original)), {
      key,
      original: originalStorage,
    });
    report.cleanup.storageRestored = true;
    await page.unroute('**/*', handler);
    page.off('pageerror', onError);
    report.cleanup.routesRestored = true;
  }
};
