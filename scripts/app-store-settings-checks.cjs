const assert = require('node:assert/strict');

// All store operations are fulfilled on static8080; no request reaches a homelab.
module.exports = async function inspectAppStoreSettings({
  page,
  base,
  capture,
  modes = ['light', 'dark'],
  textScales = [1, 2],
  surfacesOnly = false,
}) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '8080');
  const initial = [
    {
      slug: 'sync-qa',
      name: 'Synchronization',
      enabled: true,
      url: 'https://github.com/orbis-homelab-community/self-hosted-application-catalogue-for-private-home-servers-and-storage-services',
    },
    { slug: 'self-qa', name: 'Self Hosted Apps', enabled: false, url: 'https://github.com/orbis-community/app-store' },
  ];
  let stores = structuredClone(initial);
  const createUrl = `${initial[0].url}-additional-repository`;
  let mode = 'light';
  let listError = false;
  let listDelay = 0;
  const pending = [];
  const requests = [];
  const unexpectedWrites = [];
  const report = { viewport: page.viewportSize(), samples: [], requests, unexpectedWrites };
  const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === '/api/desktop-preferences')
      return respond(route, {
        serverName: 'Hades',
        preset: 'frost',
        mode,
        density: 'comfortable',
        wallpaper: 'sandstone',
        workspace: { order: ['applications', 'activity', 'storage', 'attention'], hidden: [], wide: ['applications'], pinnedApps: [] },
      });
    if (url.pathname === '/api/marketplace/all') {
      if (listDelay) {
        const delay = listDelay;
        listDelay = 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return listError
        ? respond(route, { message: 'Unable to load app stores. Check the server connection and retry.' }, 500)
        : respond(route, { appStores: stores });
    }
    if (['POST', 'PATCH', 'DELETE'].includes(method) && /^\/api\/marketplace\/(create|sync-qa|self-qa|added-qa)$/.test(url.pathname)) {
      const item = { method, path: url.pathname, body: JSON.parse(request.postData() || '{}'), reply: null };
      if (method === 'PATCH') {
        assert.deepEqual(Object.keys(item.body).sort(), ['enabled', 'name'], 'store edit must send only its declared fields');
        assert.equal(typeof item.body.name, 'string');
        assert.equal(typeof item.body.enabled, 'boolean');
      }
      requests.push({ method, path: item.path, body: item.body });
      pending.push(item);
      const response = await new Promise((resolve) => {
        item.reply = resolve;
      });
      if (response.success) {
        listDelay = 250;
        if (method === 'POST') stores.push({ ...item.body, slug: 'added-qa', enabled: true });
        if (method === 'PATCH') stores = stores.map((store) => (store.slug === url.pathname.split('/').at(-1) ? { ...store, ...item.body } : store));
        if (method === 'DELETE') {
          stores = stores.filter((store) => store.slug !== url.pathname.split('/').at(-1));
        }
      }
      return respond(
        route,
        response.success ? { success: true } : { message: response.message, intlParams: response.intlParams },
        response.success ? 200 : (response.status ?? 400),
      );
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      unexpectedWrites.push({ method, path: url.pathname });
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  };
  await page.route('**/api/**', handler);
  const restore = () =>
    page.evaluate(() => {
      for (const [element, properties] of window.__orbisStoreTextOriginals ?? [])
        if (element.isConnected)
          for (const [name, value, priority] of properties) {
            if (value) element.style.setProperty(name, value, priority);
            else element.style.removeProperty(name);
          }
      window.__orbisStoreTextOriginals = [];
    });
  const scaleText = async (scale) => {
    await restore();
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
        window.__orbisStoreTextOriginals.push([element, original]);
        if (Number.isFinite(font)) element.style.setProperty('font-size', `${font * 2}px`, 'important');
        if (Number.isFinite(line)) element.style.setProperty('line-height', `${line * 2}px`, 'important');
      }
    });
  };
  const windowGeometry = () =>
    page.evaluate(() => {
      const frame = document.querySelector('.desktop-route-window');
      const content = frame.querySelector('.desktop-window-content');
      const toolbar = frame.querySelector('.desktop-window-bar');
      const box = (element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const scrollsFrame = frame.dataset.windowScrollsFrame === 'true';
      const scroller = scrollsFrame ? frame : content;
      const viewport = box(scroller);
      viewport.x += scroller.clientLeft;
      viewport.y += scroller.clientTop;
      viewport.right = viewport.x + scroller.clientWidth;
      viewport.bottom = viewport.y + scroller.clientHeight;
      const active = document.activeElement;
      return {
        documentY: scrollY,
        frame: box(frame),
        toolbar: box(toolbar),
        systemBar: box(document.querySelector('.desktop-system-bar')),
        dock: box(document.querySelector('.desktop-dock')),
        frameOverflow: getComputedStyle(frame).overflowY,
        scrollsFrame,
        scroller: { viewport, top: scroller.scrollTop, height: scroller.scrollHeight, clientHeight: scroller.clientHeight },
        active: {
          inside: frame.contains(active),
          tag: active.tagName,
          text: active.textContent.trim().slice(0, 100),
          fallback: active.hasAttribute('data-dialog-focus-fallback'),
          box: box(active),
        },
      };
    });
  const checkWindow = async (sample, state, { focused = false, expected } = {}) => {
    let geometry;
    let expectedFocused = !expected;
    const fits = (value) => {
      const { frame, toolbar, systemBar, dock, active, scroller, scrollsFrame } = value;
      const verticalOverlap = Math.min(active.box.bottom, scroller.viewport.bottom) - Math.max(active.box.y, scroller.viewport.y);
      const focusFits =
        active.inside &&
        (active.fallback
          ? verticalOverlap >= Math.min(44, active.box.height) - 1
          : active.box.y >= scroller.viewport.y - 1 && active.box.bottom <= scroller.viewport.bottom + 1);
      return (
        Math.abs(value.documentY) <= 1 &&
        frame.y >= systemBar.bottom + 19 &&
        frame.bottom <= dock.y - 19 &&
        ['auto', 'hidden', 'clip'].includes(value.frameOverflow) &&
        (scrollsFrame || (toolbar.y >= frame.y - 1 && toolbar.bottom <= frame.bottom + 1)) &&
        (!focused || focusFits)
      );
    };
    for (let attempt = 0; attempt < 40; attempt++) {
      geometry = await windowGeometry();
      if (expected) expectedFocused = await expected.evaluate((element) => element === document.activeElement);
      if (fits(geometry) && expectedFocused) break;
      await page.waitForTimeout(50);
    }
    sample.windowChecks.push({ state, ...geometry, expectedFocused });
    assert.ok(fits(geometry), `${state}: window chrome and focused content must stay inside the bar/dock workspace: ${JSON.stringify(geometry)}`);
    assert.ok(expectedFocused, `${state}: dialog must return focus to its opener or surviving fallback`);
    return geometry;
  };
  const checkWheel = async (sample) => {
    const before = await checkWindow(sample, 'before-wheel');
    const viewport = before.scroller.viewport;
    await page.mouse.move(viewport.x + (viewport.right - viewport.x) / 2, viewport.y + (viewport.bottom - viewport.y) / 2);
    await page.mouse.wheel(0, 160);
    if (before.scroller.height > before.scroller.clientHeight + before.scroller.top + 1) {
      await page.waitForFunction(
        (top) => {
          const frame = document.querySelector('.desktop-route-window');
          const scroller = frame.dataset.windowScrollsFrame === 'true' ? frame : frame.querySelector('.desktop-window-content');
          return scroller.scrollTop > top + 1;
        },
        before.scroller.top,
        { timeout: 2000 },
      );
    }
    const after = await checkWindow(sample, 'ordinary-wheel');
    assert.ok(Math.abs(after.frame.y - before.frame.y) <= 1, 'ordinary wheel scrolling must not move the tool window');
    await capture?.(`${sample.mode}-text${sample.textScale}-window-wheel`, { scrollTop: false });
  };
  const measure = (rootSelector) =>
    page
      .locator(rootSelector)
      .first()
      .evaluate((root) => {
        const box = (element) => {
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const words = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.parentElement.closest('svg,input,a[href^="https://"],.visually-hidden,[hidden]')) continue;
          for (const match of node.textContent.matchAll(/[A-Za-z]{4,}/g)) {
            if ([...node.textContent.matchAll(/https?:\/\/\S+/g)].some((url) => match.index >= url.index && match.index < url.index + url[0].length))
              continue;
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const rects = [...range.getClientRects()].filter((r) => r.width > 0);
            if (new Set(rects.map((r) => Math.round(r.y * 10))).size > 1) words.push(match[0]);
          }
        }
        const clippedWords = [...root.querySelectorAll('.orbis-whole-word')]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.textContent);
        const buttons = [...root.querySelectorAll('button')]
          .filter((element) => element.offsetWidth > 0)
          .map((element) => {
            const style = getComputedStyle(element);
            const range = document.createRange();
            range.selectNodeContents(element);
            return {
              text: element.textContent.trim(),
              box: box(element),
              ink: box({ getBoundingClientRect: () => range.getBoundingClientRect() }),
              paddingLeft: Number.parseFloat(style.paddingLeft),
              paddingRight: Number.parseFloat(style.paddingRight),
              busy: element.getAttribute('aria-busy'),
              disabled: element.disabled,
            };
          });
        return {
          box: box(root),
          words,
          clippedWords,
          buttons,
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: document.documentElement.scrollWidth,
          horizontalScroll: [...root.querySelectorAll('.table-responsive')].map((element) => ({
            box: box(element),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            scrollLeft: element.scrollLeft,
          })),
        };
      });
  const snap = async (sample, state, selector = '.desktop-settings') => {
    await scaleText(sample.textScale);
    await page.waitForTimeout(280);
    const geometry = await measure(selector);
    sample.states.push({ state, geometry });
    if (geometry.words.length) sample.findings.push({ state, issue: 'split ordinary words', words: geometry.words });
    if (geometry.clippedWords.length) sample.findings.push({ state, issue: 'truncated ordinary words', words: geometry.clippedWords });
    if (geometry.documentWidth > geometry.viewport.width + 1)
      sample.findings.push({ state, issue: 'document overflow', width: geometry.documentWidth });
    for (const button of geometry.buttons)
      if (button.text && !button.busy?.includes('true') && (button.ink.x < button.box.x + 8 || button.ink.right > button.box.right - 8))
        sample.findings.push({ state, issue: 'button text lacks side room', button });
    if (selector !== '[role="dialog"]' && selector !== '.orbis-error') await checkWindow(sample, state);
    if (selector === '[role="dialog"]') {
      const errorAlignments = await page
        .getByRole('dialog')
        .locator('.app-store-error')
        .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).textAlign));
      assert.ok(
        errorAlignments.every((alignment) => alignment === 'left'),
        'store errors must share left-aligned copy',
      );
      assert.ok(geometry.box.y >= 15 && geometry.box.bottom <= geometry.viewport.height - 15, 'dialog must keep viewport insets');
      for (const button of geometry.buttons)
        assert.ok(
          button.box.y >= geometry.box.y && button.box.bottom <= geometry.box.bottom + 1,
          'dialog footer and close control stay inside the panel',
        );
      if (state.endsWith('-pending')) {
        const inputs = await page
          .getByRole('dialog')
          .locator('input,[role="switch"]')
          .evaluateAll((elements) => elements.map((element) => element.disabled));
        assert.ok(inputs.every(Boolean), 'pending forms must hold their submitted values');
        assert.ok(
          geometry.buttons.some((button) => button.busy === 'true' && button.disabled),
          'pending submit must prevent duplicate requests',
        );
      }
    }
    await capture?.(`${sample.mode}-text${sample.textScale}-${state}`, { scrollTop: false });
  };
  const settlePending = async (response) => {
    const item = pending.shift();
    assert.ok(item?.reply, 'expected a held fixture operation');
    item.reply(response);
    await page.waitForTimeout(350);
  };
  const waitPending = async () => {
    for (let n = 0; n < 50 && !pending.length; n++) await page.waitForTimeout(20);
    assert.ok(pending.length, 'form must submit a fixture operation');
  };
  const dismiss = async () => {
    for (let index = 0; index < 10; index++) {
      const buttons = page.getByRole('button', { name: 'Dismiss notification' });
      if (!(await buttons.count())) return;
      await buttons.first().click();
      await page.waitForTimeout(260);
    }
  };
  const retry = async (button) => {
    await button.click({ timeout: 5000 });
    await waitPending();
    assert.equal(await page.locator('.app-store-error').count(), 0, 'a new attempt must clear the obsolete error');
  };
  const checkInlineError = async () => {
    await page.getByRole('dialog').locator('.app-store-error[role="alert"]').waitFor();
    assert.equal(
      await page.locator('.orbis-notification[data-notification-type="error"]').count(),
      0,
      'form errors must stay inline instead of covering retry controls',
    );
  };
  const checkSwitch = async (sample) => {
    const geometry = await page
      .getByRole('dialog')
      .locator('.form-switch')
      .evaluate((root) => {
        const track = root.querySelector('[role="switch"]').getBoundingClientRect();
        const label = root.querySelector('.form-check-label').getBoundingClientRect();
        return {
          centreDelta: Math.abs(track.y + track.height / 2 - label.y - label.height / 2),
          gap: label.x - track.right,
          trackWidth: track.width,
          trackHeight: track.height,
          labelHeight: label.height,
        };
      });
    sample.switch = geometry;
    assert.ok(geometry.centreDelta <= 1, 'Enabled switch track and label must share a centre line');
    assert.ok(geometry.gap >= 8, 'Enabled switch track and label need readable separation');
  };
  const open = async () => {
    await page.goto(`${base}/settings?tab=appstores`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add app store', exact: true }).waitFor();
    await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
  };
  try {
    for (mode of modes)
      for (const textScale of textScales) {
        stores = structuredClone(initial);
        listError = false;
        listDelay = 0;
        const sample = { mode, textScale, states: [], findings: [], focusedActions: [], windowChecks: [] };
        await open();
        await scaleText(textScale);
        await checkWheel(sample);
        await page.locator('.table-responsive').evaluate((element) => element.scrollIntoView({ block: 'center' }));
        await snap(sample, 'table');
        const repositories = await page.locator('.app-store-url').evaluateAll((links) =>
          links.map((link) => ({
            text: link.textContent,
            href: link.href,
            title: link.title,
            ellipsis: getComputedStyle(link).textOverflow,
            overflow: getComputedStyle(link).overflowX,
          })),
        );
        assert.equal(repositories.length, initial.length);
        for (const link of repositories) {
          assert.equal(link.text, link.href);
          assert.equal(link.title, link.href, 'shortened repository addresses retain full hover and accessible text');
          assert.equal(link.ellipsis, 'ellipsis');
          assert.equal(link.overflow, 'hidden');
        }
        const actionButtons = page.locator('.table-responsive tbody button');
        await actionButtons.first().focus();
        for (let i = 0; i < 12 && sample.focusedActions.length < (await actionButtons.count()); i++) {
          if (i) await page.keyboard.press('Tab');
          const focus = await page.evaluate(() => {
            const e = document.activeElement;
            const r = e.getBoundingClientRect();
            const p = e.closest('.table-responsive')?.getBoundingClientRect();
            return {
              tag: e.tagName,
              text: e.textContent.trim(),
              x: r.x,
              right: r.right,
              width: r.width,
              parentLeft: p?.x,
              parentRight: p?.right,
              visible: p && r.x >= p.x && r.right <= p.right,
            };
          });
          if (focus.tag === 'BUTTON') {
            sample.focusedActions.push(focus);
            if (!focus.visible) sample.findings.push({ state: 'table keyboard', issue: 'focused action clipped', focus });
            await checkWindow(sample, `table-keyboard-${sample.focusedActions.length}`, { focused: true });
          }
        }
        assert.equal(sample.focusedActions.length, await actionButtons.count(), 'Tab must reach every store action');
        await capture?.(`${sample.mode}-text${sample.textScale}-table-keyboard`, { scrollTop: false });
        const addButton = page.getByRole('button', { name: 'Add app store', exact: true });
        for (let tab = 0; tab < 8; tab++) {
          if (await addButton.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press('Tab');
        }
        await checkWindow(sample, 'keyboard-to-add', { focused: true, expected: addButton });
        await capture?.(`${sample.mode}-text${sample.textScale}-window-keyboard-add`, { scrollTop: false });
        await page.keyboard.press('Enter');
        await page.getByRole('dialog').waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await checkWindow(sample, 'keyboard-add-close', { focused: true, expected: addButton });
        await capture?.(`${sample.mode}-text${sample.textScale}-window-dialog-close`, { scrollTop: false });
        await restore();
        if (surfacesOnly) {
          await page.getByRole('button', { name: 'Add app store', exact: true }).click();
          await page.getByRole('textbox', { name: 'App store name', exact: true }).fill('Community Stores');
          await page.getByRole('textbox', { name: 'App store URL', exact: true }).fill(createUrl);
          await page.getByRole('button', { name: 'Create new app store', exact: true }).click();
          await waitPending();
          await settlePending({ success: false, message: 'APP_STORE_CLONE_ERROR', status: 500 });
          await checkInlineError();
          await snap(sample, 'add-error', '[role="dialog"]');
          await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
          await checkWindow(sample, 'add-error-close', { focused: true, expected: addButton });
          await restore();
          await page.locator('.table-responsive tbody tr').first().getByRole('button', { name: 'Edit', exact: true }).click();
          await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Self Hosted Apps');
          await page.getByRole('button', { name: 'Save', exact: true }).click();
          await waitPending();
          await settlePending({ success: false, message: 'SERVER_ERROR_DUPLICATE_APP_STORE_NAME' });
          await checkInlineError();
          await snap(sample, 'edit-error', '[role="dialog"]');
          await checkSwitch(sample);
          await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
          await checkWindow(sample, 'edit-error-close', {
            focused: true,
            expected: page.locator('.table-responsive tbody tr').first().getByRole('button', { name: 'Edit', exact: true }),
          });
          await restore();
          await page.locator('.table-responsive tbody tr').first().getByRole('button', { name: 'Delete', exact: true }).click();
          await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
          await waitPending();
          await settlePending({ success: false, message: 'APP_STORE_DELETE_ERROR', status: 500 });
          await checkInlineError();
          await snap(sample, 'delete-error', '[role="dialog"]');
          const errorAlignment = await page
            .getByRole('dialog')
            .locator('.app-store-error')
            .evaluate((element) => getComputedStyle(element).textAlign);
          assert.equal(errorAlignment, 'left', 'inline errors use the same left alignment in all store dialogs');
          await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
          await checkWindow(sample, 'delete-error-close', {
            focused: true,
            expected: page.locator('.table-responsive tbody tr').first().getByRole('button', { name: 'Delete', exact: true }),
          });
          report.samples.push(sample);
          continue;
        }
        await page.getByRole('button', { name: 'Add app store', exact: true }).click();
        await page.getByRole('dialog').waitFor();
        await page.getByRole('textbox', { name: 'App store name', exact: true }).fill('Community Stores');
        await page.getByRole('textbox', { name: 'App store URL', exact: true }).fill(createUrl);
        await snap(sample, 'add', '[role="dialog"]');
        await page.getByRole('button', { name: 'Create new app store', exact: true }).click();
        await waitPending();
        await snap(sample, 'add-pending', '[role="dialog"]');
        await settlePending({ success: false, message: 'APP_STORE_CLONE_ERROR', intlParams: { url: createUrl } });
        await checkInlineError();
        assert.equal(await page.getByRole('textbox', { name: 'App store name', exact: true }).inputValue(), 'Community Stores');
        assert.equal(await page.getByRole('textbox', { name: 'App store URL', exact: true }).inputValue(), createUrl);
        await snap(sample, 'add-error', '[role="dialog"]');
        await page.getByRole('textbox', { name: 'App store name', exact: true }).fill('Community Store');
        assert.equal(await page.locator('.app-store-error').count(), 0, 'editing add values clears the old error');
        await page.getByRole('textbox', { name: 'App store name', exact: true }).fill('Community Stores');
        await retry(page.getByRole('button', { name: 'Create new app store', exact: true }));
        await settlePending({ success: false, message: 'APP_STORE_CLONE_ERROR', intlParams: { url: createUrl } });
        await checkInlineError();
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await checkWindow(sample, 'add-error-close', { focused: true, expected: addButton });
        await page.getByRole('button', { name: 'Add app store', exact: true }).click();
        assert.equal(await page.locator('.app-store-error').count(), 0, 'reopening add clears the old error');
        assert.equal(await page.getByRole('textbox', { name: 'App store URL', exact: true }).inputValue(), createUrl);
        await retry(page.getByRole('button', { name: 'Create new app store', exact: true }));
        await settlePending({ success: true });
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await checkWindow(sample, 'add-success-focus', { focused: true, expected: addButton });
        await snap(sample, 'add-success-toast', '.orbis-notifications');
        await dismiss();
        assert.equal(await page.locator('.table-responsive tbody tr').count(), 3, 'successful add refreshes the table');
        await restore();
        await page.locator('.table-responsive tbody tr').first().getByRole('button', { name: 'Edit', exact: true }).click();
        await page.getByRole('dialog').waitFor();
        await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Self Hosted Apps');
        await snap(sample, 'edit', '[role="dialog"]');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await waitPending();
        await snap(sample, 'edit-pending', '[role="dialog"]');
        await settlePending({ success: false, message: 'SERVER_ERROR_DUPLICATE_APP_STORE_NAME' });
        await checkInlineError();
        await snap(sample, 'edit-error', '[role="dialog"]');
        await checkSwitch(sample);
        await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Private Services');
        assert.equal(await page.locator('.app-store-error').count(), 0, 'editing the name clears the old save error');
        await retry(page.getByRole('button', { name: 'Save', exact: true }));
        await settlePending({ success: true });
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await checkWindow(sample, 'edit-success-focus', {
          focused: true,
          expected: page.locator('.table-responsive tbody tr').first().getByRole('button', { name: 'Edit', exact: true }),
        });
        await snap(sample, 'edit-success-toast', '.orbis-notifications');
        await dismiss();
        await restore();
        await page.locator('.table-responsive tbody tr').first().getByRole('button', { name: 'Delete', exact: true }).click();
        await page.getByRole('dialog').waitFor();
        await snap(sample, 'delete', '[role="dialog"]');
        await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
        await waitPending();
        await snap(sample, 'delete-pending', '[role="dialog"]');
        await settlePending({ success: false, message: 'APP_STORE_DELETE_ERROR_APPS_EXIST' });
        await checkInlineError();
        await snap(sample, 'delete-error', '[role="dialog"]');
        assert.equal(await page.locator('.table-responsive tbody tr').count(), 3, 'failed delete preserves its store row');
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await checkWindow(sample, 'delete-error-close', {
          focused: true,
          expected: page.locator('.table-responsive tbody tr').first().getByRole('button', { name: 'Delete', exact: true }),
        });
        await page.locator('.table-responsive tbody tr').first().getByRole('button', { name: 'Delete', exact: true }).click();
        assert.equal(await page.locator('.app-store-error').count(), 0, 'reopening delete clears the old error');
        await retry(page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }));
        await settlePending({ success: true });
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.querySelectorAll('.table-responsive tbody tr').length === 2);
        await checkWindow(sample, 'delete-success-focus', { focused: true, expected: page.locator('.app-stores') });
        await snap(sample, 'delete-success-toast', '.orbis-notifications');
        await dismiss();
        assert.equal(await page.locator('.table-responsive tbody tr').count(), 2, 'successful delete refreshes the table');
        const tableRecords = () =>
          page
            .locator('.table-responsive tbody tr')
            .evaluateAll((rows) => rows.map((row) => [...row.cells].slice(0, 3).map((cell) => cell.textContent.trim())));
        const recordsBeforePendingClose = await tableRecords();
        for (const operation of ['create', 'edit', 'delete']) {
          await restore();
          const opener =
            operation === 'create'
              ? page.getByRole('button', { name: 'Add app store', exact: true, includeHidden: true })
              : page
                  .locator('.table-responsive tbody tr')
                  .first()
                  .getByRole('button', { name: operation === 'edit' ? 'Edit' : 'Delete', exact: true, includeHidden: true });
          await opener.click();
          const dialog = page.getByRole('dialog');
          await dialog.waitFor();
          if (operation === 'create') {
            await dialog.getByRole('textbox', { name: 'App store name', exact: true }).fill('Pending Store');
            await dialog.getByRole('textbox', { name: 'App store URL', exact: true }).fill(createUrl);
          } else if (operation === 'edit') {
            await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Pending Rename');
            await dialog.getByRole('switch', { name: 'Enabled', exact: true }).click();
          }
          await scaleText(textScale);
          await dialog
            .getByRole('button', {
              name: operation === 'create' ? 'Create new app store' : operation === 'edit' ? 'Save' : 'Delete',
              exact: true,
            })
            .click();
          await waitPending();
          await page.waitForFunction((element) => element?.disabled, await opener.elementHandle(), { timeout: 2000 });
          assert.equal(await opener.isDisabled(), true, `${operation}: held request must disable its opener`);
          await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
          await checkWindow(sample, `${operation}-pending-close`, { focused: true, expected: page.locator('.app-stores') });
          await settlePending({
            success: false,
            message:
              operation === 'create'
                ? 'APP_STORE_CLONE_ERROR'
                : operation === 'edit'
                  ? 'SERVER_ERROR_DUPLICATE_APP_STORE_NAME'
                  : 'APP_STORE_DELETE_ERROR',
            status: operation === 'edit' ? 400 : 500,
          });
          assert.equal(await dialog.count(), 0, `${operation}: a failed held request must not reopen the closed dialog`);
          await checkWindow(sample, `${operation}-pending-closed-failure`, { focused: true, expected: page.locator('.app-stores') });
          assert.deepEqual(await tableRecords(), recordsBeforePendingClose, `${operation}: failed held request must preserve displayed stores`);
        }
        listError = true;
        await page.goto(`${base}/settings?tab=appstores`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
        await snap(sample, 'list-error', '.orbis-error');
        listError = false;
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await page.getByRole('button', { name: 'Add app store', exact: true }).waitFor();
        await snap(sample, 'list-recovered');
        report.samples.push(sample);
      }
    assert.deepEqual(unexpectedWrites, [], 'store audit may not submit any unmocked mutation');
    assert.deepEqual(
      report.samples.flatMap((sample) => sample.findings),
      [],
      'store settings must keep words, button padding and focused actions comfortable',
    );
    return report;
  } finally {
    for (const item of pending) item.reply?.({ success: false, message: 'Fixture cancelled' });
    await restore();
    await page.unroute('**/api/**', handler);
  }
};
