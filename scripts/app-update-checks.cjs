const assert = require('node:assert/strict');

// Requires visual-qa.cjs's loopback fixtures; lifecycle responses stay inside this page.
module.exports = async function inspectAppUpdate({ page, base, capture, modes = ['light', 'dark'] }) {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'update checks require loopback fixtures');
  const updatePath = '/apps/test/media/update';
  const endpoints = {
    config: '/api/apps/media:test/config-diff',
    compose: '/api/apps/media:test/compose-diff',
    update: '/api/app-lifecycle/media:test/update',
  };
  const steps = ['Information', 'Configuration', 'Compose file', 'Backup'];
  const config = { current: 'SERVICE_LABEL=old', new: 'SERVICE_LABEL=new' };
  const compose = {
    current: JSON.stringify({ services: { web: { image: 'example/media:1.2.3' } } }),
    new: JSON.stringify({ services: { web: { image: 'example/media:1.3.0' } } }),
  };
  const mutations = [];
  const reviews = [];
  const geometry = [];
  const results = [];
  const failures = [
    'config-http',
    'compose-http',
    'config-invalid-response',
    'compose-invalid-response',
    'compose-invalid-current',
    'compose-invalid-new',
    'config-missing-new',
    'compose-null-new',
  ];
  const gates = new Set();
  let failure = null;
  let configGate = null;
  let composeGate = null;
  let updateGate = null;
  let rejectUpdate = false;
  let currentMode = modes[0];

  const gate = () => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    const value = {
      promise,
      release: () => {
        release();
        gates.delete(value);
      },
    };
    gates.add(value);
    return value;
  };
  const match = (url) => Object.values(endpoints).includes(decodeURIComponent(url.pathname));
  const handler = async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === endpoints.update) {
      assert.equal(route.request().method(), 'PATCH');
      mutations.push({ body: JSON.parse(route.request().postData() || '{}'), rejected: rejectUpdate });
      if (updateGate) await updateGate.promise;
      return rejectUpdate ? respond({ message: 'Fixture update rejected' }, 409) : respond({ requestId: '66666666-6666-4666-8666-666666666666' });
    }
    const kind = path === endpoints.config ? 'config' : 'compose';
    reviews.push(kind);
    if (kind === 'config' && configGate) await configGate.promise;
    if (kind === 'compose' && composeGate) await composeGate.promise;
    if (failure === `${kind}-http`) return respond({ message: 'Fixture review unavailable' }, 503);
    if (failure === `${kind}-invalid-response`) return route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid JSON' });
    if (failure === 'compose-invalid-current' && kind === 'compose') return respond({ ...compose, current: '{invalid JSON' });
    if (failure === 'compose-invalid-new' && kind === 'compose') return respond({ ...compose, new: '{invalid JSON' });
    if (failure === 'config-missing-new' && kind === 'config') return respond({ current: config.current });
    if (failure === 'compose-null-new' && kind === 'compose') return respond({ ...compose, new: null });
    return respond(kind === 'config' ? config : compose);
  };
  await page.route(match, handler);

  const wizard = () => page.getByTestId('app-update');
  const triggers = () => wizard().locator('.breadcrumb > li > button');
  const active = () => triggers().and(page.locator('[aria-current="step"]')).innerText();
  const backup = () => wizard().getByRole('switch', { name: 'Backup', exact: true });
  const submit = () => wizard().getByRole('button', { name: 'Update', exact: true });
  const expectSteps = async () => assert.deepEqual(await triggers().allTextContents(), steps, 'loading must not add/remove/reindex a step');
  const step = async (name) => {
    await wizard().getByRole('button', { name, exact: true }).click();
    assert.equal(await active(), name);
    await expectSteps();
  };
  const open = async () => {
    await page.goto(`${base}${updatePath}`, { waitUntil: 'domcontentloaded' });
    await wizard().waitFor();
    assert.equal(await page.locator('.desktop-route-title').count(), 0, 'the wizard already has an update heading');
    await expectSteps();
    assert.equal(await active(), steps[0]);
  };
  const footerFits = async (mode, phase) => {
    const footer = wizard().locator('.app-update-footer');
    await footer.scrollIntoViewIfNeeded();
    const enabled = footer.locator('button:not(:disabled)');
    if (await enabled.count()) await enabled.last().focus();
    const measurements = await footer.evaluate((element) => {
      const box = (node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom, cy: rect.y + rect.height / 2 };
      };
      const content = document.querySelector('.desktop-window-content');
      return {
        footer: box(element),
        buttons: [...element.querySelectorAll('button')].map((node) => ({ text: node.textContent.trim(), ...box(node) })),
        dock: box(document.querySelector('.desktop-dock')),
        viewportHeight: innerHeight,
        outerOverflow: document.documentElement.scrollWidth > innerWidth,
        contentOverflow: content.scrollWidth > content.clientWidth + 1,
      };
    });
    assert.equal(measurements.outerOverflow || measurements.contentOverflow, false, `${phase}: update content must fit horizontally`);
    for (const button of measurements.buttons) {
      assert.ok(button.height >= 40, `${phase}: ${button.text} needs a reachable target`);
      assert.ok(button.x >= measurements.footer.x - 1 && button.right <= measurements.footer.right + 1, `${phase}: footer button escapes its row`);
      assert.ok(button.y >= 0 && button.bottom <= measurements.viewportHeight, `${phase}: footer control must scroll into view`);
      assert.ok(button.bottom <= measurements.dock.y - 4, `${phase}: footer must clear the dock`);
    }
    for (let left = 0; left < measurements.buttons.length; left += 1) {
      for (let right = left + 1; right < measurements.buttons.length; right += 1) {
        const a = measurements.buttons[left];
        const b = measurements.buttons[right];
        const intersects = a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
        assert.equal(intersects, false, `${phase}: footer controls overlap`);
        if (Math.abs(a.y - b.y) < 2) assert.ok(Math.abs(a.cy - b.cy) < 1, `${phase}: same-row controls need matching centres`);
      }
    }
    geometry.push({ mode, phase, ...measurements });
  };
  const shot = async (mode, phase) => {
    if (capture) await capture(`${mode}-update-${phase}`, { scrollTop: false });
  };
  const expectReadonlyReview = async () => {
    const editor = wizard().locator('.cm-content').first();
    await editor.waitFor();
    const before = await editor.innerText();
    await editor.click();
    await page.keyboard.insertText('blocked fixture edit');
    assert.equal(await editor.innerText(), before, 'review editors must reject changes');
  };

  try {
    for (const mode of modes) {
      currentMode = mode;
      failure = null;
      configGate = null;
      composeGate = gate();
      rejectUpdate = false;
      updateGate = null;
      await open();
      if (!(await page.locator(`.desktop[data-desktop-mode="${mode}"]`).count())) {
        await page.getByRole('button', { name: `Switch to ${mode} mode`, exact: true }).click();
        await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
        await page.waitForTimeout(400);
      }
      await triggers().first().focus();
      for (let index = 1; index < steps.length; index += 1) {
        await page.keyboard.press('Tab');
        assert.equal(
          await triggers()
            .nth(index)
            .evaluate((node) => document.activeElement === node),
          true,
        );
        assert.equal(await active(), steps[0], 'Tab focus must not activate a step');
      }
      const focus = await triggers()
        .last()
        .evaluate((node) => {
          const probe = document.createElement('span');
          probe.style.color = getComputedStyle(document.querySelector('.desktop')).getPropertyValue('--desktop-focus');
          document.body.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          const style = getComputedStyle(node);
          return { actual: style.outlineColor, expected, visible: style.outlineStyle !== 'none' };
        });
      assert.equal(focus.actual, focus.expected, 'step keyboard focus must use the Orbis theme');
      assert.equal(focus.visible, true);
      await footerFits(mode, 'information');
      await shot(mode, 'information');
      await wizard().getByRole('button', { name: 'Next', exact: true }).click();
      assert.equal(await active(), steps[1]);
      await expectReadonlyReview();
      await footerFits(mode, 'configuration');
      await shot(mode, 'configuration');
      await wizard().getByRole('button', { name: 'Next', exact: true }).click();
      assert.equal(await active(), steps[2]);
      await expectSteps();
      await wizard().getByRole('status').waitFor();
      assert.equal(await wizard().getByRole('status').innerText(), 'Loading', 'loading must use a translated status');
      await footerFits(mode, 'compose-loading');
      await shot(mode, 'compose-loading');
      await wizard().getByRole('button', { name: 'Next', exact: true }).click();
      assert.equal(await active(), steps[3]);
      assert.equal(await backup().getAttribute('aria-checked'), 'true', 'backup must default to true');
      assert.equal(await submit().isDisabled(), true, 'pending Compose must block Update');
      const blockedAt = mutations.length;
      await submit().evaluate((node) => node.click());
      assert.equal(mutations.length, blockedAt);
      await backup().click();
      assert.equal(await backup().getAttribute('aria-checked'), 'false');
      const reviewCount = reviews.length;
      await page.getByRole('button', { name: 'Minimize Applications', exact: true }).click();
      await page.getByRole('button', { name: 'Restore Applications', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Restore Applications', exact: true }).click();
      await wizard().waitFor();
      assert.equal(await active(), steps[3]);
      assert.equal(await backup().getAttribute('aria-checked'), 'false', 'restore must retain the backup choice');
      assert.equal(reviews.length, reviewCount, 'minimize/restore must retain the loaded review');
      assert.equal(await submit().isDisabled(), true);
      composeGate.release();
      composeGate = null;
      await submit().waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('[data-testid="app-update"] .app-update-navigation button:last-child').disabled);
      await expectSteps();
      await step(steps[2]);
      await expectReadonlyReview();
      await footerFits(mode, 'compose-ready');
      await shot(mode, 'compose-ready');
      await step(steps[3]);
      await footerFits(mode, 'backup-ready');
      await shot(mode, 'backup');

      rejectUpdate = true;
      updateGate = gate();
      const pendingAt = mutations.length;
      await submit().click();
      await page.waitForFunction(() => document.querySelector('[data-testid="app-update"]')?.getAttribute('aria-busy') === 'true');
      assert.equal(mutations.length, pendingAt + 1);
      assert.equal(mutations.at(-1).body.performBackup, false);
      for (const trigger of await triggers().all()) {
        assert.equal(await trigger.isDisabled(), true, 'pending mutation must disable every step trigger');
        await trigger.evaluate((node) => node.click());
      }
      assert.equal(await active(), steps[3], 'disabled step triggers must not activate');
      assert.equal(await backup().isDisabled(), true);
      assert.equal(await wizard().getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
      assert.equal(await wizard().getByRole('button', { name: 'Back', exact: true }).isDisabled(), true);
      await footerFits(mode, 'update-pending');
      await shot(mode, 'pending');
      updateGate.release();
      updateGate = null;
      await page.getByText('Fixture update rejected', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('[data-testid="app-update"]')?.getAttribute('aria-busy') === 'false');
      assert.equal(new URL(page.url()).pathname, updatePath, 'HTTP rejection must keep the wizard open');
      assert.equal(await active(), steps[3]);
      assert.equal(await backup().getAttribute('aria-checked'), 'false');
      assert.equal(await submit().isEnabled(), true);
      await shot(mode, 'rejected');
      rejectUpdate = false;
      await submit().click();
      await page.waitForURL(`${base}/apps`);
      assert.equal(mutations.at(-1).body.performBackup, false, 'unchecked backup must reach the accepted mutation');

      await open();
      await step(steps[3]);
      await page.waitForFunction(() => !document.querySelector('[data-testid="app-update"] .app-update-navigation button:last-child').disabled);
      assert.equal(await backup().getAttribute('aria-checked'), 'true');
      await submit().click();
      await page.waitForURL(`${base}/apps`);
      assert.equal(mutations.at(-1).body.performBackup, true, 'default backup must reach the accepted mutation');

      for (const error of failures) {
        failure = error;
        await open();
        await step(steps[3]);
        await wizard().getByRole('alert').waitFor();
        assert.equal(await submit().isDisabled(), true, `${error} must block Update`);
        if (error === 'config-missing-new' || error === 'compose-null-new') {
          await step(error === 'config-missing-new' ? steps[1] : steps[2]);
          assert.equal(await wizard().locator('.cm-content').count(), 0, 'missing review content must not render an empty editor');
          await step(steps[3]);
        }
        const beforeRetry = mutations.length;
        await submit().evaluate((node) => node.click());
        assert.equal(mutations.length, beforeRetry);
        await footerFits(mode, error);
        if (error === 'config-http' || error === 'compose-invalid-new') await shot(mode, error);
        failure = null;
        const delayedKind = error === 'config-http' ? 'compose' : error === 'compose-http' ? 'config' : null;
        if (delayedKind === 'compose') composeGate = gate();
        if (delayedKind === 'config') configGate = gate();
        const readyKind = delayedKind === 'compose' ? 'config' : 'compose';
        const readyResponse = delayedKind
          ? page.waitForResponse((response) => decodeURIComponent(new URL(response.url()).pathname) === endpoints[readyKind])
          : null;
        await wizard().getByRole('button', { name: 'Retry review', exact: true }).click();
        if (readyResponse) {
          await readyResponse;
          await page.waitForTimeout(100);
          assert.equal(await submit().isDisabled(), true, 'cached valid data must not enable Update while its review refetches');
          if (composeGate) {
            composeGate.release();
            composeGate = null;
          }
          if (configGate) {
            configGate.release();
            configGate = null;
          }
        }
        await wizard().getByRole('alert').waitFor({ state: 'hidden' });
        await page.waitForFunction(() => !document.querySelector('[data-testid="app-update"] .app-update-navigation button:last-child').disabled);
        assert.equal(await active(), steps[3], 'Retry must preserve the selected step');
        assert.equal(await backup().getAttribute('aria-checked'), 'true');
        assert.equal(mutations.length, beforeRetry, 'Retry review must not submit an update');
      }
      failure = null;
      results.push({
        mode,
        stableFourSteps: true,
        tabDoesNotActivate: true,
        themeFocus: true,
        disabledTriggers: true,
        delayedComposeBlocksUpdate: true,
        retryRecoversFailures: failures.length,
        refetchBlocksUpdate: true,
        rejectedUpdateRetainsWizardAndChoice: true,
        backupTrueAndFalse: true,
        acceptedUpdatesNavigate: true,
        minimizeRestore: true,
      });
    }
    return { results, mutations, geometry };
  } catch (error) {
    await shot(currentMode, 'failure').catch(() => undefined);
    throw error;
  } finally {
    for (const pending of gates) pending.release();
    await page.unroute(match, handler);
  }
};
