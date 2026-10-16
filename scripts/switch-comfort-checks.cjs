const assert = require('node:assert/strict');

module.exports = async function inspectSwitchComfort({ page, base, capture, modes = ['light', 'dark'], textScales = [1, 2] }) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '8080', 'switch checks require static8080 fixtures');
  const width = page.viewportSize().width;
  const report = { width, samples: [], blockedWrites: [] };
  let mode = 'light';
  let forceExpose = false;
  const respond = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const guard = (route) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.fallback();
    report.blockedWrites.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
    return route.abort('blockedbyclient');
  };
  const context = (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return respond(route, {
      version: { current: '4.10.1', latest: '4.10.1', body: '', releases: [] },
      userSettings: {
        allowAutoThemes: false,
        allowErrorMonitoring: false,
        localDomain: 'homelab.example.test',
        sslPort: 443,
        maxBackups: 5,
        guestDashboard: false,
        internalIp: '127.0.0.1',
        advancedSettings: true,
        timeZone: 'UTC',
        logLevel: 'info',
      },
      user: { id: 1, username: 'fixture@example.test', totpEnabled: false, locale: 'en', operator: true, hasSeenWelcome: true },
      apps: [],
      updatesAvailable: 0,
    });
  };
  const preferences = (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return respond(route, {
      serverName: 'Hades',
      preset: 'frost',
      mode,
      density: 'comfortable',
      wallpaper: 'sandstone',
      windows: {},
      workspace: { order: ['applications', 'activity', 'storage', 'attention'], hidden: [], wide: ['applications'], pinnedApps: [] },
    });
  };
  const stores = (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return respond(route, {
      appStores: [
        {
          slug: 'community',
          name: 'Community Media',
          enabled: true,
          url: 'https://github.com/sai-homelab/community-media-apps',
          branch: 'main',
          hash: 'fixture',
        },
      ],
    });
  };
  const app = (route) => {
    if (route.request().method() !== 'GET' || decodeURIComponent(new URL(route.request().url()).pathname) !== '/api/apps/photos:official')
      return route.fallback();
    return respond(route, {
      info: {
        id: 'photos',
        urn: 'photos:official',
        name: 'Photos',
        short_desc: 'A private photo archive',
        description: 'A fixture for switch controls.',
        version: '1.2.3',
        author: 'Fixture maintainer',
        source: 'https://example.com/source',
        website: 'https://example.com',
        available: true,
        supported_architectures: ['amd64', 'arm64'],
        categories: ['media'],
        dynamic_config: true,
        exposable: true,
        force_expose: forceExpose,
        port: 8123,
        form_fields: [
          {
            type: 'boolean',
            label: 'Enable automatic document processing',
            env_variable: 'PROCESSING',
            default: false,
            hint: 'Process local documents automatically after upload.',
          },
        ],
      },
      app: null,
      metadata: { latestVersion: 2, latestDockerVersion: '1.3.0', localSubdomain: 'photos-official', composeSchemaVersion: 2, hasCustomConfig: true },
    });
  };
  await page.route('**/api/**', guard);
  await page.route('**/api/app-context', context);
  await page.route('**/api/desktop-preferences', preferences);
  await page.route('**/api/marketplace/all', stores);
  await page.route('**/api/apps/**', app);
  const scaleText = (scale) =>
    page.evaluate((scale) => {
      if (scale === 1) return;
      const nodes = [...document.querySelectorAll('body,body *')]
        .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName))
        .map((element) => ({ element, font: Number.parseFloat(getComputedStyle(element).fontSize), line: getComputedStyle(element).lineHeight }));
      for (const { element, font, line } of nodes) {
        element.style.setProperty('font-size', `${font * scale}px`, 'important');
        if (line !== 'normal') element.style.setProperty('line-height', `${Number.parseFloat(line) * scale}px`, 'important');
      }
    }, scale);
  const open = async (route) => {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
  };
  const settle = (control) =>
    control.evaluate(async (element) => {
      const animations = new Set();
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement)
        for (const animation of ancestor.getAnimations()) {
          if (animation.playState !== 'finished' && animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY)
            animations.add(animation);
        }
      await Promise.all([...animations].map((animation) => animation.finished.catch(() => undefined)));
    });
  const center = async (control) => {
    await settle(control);
    await control.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await page.waitForTimeout(100);
  };
  const inspect = (control) =>
    control.evaluate((element) => {
      const box = (node) => {
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          centerY: rect.top + rect.height / 2,
        };
      };
      const wrapper = element.closest('label');
      const label = wrapper.querySelector('.form-check-label');
      const splitWords = [];
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest('svg,.form-help,.react-tooltip,[role="tooltip"],.visually-hidden')) continue;
        for (const match of node.textContent.matchAll(/[A-Za-z]{4,}/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rows = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.y * 10) / 10));
          if (rows.size > 1) splitWords.push(match[0]);
        }
      }
      return {
        track: box(element),
        label: box(label),
        wrapper: box(wrapper),
        checked: element.getAttribute('aria-checked') === 'true',
        id: element.id,
        labelFor: wrapper.htmlFor,
        labelId: label.id,
        labelledBy: element.getAttribute('aria-labelledby'),
        text: label.textContent.trim(),
        splitWords,
        background: getComputedStyle(element).backgroundColor,
        thumb: getComputedStyle(element).backgroundImage,
        documentWidth: document.documentElement.scrollWidth,
        tabIndex: element.tabIndex,
      };
    });
  const check = (geometry, native) => {
    assert.ok(Math.abs(geometry.track.centerY - geometry.label.centerY) <= 0.75, `track and label centres must align: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.label.left - geometry.track.right >= 9.4, `switch label needs10px breathing room: ${JSON.stringify(geometry)}`);
    assert.ok(
      geometry.track.left >= geometry.wrapper.left - 1 && geometry.label.right <= geometry.wrapper.right + 1,
      'switch contents must fit their wrapper',
    );
    assert.ok(geometry.track.width >= 28 && geometry.track.height >= 18, 'switch track must keep its usable dimensions');
    assert.ok(
      Math.abs(geometry.track.width - native.track.width) <= 0.75 && Math.abs(geometry.track.height - native.track.height) <= 0.75,
      'text scaling must not shrink or enlarge the track',
    );
    assert.deepEqual(geometry.splitWords, [], 'ordinary switch label words must not fracture');
    assert.ok(geometry.documentWidth <= width + 1, 'switch labels must not expand the document');
    assert.ok(
      geometry.id && geometry.labelFor === geometry.id && geometry.labelledBy === geometry.labelId,
      'label, control and accessible name must share a stable association',
    );
    assert.equal(geometry.tabIndex, 0, 'enabled switches must remain keyboard reachable');
  };
  const textPoint = (control) =>
    control.evaluate((element) => {
      const label = element.closest('label').querySelector('.form-check-label');
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest('button,a,.form-help,.react-tooltip,[role="tooltip"],.visually-hidden')) continue;
        const match = node.textContent.match(/\S+/);
        if (!match) continue;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rect = [...range.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0);
        if (rect) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      throw new Error('No noninteractive visible switch label text');
    });
  const expectChecked = async (control, checked) => {
    await page.waitForFunction(
      (element) => element.control.getAttribute('aria-checked') === String(element.checked),
      { control: await control.elementHandle(), checked },
      { timeout: 2000 },
    );
  };
  const exercise = async (control, native, name, prefix) => {
    await center(control);
    const initial = await inspect(control);
    check(initial, native);
    const point = await textPoint(control);
    assert.equal(
      await page.evaluate(({ point, id }) => document.elementFromPoint(point.x, point.y)?.closest('label')?.htmlFor === id, {
        point,
        id: initial.id,
      }),
      true,
      'pointer must hit actual associated label text after scrolling',
    );
    await page.mouse.click(point.x, point.y);
    await expectChecked(control, !initial.checked);
    const labelClick = await inspect(control);
    check(labelClick, native);
    await capture?.(`${prefix}-${name}-label-toggle`, { scrollTop: false });
    await control.click();
    await expectChecked(control, initial.checked);
    await control.focus();
    assert.equal(await control.evaluate((element) => element === document.activeElement), true, 'switch focus must remain on the control');
    await page.keyboard.press('Space');
    await expectChecked(control, !initial.checked);
    const keyboard = await inspect(control);
    check(keyboard, native);
    await page.keyboard.press('Enter');
    await expectChecked(control, initial.checked);
    const keyboardReset = await inspect(control);
    check(keyboardReset, native);
    assert.equal(keyboardReset.id, initial.id, 'switch ID must remain stable across updates');
    await capture?.(`${prefix}-${name}-keyboard-reset`, { scrollTop: false });
    const help = control.locator('xpath=ancestor::label').locator('.form-help').first();
    let helpCheck;
    if (await help.count()) {
      await help.click();
      await page.waitForTimeout(200);
      assert.equal(await control.getAttribute('aria-checked'), String(initial.checked), 'help click must not activate its surrounding switch label');
      await page.getByRole('tooltip').first().waitFor({ state: 'visible', timeout: 2000 });
      helpCheck = { checked: initial.checked, tooltipVisible: true };
      await capture?.(`${prefix}-${name}-help`, { scrollTop: false });
      await page.mouse.move(0, 0);
    }
    return { initial, labelClick, keyboard, keyboardReset, help: helpCheck };
  };
  try {
    for (const currentMode of modes)
      for (const scale of textScales) {
        mode = currentMode;
        const prefix = `${mode}-text${scale * 100}`;
        const sample = { mode, textScale: scale, controls: {} };
        await open('/settings?tab=appstores');
        await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
        const edit = page.getByRole('dialog');
        const enabled = edit.getByRole('switch', { name: 'Enabled', exact: true });
        await enabled.waitFor();
        await settle(enabled);
        const nativeEnabled = await inspect(enabled);
        await scaleText(scale);
        sample.controls.enabled = await exercise(enabled, nativeEnabled, 'enabled', prefix);
        await page.keyboard.press('Escape');
        await open('/settings?tab=settings');
        const guest = page.getByRole('switch', { name: /Enable guest dashboard/ });
        const monitoring = page.getByRole('switch', { name: /Allow anonymous error monitoring/ });
        await guest.waitFor();
        await settle(guest);
        const nativeGuest = await inspect(guest);
        const nativeMonitoring = await inspect(monitoring);
        await scaleText(scale);
        sample.controls.guest = await exercise(guest, nativeGuest, 'guest', prefix);
        sample.controls.monitoring = await exercise(monitoring, nativeMonitoring, 'monitoring', prefix);
        forceExpose = false;
        await open('/app-store/official/photos');
        await page.locator('.app-actions').getByRole('button', { name: 'Install', exact: true }).click();
        const install = page.getByRole('dialog');
        const processing = install.getByRole('switch', { name: /Enable automatic document processing/ });
        const forcePull = install.getByRole('switch', { name: /Force image pull on startup/ });
        await processing.waitFor();
        await settle(processing);
        const nativeProcessing = await inspect(processing);
        const nativeForcePull = await inspect(forcePull);
        await scaleText(scale);
        sample.controls.processing = await exercise(processing, nativeProcessing, 'processing', prefix);
        sample.controls.forcePull = await exercise(forcePull, nativeForcePull, 'force-pull', prefix);
        await page.keyboard.press('Escape');
        forceExpose = true;
        await open('/app-store/official/photos');
        await page.locator('.app-actions').getByRole('button', { name: 'Install', exact: true }).click();
        const disabled = page.getByRole('dialog').getByRole('switch', { name: /Open port/ });
        await disabled.waitFor();
        await scaleText(scale);
        await center(disabled);
        assert.equal(await disabled.isDisabled(), true, 'required exposure must disable the port toggle');
        const disabledInitial = await disabled.getAttribute('aria-checked');
        const point = await textPoint(disabled);
        await page.mouse.click(point.x, point.y);
        await disabled.evaluate((element) => element.focus());
        assert.equal(await disabled.evaluate((element) => element === document.activeElement), false, 'disabled switch must not take keyboard focus');
        assert.equal(await disabled.getAttribute('aria-checked'), disabledInitial, 'disabled label click must not toggle');
        await capture?.(`${prefix}-disabled`, { scrollTop: false });
        await page.keyboard.press('Escape');
        report.samples.push(sample);
      }
    assert.deepEqual(
      report.blockedWrites.filter((request) => request.path !== '/api/desktop-preferences'),
      [],
      'switch toggles must not mutate actual app/host/auth APIs',
    );
    return report;
  } catch (error) {
    await capture?.('switch-comfort-failure', { scrollTop: false }).catch(() => undefined);
    throw error;
  } finally {
    await page.unroute('**/api/apps/**', app);
    await page.unroute('**/api/marketplace/all', stores);
    await page.unroute('**/api/desktop-preferences', preferences);
    await page.unroute('**/api/app-context', context);
    await page.unroute('**/api/**', guard);
  }
};
