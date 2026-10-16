const assert = require('node:assert/strict');
const inspectCurrentSettingsAlignment = require('./settings-alignment-checks.cjs');

// Run on a dedicated static8080 page with visual-qa's API fixtures installed.
module.exports = async function inspectPageNavigation(
  page,
  { base = new URL(page.url()).origin, capture, getPreferences, modes = ['light', 'dark'], textScales = [1] } = {},
) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '8080', 'page checks require static8080 fixtures');
  const smallViewport = page.viewportSize();
  assert.ok(smallViewport.width < 1100 || smallViewport.height < 640, 'page checks require a small-screen viewport');
  assert.ok(
    textScales.every((scale) => scale === 1 || scale === 2),
    'page text scale must be native or doubled',
  );
  const unexpectedWrites = [];
  const samples = [];
  let sequence = 0;
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin.origin || !url.pathname.startsWith('/api/')) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.pathname !== '/api/desktop-preferences')
      unexpectedWrites.push({ method: request.method(), path: url.pathname });
  };
  page.on('request', onRequest);
  const waitFor = async (condition, message) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await condition()) return;
      await page.waitForTimeout(50);
    }
    assert.fail(typeof message === 'function' ? message() : message);
  };
  const restoreText = () =>
    page.evaluate(() => {
      for (const [element, properties] of window.__orbisPageTextOriginals ?? [])
        if (element.isConnected)
          for (const [name, value, priority] of properties) {
            if (value) element.style.setProperty(name, value, priority);
            else element.style.removeProperty(name);
          }
      window.__orbisPageTextOriginals = [];
    });
  const scaleText = async (scale) => {
    await restoreText();
    await page.evaluate(() => document.fonts.ready);
    if (scale === 1) return;
    await page.evaluate(() => {
      const baseline = [...document.querySelectorAll('body,body *')]
        .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName))
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            element,
            font: Number.parseFloat(style.fontSize),
            line: Number.parseFloat(style.lineHeight),
            original: ['font-size', 'line-height'].map((name) => [
              name,
              element.style.getPropertyValue(name),
              element.style.getPropertyPriority(name),
            ]),
          };
        });
      for (const { element, font, line, original } of baseline) {
        window.__orbisPageTextOriginals.push([element, original]);
        if (Number.isFinite(font)) element.style.setProperty('font-size', `${font * 2}px`, 'important');
        if (Number.isFinite(line)) element.style.setProperty('line-height', `${line * 2}px`, 'important');
      }
    });
  };
  const preferenceSnapshot = async () =>
    structuredClone(
      getPreferences ? await getPreferences() : await page.evaluate(() => JSON.parse(localStorage.getItem('server-desktop-preferences-v1') ?? '{}')),
    );
  const dock = () => page.getByRole('navigation', { name: 'Desktop tools', exact: true });
  const serverName = () => page.getByRole('textbox', { name: 'Server name', exact: true });
  const geometry = () =>
    page.evaluate(() => {
      const main = document.querySelector('#desktop-content');
      const root = main.firstElementChild;
      const box = (element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const active = document.activeElement;
      return {
        documentY: scrollY,
        documentHeight: document.documentElement.scrollHeight,
        documentWidth: document.documentElement.scrollWidth,
        viewport: { width: innerWidth, height: innerHeight },
        main: box(main),
        root: box(root),
        rootPosition: getComputedStyle(root).position,
        contentOverflow: getComputedStyle(root.querySelector('.desktop-window-content')).overflowY,
        systemBar: box(document.querySelector('.desktop-system-bar')),
        dock: box(document.querySelector('.desktop-dock')),
        active: { inside: main.contains(active), tag: active.tagName, text: active.textContent.trim().slice(0, 100), box: box(active) },
      };
    });
  const assertPage = async (sample, state, { focused = false } = {}) => {
    await page.locator('.desktop-route-window[data-window-navigation="page"][data-window-mode="page"]').waitFor();
    await waitFor(
      async () =>
        (await page.locator('.desktop-window-controls,.desktop-window-resize,.desktop-window-resume,.desktop-window-keyboard-help').count()) === 0,
      `${state}: small pages must not mount window controls or minimized restore UI`,
    );
    assert.equal(await page.getByRole('toolbar', { name: / window$/ }).count(), 0, `${state}: small pages have no window toolbar`);
    assert.equal(await page.locator('.desktop-page-heading h1').count(), 1, `${state}: small sections have one compact page heading`);
    assert.equal(await page.locator('.desktop-dock-item.is-minimized').count(), 0, `${state}: small dock sections cannot be minimized`);
    assert.equal(new URL(page.url()).searchParams.has('orbisWindow'), false, `${state}: small routes cannot retain hidden window state`);
    let value;
    await waitFor(
      async () => {
        value = await geometry();
        return !focused || (value.active.inside && value.active.box.y >= value.systemBar.bottom + 1 && value.active.box.bottom <= value.dock.y - 1);
      },
      () => `${state}: native focus must clear the sticky system bar and fixed dock: ${JSON.stringify(value)}`,
    );
    assert.notEqual(value.rootPosition, 'fixed', `${state}: small sections must use document flow`);
    assert.equal(value.contentOverflow, 'visible', `${state}: small section content must scroll with the document`);
    assert.ok(value.main.height > 0, `${state}: the page main must retain normal layout height`);
    assert.ok(value.documentWidth <= value.viewport.width + 1, `${state}: small pages cannot overflow horizontally`);
    sample.states.push({ state, ...value });
    return value;
  };
  const shot = (sample, state) => capture?.(`${sample.mode}-text${sample.textScale}-page-${state}`, { scrollTop: false });
  const appearanceLabels = () =>
    page.locator('.appearance-preset strong,.appearance-preset small,.appearance-wallpaper strong').evaluateAll((labels) =>
      labels.map((label) => {
        const button = label.closest('button').getBoundingClientRect();
        const words = [];
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          for (const match of node.textContent.matchAll(/[\p{L}\p{N}]+/gu)) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            words.push({
              text: match[0],
              parts: [...range.getClientRects()].map((rect) => ({ left: rect.left - button.left, right: button.right - rect.right })),
            });
          }
        }
        return { label: label.textContent.trim(), words };
      }),
    );
  const openAppearance = async (mode, textScale, query = `probe=page-${++sequence}`) => {
    await restoreText();
    await page.goto(`${base}/settings?tab=appearance&${query}`, { waitUntil: 'domcontentloaded' });
    await serverName().waitFor();
    if ((await page.locator('.desktop').getAttribute('data-desktop-mode')) !== mode)
      await page.getByRole('button', { name: `Switch to ${mode} mode`, exact: true }).click();
    await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
    await scaleText(textScale);
  };

  try {
    for (const mode of modes)
      for (const textScale of textScales) {
        await page.setViewportSize(smallViewport);
        const sample = { mode, textScale, states: [] };
        await openAppearance(mode, textScale);
        const beforeWheel = await assertPage(sample, 'initial');
        sample.settingsAlignment = await inspectCurrentSettingsAlignment(page);
        sample.appearanceLabels = await appearanceLabels();
        for (const label of sample.appearanceLabels)
          for (const word of label.words) {
            assert.equal(word.parts.length, 1, `Appearance words must remain whole: ${JSON.stringify(label)}`);
            assert.ok(
              word.parts.every((part) => part.left >= 10 && part.right >= 10),
              `Appearance text needs side padding: ${JSON.stringify(label)}`,
            );
          }
        const direction = beforeWheel.documentY < beforeWheel.documentHeight - smallViewport.height - 1 ? 160 : -160;
        await page.mouse.move(smallViewport.width / 2, (beforeWheel.systemBar.bottom + beforeWheel.dock.y) / 2);
        await page.mouse.wheel(0, direction);
        if (beforeWheel.documentHeight > smallViewport.height + 1)
          await waitFor(
            async () => Math.abs((await geometry()).documentY - beforeWheel.documentY) > 1,
            'wheel must scroll the ordinary page document',
          );
        const afterWheel = await assertPage(sample, 'ordinary-wheel');
        assert.ok(Math.abs(afterWheel.systemBar.y - beforeWheel.systemBar.y) <= 1, 'system bar must stay pinned during document scrolling');
        await shot(sample, 'wheel');

        const lastButton = page.locator('.appearance button').last();
        await lastButton.focus();
        await assertPage(sample, 'native-last-focus', { focused: true });
        await page.keyboard.press('Shift+Tab');
        await assertPage(sample, 'native-shift-tab', { focused: true });
        await shot(sample, 'focus');

        await dock().getByRole('link', { name: 'Workspace', exact: true }).click();
        await page.waitForURL((url) => url.pathname === '/dashboard' && !url.searchParams.has('orbisWindow'));
        await page.locator('.workspace-heading h1').waitFor();
        assert.equal(
          await page.locator('.desktop-window-resume,.desktop-dock-item.is-minimized').count(),
          0,
          'Home is real navigation on small screens',
        );
        await openAppearance(mode, textScale);
        await page.locator('.desktop-brand').click();
        await page.waitForURL((url) => url.pathname === '/dashboard' && !url.searchParams.has('orbisWindow'));
        await page.locator('.workspace-heading h1').waitFor();
        sample.homeAndBrandNavigate = true;

        await restoreText();
        const historyBefore = await page.evaluate(() => history.length);
        const minimizedUrl = new URL(`${base}/settings?tab=appearance&probe=space%20value&probe=second&orbisWindow=minimized#draft`);
        await page.goto(minimizedUrl.href, { waitUntil: 'domcontentloaded' });
        await serverName().waitFor();
        await page.waitForURL((url) => !url.searchParams.has('orbisWindow'));
        const normalized = new URL(page.url());
        minimizedUrl.searchParams.delete('orbisWindow');
        assert.equal(normalized.pathname, minimizedUrl.pathname);
        assert.deepEqual(
          [...normalized.searchParams],
          [...minimizedUrl.searchParams],
          'small minimized cleanup must preserve all other query values',
        );
        assert.equal(normalized.hash, minimizedUrl.hash, 'small minimized cleanup must preserve the hash');
        assert.equal(await page.evaluate(() => history.length), historyBefore + 1, 'small minimized cleanup must replace, not push, history');
        await scaleText(textScale);
        await assertPage(sample, 'normalized-minimized-link');
        sample.minimizedDeepLink = true;

        const input = serverName();
        const inputIdentity = await input.elementHandle();
        const draft = `unsaved-${mode}-text${textScale}-page`;
        await input.fill(draft);
        await page.setViewportSize({ width: 1100, height: 640 });
        await page.getByRole('button', { name: 'Window layout', exact: true }).waitFor();
        assert.ok(await inputIdentity.evaluate((element) => element.isConnected), 'entering window mode must not remount the form');
        assert.equal(await input.inputValue(), draft, 'entering window mode must preserve the unsaved draft');
        await page.getByRole('button', { name: 'Window layout', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Floating window', exact: true }).click();
        await page.locator('.desktop-route-window[data-window-mode="floating"]').waitFor();
        await waitFor(
          async () => (await preferenceSnapshot()).windows?.settings?.mode === 'floating',
          'UI-selected placement must reach the preference fixture',
        );
        const savedPlacement = (await preferenceSnapshot()).windows.settings;
        assert.equal(JSON.stringify(await preferenceSnapshot()).includes(draft), false, 'unsaved page drafts must not be written to preferences');
        await shot(sample, 'floating');

        await input.focus();
        await page.setViewportSize({ width: 1100, height: 639 });
        await assertPage(sample, 'below-height-threshold', { focused: true });
        assert.ok(await inputIdentity.evaluate((element) => element.isConnected), 'the height breakpoint must not remount the form');
        assert.equal(await input.inputValue(), draft);
        assert.deepEqual((await preferenceSnapshot()).windows.settings, savedPlacement);
        await page.setViewportSize({ width: 1099, height: 640 });
        await assertPage(sample, 'below-width-threshold', { focused: true });
        await page.setViewportSize(smallViewport);
        await assertPage(sample, 'resized-small', { focused: true });
        assert.ok(await inputIdentity.evaluate((element) => element.isConnected), 'leaving window mode must not remount the form');
        assert.equal(await input.inputValue(), draft, 'leaving window mode must preserve the unsaved draft');
        assert.deepEqual((await preferenceSnapshot()).windows.settings, savedPlacement, 'small layout must not overwrite saved desktop placement');
        await page.setViewportSize({ width: 1100, height: 640 });
        await page.locator('.desktop-route-window[data-window-mode="floating"]').waitFor();
        assert.ok(await inputIdentity.evaluate((element) => element.isConnected), 'restoring saved window mode must preserve the form node');
        assert.equal(await input.inputValue(), draft);
        await page.setViewportSize(smallViewport);
        await assertPage(sample, 'saved-placement-small');
        assert.deepEqual((await preferenceSnapshot()).windows.settings, savedPlacement);
        assert.equal(await input.inputValue(), draft);
        await shot(sample, 'resized-small');
        sample.draftAndSavedPlacement = true;
        samples.push(sample);
        await inputIdentity.dispose();
      }
    assert.deepEqual(unexpectedWrites, [], 'page navigation must not submit lifecycle, settings, or unsaved forms');
    return { viewport: smallViewport, samples, unexpectedWrites };
  } finally {
    await restoreText();
    await page.setViewportSize(smallViewport);
    page.off('request', onRequest);
  }
};
