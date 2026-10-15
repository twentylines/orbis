const assert = require('node:assert/strict');

// Dedicated loopback fixture page; text stress changes computed text, not root size or icons.
module.exports = async function inspectSurfaceComfort({ page, base, capture, modes = ['light', 'dark'], textScales = [1, 2] }) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '8080', 'comfort checks require static8080 fixtures');
  const width = page.viewportSize().width;
  if (width > 600) return { width, skipped: true, reason: 'Focused phone surface checks' };
  const report = { width, samples: [], syntheticLoginPosts: 0, mutations: [] };
  let authenticated = true;
  let failure = false;
  let bindings;
  let preferences = {
    serverName: 'Hades',
    preset: 'frost',
    mode: 'light',
    density: 'comfortable',
    wallpaper: 'sandstone',
    windows: {},
    workspace: {
      order: ['applications', 'activity', 'storage', 'attention'],
      hidden: [],
      wide: ['applications'],
      pinnedApps: [],
      showAllApps: false,
    },
  };
  const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const guard = (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !(path === '/api/desktop-preferences' && request.method() === 'PUT')) {
      report.mutations.push({ path, method: request.method() });
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  };
  const user = (route) =>
    respond(route, {
      version: { current: '4.10.1', latest: '4.10.1', body: '', releases: [] },
      isLoggedIn: authenticated,
      isConfigured: true,
      isGuestDashboardEnabled: false,
      allowAutoThemes: false,
      allowErrorMonitoring: false,
      themeColor: 'blue',
      themeBase: 'slate',
      localDomain: 'local.test',
      sslPort: 443,
    });
  const stores = (route) =>
    failure
      ? respond(route, { message: 'Unable to connect to the application store. Check your server connection and retry.' }, 500)
      : respond(route, { appStores: [] });
  const prefs = (route) => {
    if (route.request().method() === 'PUT') preferences = route.request().postDataJSON();
    return respond(route, preferences);
  };
  const login = (route) => {
    assert.equal(route.request().method(), 'POST');
    assert.deepEqual(route.request().postDataJSON(), { username: 'fixture@example.com', password: 'synthetic-comfort-audit' });
    report.syntheticLoginPosts += 1;
    return respond(route, { success: true, totpSessionId: 'orbis-comfort-synthetic-session' });
  };
  await page.route('**/api/**', guard);
  await page.route('**/api/user-context', user);
  await page.route('**/api/marketplace/all', stores);
  await page.route('**/api/desktop-preferences', prefs);
  await page.route('**/api/auth/login', login);
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      CONNECTING = 0;
      OPEN = 1;
      CLOSED = 2;
      readyState = 0;
      onopen = null;
      onerror = null;
      onmessage = null;
      constructor(url) {
        super();
        this.url = new URL(url, location.origin).href;
        this.timer = setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event('open'));
        }, 0);
      }
      close() {
        clearTimeout(this.timer);
        this.readyState = 2;
      }
    }
    window.EventSource = FixtureEventSource;
  });
  const restoreText = () =>
    page.evaluate(() => {
      for (const [element, properties] of window.__orbisSurfaceComfortText ?? []) {
        if (!element.isConnected) continue;
        for (const [name, value, priority] of properties) {
          if (value) element.style.setProperty(name, value, priority);
          else element.style.removeProperty(name);
        }
      }
      window.__orbisSurfaceComfortText = [];
    });
  const scaleText = async (scale) => {
    await restoreText();
    if (scale === 1) return;
    assert.equal(scale, 2);
    await page.evaluate(() => {
      const baseline = [...document.querySelectorAll('body,body *')]
        .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName))
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            element,
            font: Number.parseFloat(style.fontSize),
            line: style.lineHeight,
            original: ['font-size', 'line-height'].map((name) => [
              name,
              element.style.getPropertyValue(name),
              element.style.getPropertyPriority(name),
            ]),
          };
        });
      for (const { element, font, line, original } of baseline) {
        if (!Number.isFinite(font)) continue;
        window.__orbisSurfaceComfortText.push([element, original]);
        element.style.setProperty('font-size', `${font * 2}px`, 'important');
        if (line !== 'normal') element.style.setProperty('line-height', `${Number.parseFloat(line) * 2}px`, 'important');
      }
    });
  };
  const open = async (path, mode, anonymous = false, failed = false) => {
    await restoreText();
    authenticated = !anonymous;
    failure = failed;
    preferences = { ...preferences, mode };
    await page.evaluate((value) => localStorage.setItem('server-desktop-preferences-v1', JSON.stringify(value)), preferences);
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
  };
  const measure = (selector) =>
    page.locator(selector).evaluate((root) => {
      const box = (element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      };
      const visible = (element) => element && element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility !== 'hidden';
      const textRects = (element) => {
        const result = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim() || !visible(walker.currentNode.parentElement)) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          result.push(...[...range.getClientRects()].filter((r) => r.width > 0).map((r) => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom })));
        }
        return result;
      };
      const splitWords = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!visible(node.parentElement) || node.parentElement.closest('svg,pre,code,.visually-hidden,[hidden]')) continue;
        for (const match of node.textContent.matchAll(/[A-Za-z]{3,}/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const ys = [...new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.y * 10) / 10))];
          if (ys.length > 1) splitWords.push({ word: match[0], selector: node.parentElement.className || node.parentElement.tagName, ys });
        }
      }
      const header = root.querySelector('.modal-header');
      const title = root.querySelector('.modal-title');
      const close = root.querySelector('button.btn-close');
      const toolbar = document.querySelector('.desktop-auth-toolbar');
      const details = root.querySelector('.orbis-error-details dl');
      const systemBar = document.querySelector('.desktop-system-bar');
      const cards = [...root.querySelectorAll('.orbis-notification')];
      return {
        root: box(root),
        typography: [...root.querySelectorAll('h1,h2,h3,p,.orbis-notification-message')].filter(visible).map((element) => ({
          text: element.textContent.trim(),
          fontSize: getComputedStyle(element).fontSize,
          lineHeight: getComputedStyle(element).lineHeight,
        })),
        splitWords,
        title: title ? { ...box(title), text: title.textContent, textRects: textRects(title) } : null,
        header: header
          ? {
              ...box(header),
              paddingTop: Number.parseFloat(getComputedStyle(header).paddingTop),
              paddingBottom: Number.parseFloat(getComputedStyle(header).paddingBottom),
            }
          : null,
        close: close ? box(close) : null,
        toolbar: toolbar
          ? [...toolbar.querySelectorAll('button')].map((button) => ({
              ...box(button),
              label: button.getAttribute('aria-label'),
              glyph: button.querySelector('svg') ? box(button.querySelector('svg')) : null,
            }))
          : [],
        buttons: [...root.querySelectorAll('button,a.btn')]
          .filter(visible)
          .map((button) => ({ ...box(button), text: button.textContent.trim(), textRects: textRects(button) })),
        details: details
          ? { ...box(details), columns: getComputedStyle(details).gridTemplateColumns, values: [...details.querySelectorAll('dd')].map(box) }
          : null,
        systemBar: systemBar ? box(systemBar) : null,
        cards: cards.map((card) => ({
          ...box(card),
          message: box(card.querySelector('.orbis-notification-message')),
          dismiss: box(card.querySelector('.orbis-notification-dismiss')),
        })),
      };
    });
  const checkWordsAndActions = (geometry, context) => {
    assert.deepEqual(geometry.splitWords, [], `${context}: ordinary words must wrap at spaces`);
    for (const button of geometry.buttons)
      for (const rect of button.textRects) {
        assert.ok(rect.x >= button.x + 6 && rect.right <= button.right - 6, `${context}: ${button.text} needs horizontal padding`);
        assert.ok(rect.y >= button.y + 3 && rect.bottom <= button.bottom - 3, `${context}: ${button.text} needs vertical padding`);
      }
  };
  const shot = async (name, mode, scale, selector) => {
    await page.waitForTimeout(350);
    const geometry = await measure(selector);
    checkWordsAndActions(geometry, `${width}px ${mode} ${scale}x ${name}`);
    await capture?.(`${mode}-text${scale * 100}-${name}`, { scrollTop: false });
    report.samples.push({ name, mode, textScale: scale, geometry });
    return geometry;
  };
  const discoverToast = () =>
    page.evaluate(async () => {
      let toast;
      let react;
      const urls = [...new Set(performance.getEntriesByType('resource').map((entry) => entry.name))].filter(
        (name) => new URL(name).pathname.startsWith('/assets/') && name.endsWith('.js') && !name.includes('/manifest-'),
      );
      for (const url of urls) {
        try {
          for (const [key, value] of Object.entries(await import(url))) {
            if (
              !toast &&
              typeof value === 'function' &&
              ['success', 'error', 'custom', 'dismiss', 'remove'].every((name) => typeof value[name] === 'function')
            )
              toast = { url, key };
            if (
              !react &&
              value &&
              typeof value.createElement === 'function' &&
              typeof value.useState === 'function' &&
              typeof value.version === 'string'
            )
              react = { url, key };
          }
          if (toast && react) break;
        } catch {
          /* Other loaded modules may not expose public exports. */
        }
      }
      return { toast, react };
    });
  try {
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    for (const mode of modes)
      for (const scale of textScales) {
        await open('/login', mode, true);
        await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('fixture@example.com');
        await page.getByLabel('Password', { exact: true }).fill('synthetic-comfort-audit');
        await page.getByRole('button', { name: 'Log in', exact: true }).click();
        await page.getByRole('heading', { name: 'Enter your code', exact: true }).waitFor();
        await page.getByRole('textbox', { name: 'digit-0', exact: true }).fill('123456');
        await scaleText(scale);
        const authGeometry = await shot('auth-code', mode, scale, '.desktop-auth .card');
        const icon = authGeometry.toolbar.find((button) => button.label?.startsWith('Switch to '));
        assert.ok(icon && icon.width >= 40 && icon.height >= 40, 'auth theme icon must retain a40px target');
        assert.ok(
          icon.glyph && Math.abs(icon.glyph.cx - icon.cx) <= 0.6 && Math.abs(icon.glyph.cy - icon.cy) <= 0.6,
          'auth theme glyph must stay centred',
        );
        assert.equal(await page.locator('.otp-input').evaluateAll((nodes) => nodes.map((node) => node.value).join('')), '123456');

        await open('/settings?tab=appstores', mode, false, true);
        await page.getByRole('heading', { name: 'Unable to load this page', exact: true }).waitFor();
        await page.locator('.orbis-error-details summary').click();
        await scaleText(scale);
        const error = await shot('error-details', mode, scale, '.orbis-error');
        assert.equal(error.details.columns.trim().split(/\s+/).length, 1, 'phone diagnostic terms and values must stack');

        await open('/apps/custom', mode);
        await page.getByRole('button', { name: 'More application actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
        await page.getByRole('dialog').getByRole('switch', { name: 'Remove backups', exact: true }).waitFor();
        await scaleText(scale);
        const remove = await shot('remove-dialog', mode, scale, '[role="dialog"]');
        assert.ok(remove.header.paddingTop >= 12 && remove.header.paddingBottom >= 12, 'dialog headings need vertical padding');
        assert.ok(remove.title.y >= remove.header.y + 12, 'dialog title must clear the upper rim');
        await page.keyboard.press('Escape');

        await open('/apps/create', mode);
        await page.getByRole('button', { name: 'YAML Editor', exact: true }).click();
        await page.locator('.cm-content').first().click();
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.insertText('services: []');
        await page.getByRole('button', { name: 'Back to form', exact: true }).click();
        await page.getByRole('dialog').getByRole('heading', { name: 'Discard unsaved changes?', exact: true }).waitFor();
        await scaleText(scale);
        const confirmation = await shot('discard-confirmation', mode, scale, '[role="dialog"]');
        assert.ok(confirmation.header.paddingTop >= 12 && confirmation.header.paddingBottom >= 12, 'confirmation heading needs vertical padding');
        await page.getByRole('button', { name: 'Discard changes', exact: true }).click();

        await open('/settings?tab=appearance', mode);
        await page.locator('.appearance').waitFor();
        bindings = await discoverToast();
        assert.ok(bindings.toast && bindings.react, 'production toast and React exports must be available');
        await page.evaluate(async (bindings) => {
          const toast = (await import(bindings.toast.url))[bindings.toast.key];
          const React = (await import(bindings.react.url))[bindings.react.key];
          toast.error('This app could not be updated. Your existing configuration is still available.', { id: 'comfort-error', duration: 600000 });
          toast.custom(
            (item) =>
              React.createElement(
                'div',
                null,
                React.createElement('p', null, 'An Orbis update is ready. Review the changelog before installing.'),
                React.createElement(
                  'button',
                  { type: 'button', className: 'btn btn-outline-primary', onClick: () => toast.dismiss(item.id) },
                  'Review update',
                ),
              ),
            { id: 'comfort-action', duration: 600000 },
          );
        }, bindings);
        await page.locator('.orbis-notification').first().waitFor();
        await scaleText(scale);
        const notices = await shot('notifications', mode, scale, '.orbis-notifications');
        assert.equal(notices.cards.length, 2);
        assert.ok(notices.cards[0].y >= notices.systemBar.bottom + 12, 'notifications must visibly clear the responsive system bar');
        if (scale === 2)
          for (const card of notices.cards) {
            assert.ok(card.message.width >= card.width - 40, 'enlarged notice text must use the full body width');
            assert.ok(card.message.y >= card.dismiss.bottom + 8, 'enlarged notice text must clear icon/dismiss row');
          }
        await page.evaluate(async (bindings) => (await import(bindings.toast.url))[bindings.toast.key].remove(), bindings);
      }
    assert.deepEqual(report.mutations, [], 'comfort checks must block all unexpected app, host and authentication writes');
    assert.equal(report.syntheticLoginPosts, modes.length * textScales.length);
    return report;
  } catch (error) {
    await capture?.('surface-comfort-failure', { scrollTop: false }).catch(() => undefined);
    throw error;
  } finally {
    await restoreText();
    await page.unroute('**/api/auth/login', login);
    await page.unroute('**/api/desktop-preferences', prefs);
    await page.unroute('**/api/marketplace/all', stores);
    await page.unroute('**/api/user-context', user);
    await page.unroute('**/api/**', guard);
  }
};
