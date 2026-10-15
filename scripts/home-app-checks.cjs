const assert = require('node:assert/strict');
const inspectWorkspaceAlignment = require('./workspace-alignment-checks.cjs');

// Requires isolated API fixtures, including at least 14 installed applications.
module.exports = async function inspectHomeApps(page, { apps, resetPreferences, capture, modes = ['light', 'dark'], restoreMode = 'light' }) {
  assert.equal(typeof resetPreferences, 'function', 'supply a callback that resets the fixture preference response');
  const installed = apps.filter(({ info }) => info.available);
  assert.ok(installed.length >= 14, 'exercise overflow and long labels with at least 14 available fixture apps');
  const chosen = [installed[3], installed[6], installed[10], installed[13]];
  const preferenceKey = 'server-desktop-preferences-v1';
  const dashboard = new URL('/dashboard', page.url()).href;
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(dashboard).hostname), 'Home checks must use a loopback fixture server');
  const report = [];
  const cards = () => page.locator('.workspace-app');
  const pane = () => page.getByRole('region', { name: 'Installed applications', exact: true });
  const saved = () => page.getByText('Saved to your account.', { exact: true }).waitFor();
  const waitForCount = (count) => page.waitForFunction((expected) => document.querySelectorAll('.workspace-app').length === expected, count);
  const settle = async () => {
    await page.waitForTimeout(600);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const snapshot = async (name, scrollTop = true) => {
    if (capture) await capture(name, { scrollTop });
  };
  const reset = async (mode) => {
    if (page.url().startsWith(new URL(dashboard).origin)) await page.evaluate((key) => localStorage.removeItem(key), preferenceKey);
    await page.goto('about:blank');
    await resetPreferences(mode);
    await page.goto(dashboard, { waitUntil: 'domcontentloaded' });
    await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
    await waitForCount(3);
    await page.mouse.move(0, 0);
    await settle();
  };
  const assertFits = async () => {
    const dimensions = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(dimensions.content <= dimensions.width, `Home overflows horizontally: ${JSON.stringify(dimensions)}`);
    assert.equal(
      await cards().evaluateAll((items) => items.every((item) => item.scrollWidth <= item.clientWidth + 1)),
      true,
      'long app names and health labels must remain inside their cards',
    );
  };
  const picker = async () => {
    const trigger = page.getByRole('button', { name: 'Choose home apps', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const heading = page.getByRole('heading', { name: 'Home apps', exact: true });
    await heading.waitFor();
    await page.waitForFunction(() => {
      const heading = document.querySelector('#workspace-pins h3');
      const bar = document.querySelector('.desktop-system-bar');
      return heading && bar && document.activeElement === heading && heading.getBoundingClientRect().top >= bar.getBoundingClientRect().bottom + 8;
    });
    await saved();
    const toggle = page.getByRole('switch', { name: 'Show all installed apps', exact: true });
    const geometry = await toggle.evaluate((element) => {
      const { width, height } = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { width, height, minHeight: style.minHeight, padding: style.padding };
    });
    assert.ok(
      Math.abs(geometry.width - 32) < 0.1 && Math.abs(geometry.height - 20) < 0.1,
      `switch inherited button sizing: ${JSON.stringify(geometry)}`,
    );
    assert.equal(geometry.minHeight, '0px', "the switch must not inherit editor buttons' 44px minimum height");
    await assertFits();
    return toggle;
  };
  const closePicker = async () => {
    await saved();
    await page.getByRole('button', { name: 'Done editing', exact: true }).click();
    await page.locator('.workspace-editor').waitFor({ state: 'hidden' });
    await settle();
  };
  const assertBounded = async (expected) => {
    assert.equal(await pane().getAttribute('data-scroll'), String(expected));
    const geometry = await pane().evaluate((element) => ({
      height: element.clientHeight,
      content: element.scrollHeight,
      overflow: getComputedStyle(element).overflowY,
      maxHeight: getComputedStyle(element).maxHeight,
      tabIndex: element.getAttribute('tabindex'),
    }));
    if (expected) {
      assert.equal(geometry.overflow, 'auto');
      assert.equal(geometry.tabIndex, '0');
      assert.ok(geometry.content > geometry.height + 1, `the fixture must exercise actual inner scrolling: ${JSON.stringify(geometry)}`);
    } else {
      assert.equal(geometry.tabIndex, null);
      assert.equal(geometry.maxHeight, 'none');
      assert.ok(geometry.content <= geometry.height + 1, `unbounded apps are clipped: ${JSON.stringify(geometry)}`);
    }
    await assertFits();
    return geometry;
  };

  try {
    for (const mode of modes) {
      await reset(mode);
      await assertBounded(false);
      const defaultAlignment = await inspectWorkspaceAlignment(page);
      await snapshot(`${mode}-home-default`);
      await picker();
      await snapshot(`${mode}-home-picker`, false);
      for (const app of chosen) {
        await page.getByRole('button', { name: `Pin ${app.info.name}`, exact: true }).click();
        await page.getByRole('button', { name: `Unpin ${app.info.name}`, exact: true }).waitFor();
      }
      await closePicker();
      await waitForCount(4);
      assert.deepEqual(
        await cards().locator('strong').allTextContents(),
        chosen.map(({ info }) => info.name),
      );
      const compact = await assertBounded(false);
      await page.mouse.move(0, 0);
      await settle();
      const pinnedAlignment = await inspectWorkspaceAlignment(page);
      await snapshot(`${mode}-home-pinned`);

      const toggle = await picker();
      await toggle.focus();
      await page.keyboard.press('Space');
      await page.getByRole('switch', { name: 'Show all installed apps', exact: true, checked: true }).waitFor();
      await waitForCount(installed.length);
      await closePicker();
      const bounded = await assertBounded(true);
      await pane().scrollIntoViewIfNeeded();
      await pane().evaluate((element) => {
        window.scrollTo({ top: scrollY + element.getBoundingClientRect().top - 110, behavior: 'instant' });
        element.scrollTo({ top: 0, behavior: 'instant' });
      });
      await pane().focus();
      await page.keyboard.press('PageDown');
      await page.waitForFunction(() => document.querySelector('.workspace-app-scroll').scrollTop > 0);
      await page.waitForTimeout(300);
      const keyboardScroll = await pane().evaluate((element) => element.scrollTop);
      await pane().evaluate((element) => {
        element.scrollTo({ top: 0, behavior: 'instant' });
      });
      await pane().hover();
      await page.waitForTimeout(250);
      const outerBefore = await page.evaluate(() => scrollY);
      await page.mouse.wheel(0, 350);
      await page.waitForFunction(() => document.querySelector('.workspace-app-scroll').scrollTop > 0);
      await page.waitForTimeout(250);
      const wheelScroll = await pane().evaluate((element) => element.scrollTop);
      assert.equal(await page.evaluate(() => scrollY), outerBefore, 'wheel scrolling over apps must stay in the bounded pane');
      await pane().focus();
      for (let index = 0; index < installed.length; index++) await page.keyboard.press('Tab');
      assert.equal(
        await cards()
          .last()
          .evaluate((element) => element === document.activeElement),
        true,
        'all apps must remain keyboard reachable',
      );
      assert.equal(
        await cards()
          .last()
          .evaluate((element) => {
            const card = element.getBoundingClientRect();
            const region = element.closest('.workspace-app-scroll').getBoundingClientRect();
            return card.top >= region.top - 1 && card.bottom <= region.bottom + 1;
          }),
        true,
        'keyboard focus must scroll the last app into the pane',
      );
      await snapshot(`${mode}-home-all-apps`, false);

      await picker();
      await page.getByRole('button', { name: 'Hide Recent operations', exact: true }).click();
      await page.getByRole('button', { name: 'Hide Needs attention', exact: true }).click();
      await closePicker();
      assert.equal(await page.locator('.workspace-operations, .workspace-attention').count(), 0);
      const unbounded = await assertBounded(false);
      assert.equal(await cards().count(), installed.length);
      await snapshot(`${mode}-home-unbounded`);

      await picker();
      await page.getByRole('button', { name: 'Restore layout', exact: true }).click();
      await closePicker();
      assert.equal(await page.locator('.workspace-operations').count(), 1);
      assert.equal(await page.locator('.workspace-attention').count(), 1);
      await assertBounded(true);
      await snapshot(`${mode}-home-restored`);

      // Clear the local cache so reload proves account-backed preference persistence.
      await page.evaluate((key) => localStorage.removeItem(key), preferenceKey);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
      await waitForCount(installed.length);
      assert.equal(
        await cards()
          .filter({ has: page.locator('small', { hasText: 'Pinned' }) })
          .count(),
        4,
      );
      assert.deepEqual(
        (await cards().locator('strong').allTextContents()).slice(0, 4),
        chosen.map(({ info }) => info.name),
      );
      await assertBounded(true);
      const restoredToggle = await picker();
      assert.equal(await restoredToggle.getAttribute('aria-checked'), 'true');
      await closePicker();
      report.push({
        mode,
        defaultApps: 3,
        pinnedApps: 4,
        allApps: installed.length,
        defaultAlignment,
        pinnedAlignment,
        compact,
        bounded,
        unbounded,
        keyboardScroll,
        wheelScroll,
        reload: true,
        pickerFocus: true,
        switchSizing: true,
      });
    }
  } finally {
    await reset(restoreMode);
  }
  return report;
};
