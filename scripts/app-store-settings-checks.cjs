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
    if (url.pathname === '/api/marketplace/all')
      return listError
        ? respond(route, { message: 'Unable to load app stores. Check the server connection and retry.' }, 500)
        : respond(route, { appStores: stores });
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
        if (method === 'POST') stores.push({ ...item.body, slug: 'added-qa', enabled: true });
        if (method === 'PATCH') stores = stores.map((store) => (store.slug === url.pathname.split('/').at(-1) ? { ...store, ...item.body } : store));
        if (method === 'DELETE') stores = stores.filter((store) => store.slug !== url.pathname.split('/').at(-1));
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
        const sample = { mode, textScale, states: [], findings: [], focusedActions: [] };
        await open();
        await scaleText(textScale);
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
          }
        }
        assert.equal(sample.focusedActions.length, await actionButtons.count(), 'Tab must reach every store action');
        await capture?.(`${sample.mode}-text${sample.textScale}-table-keyboard`, { scrollTop: false });
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
        await page.getByRole('button', { name: 'Add app store', exact: true }).click();
        assert.equal(await page.locator('.app-store-error').count(), 0, 'reopening add clears the old error');
        assert.equal(await page.getByRole('textbox', { name: 'App store URL', exact: true }).inputValue(), createUrl);
        await retry(page.getByRole('button', { name: 'Create new app store', exact: true }));
        await settlePending({ success: true });
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
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
        await page.locator('.table-responsive tbody tr').first().getByRole('button', { name: 'Delete', exact: true }).click();
        assert.equal(await page.locator('.app-store-error').count(), 0, 'reopening delete clears the old error');
        await retry(page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }));
        await settlePending({ success: true });
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await snap(sample, 'delete-success-toast', '.orbis-notifications');
        await dismiss();
        assert.equal(await page.locator('.table-responsive tbody tr').count(), 2, 'successful delete refreshes the table');
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
