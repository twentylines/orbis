const assert = require('node:assert/strict');

// Run on a fresh visual-qa fixture page. Authentication posts are intercepted synthetic fixtures.
module.exports = async function inspectErrorAuth({ page, base, capture }) {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'error/auth checks require loopback fixtures');
  const version = { current: '4.10.1', latest: '4.10.1', body: '', releases: [] };
  let scenario = 'authenticated';
  let failure = null;
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
  const report = { errors: [], auth: [], recovery: [], totp: [], syntheticAuthRequests: [], mutations: [] };
  const respond = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  const userHandler = (route) =>
    respond(route, {
      version,
      isLoggedIn: scenario === 'authenticated',
      isConfigured: scenario !== 'register',
      isGuestDashboardEnabled: false,
      allowAutoThemes: false,
      allowErrorMonitoring: false,
      themeColor: 'blue',
      themeBase: 'slate',
      localDomain: 'local.test',
      sslPort: 443,
    });
  const storesHandler = (route) => (failure === null ? respond(route, { appStores: [] }) : respond(route, { message: failure }, 500));
  const preferencesHandler = (route) => {
    if (route.request().method() === 'PUT') preferences = JSON.parse(route.request().postData() || '{}');
    return respond(route, preferences);
  };
  const fixtureSession = 'orbis-audit-synthetic-totp';
  const loginHandler = (route) => {
    const request = route.request();
    assert.equal(request.method(), 'POST');
    const body = request.postDataJSON();
    assert.equal(body.username, 'fixture@example.com');
    assert.equal(body.password, 'synthetic-otp-audit');
    report.syntheticAuthRequests.push({ path: '/api/auth/login', method: 'POST', username: body.username });
    return respond(route, { success: true, totpSessionId: fixtureSession });
  };
  const totpHandler = (route) => {
    const request = route.request();
    assert.equal(request.method(), 'POST');
    const body = request.postDataJSON();
    assert.equal(body.totpSessionId, fixtureSession);
    assert.equal(body.totpCode, '123456');
    report.syntheticAuthRequests.push({ path: '/api/auth/verify-totp', method: 'POST', code: body.totpCode });
    return respond(route, { message: 'AUTH_ERROR_TOTP_INVALID_CODE' }, 401);
  };
  const expectedAuthPost = (path, method) => method === 'POST' && ['/api/auth/login', '/api/auth/verify-totp'].includes(path);
  const preventUnknownMutation = (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !(path === '/api/desktop-preferences' && request.method() === 'PUT'))
      return route.abort('blockedbyclient');
    return route.fallback();
  };
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
      !(url.pathname === '/api/desktop-preferences' && request.method() === 'PUT') &&
      !expectedAuthPost(url.pathname, request.method())
    )
      report.mutations.push({ path: url.pathname, method: request.method() });
  };
  page.on('request', onRequest);
  await page.route('**/api/**', preventUnknownMutation);
  await page.route('**/api/user-context', userHandler);
  await page.route('**/api/marketplace/all', storesHandler);
  await page.route('**/api/desktop-preferences', preferencesHandler);
  await page.route('**/api/auth/login', loginHandler);
  await page.route('**/api/auth/verify-totp', totpHandler);
  const shot = (name) => capture?.(name, { scrollTop: false });
  const settle = () => page.waitForTimeout(300);
  const seedMode = async (mode) => {
    preferences = { ...preferences, mode };
    await page.evaluate((value) => localStorage.setItem('server-desktop-preferences-v1', JSON.stringify(value)), preferences);
  };
  const measure = (selector) =>
    page.locator(selector).evaluate((root) => {
      const rect = (node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      };
      const token = (name, property) => {
        const probe = document.createElement('span');
        probe.style[property] = getComputedStyle(root).getPropertyValue(name);
        root.append(probe);
        const value = getComputedStyle(probe)[property];
        probe.remove();
        return value;
      };
      const panel = root.querySelector('.desktop-fallback-panel,.card');
      const credit = root.querySelector('.desktop-auth-credit');
      const details = root.querySelector('details');
      const error = details?.querySelector('dd:last-child');
      const buttons = [...root.querySelectorAll('.orbis-error-actions .btn')].map((node) => {
        const text = [...node.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
        const range = text ? document.createRange() : null;
        if (range) range.selectNodeContents(text);
        const label = range?.getBoundingClientRect();
        const glyph = node.querySelector('svg')?.getBoundingClientRect();
        const content = label
          ? {
              left: Math.min(label.left, glyph?.left ?? label.left),
              right: Math.max(label.right, glyph?.right ?? label.right),
              cy: label.y + label.height / 2,
            }
          : null;
        return { ...rect(node), content, text: node.textContent.trim() };
      });
      return {
        root: rect(root),
        panel: rect(panel),
        mode: root.dataset.desktopMode,
        preset: root.dataset.desktopPreset,
        color: getComputedStyle(panel).color,
        surface: getComputedStyle(panel).backgroundColor,
        inkToken: token('--desktop-ink', 'color'),
        surfaceToken: token('--desktop-surface', 'backgroundColor'),
        mutedToken: token('--desktop-muted', 'color'),
        credit: credit ? { ...rect(credit), contained: panel.contains(credit), color: getComputedStyle(credit).color } : null,
        overflow: document.documentElement.scrollWidth > innerWidth,
        panelText: panel.innerText,
        detailsOpen: details?.open,
        pagePath: details?.querySelector('dd')?.textContent,
        errorText: error?.textContent,
        detail: error ? { ...rect(error), scrollHeight: error.scrollHeight, clientHeight: error.clientHeight } : null,
        buttons,
        inputs: [...root.querySelectorAll('input')].map((node) => ({
          ...rect(node),
          hasPlaceholder: Boolean(node.getAttribute('placeholder')),
          placeholderColor: getComputedStyle(node, '::placeholder').color,
          placeholderOpacity: getComputedStyle(node, '::placeholder').opacity,
        })),
        toolbar: [...root.querySelectorAll('.desktop-auth-toolbar button')].map((node) => rect(node)),
        code: [...root.querySelectorAll('pre')].map((node) => ({ ...rect(node), color: getComputedStyle(node.querySelector('code') ?? node).color })),
      };
    });
  const assertSurface = (geometry, mode) => {
    assert.equal(geometry.mode, mode, 'the surface must retain the chosen mode');
    assert.equal(geometry.overflow, false, 'the surface must not overflow horizontally');
    assert.ok(geometry.panel.x >= 12 && geometry.panel.right <= page.viewportSize().width - 12, 'the panel must retain viewport padding');
    assert.equal(geometry.color, geometry.inkToken, 'surface text must use the active theme');
    assert.equal(geometry.surface, geometry.surfaceToken, 'surface background must use the active theme');
  };
  const assertActions = (geometry) => {
    for (const action of geometry.buttons) {
      assert.ok(action.height >= 40, 'error actions must remain reachable');
      assert.ok(action.x >= geometry.panel.x && action.right <= geometry.panel.right, 'error actions must fit their panel');
      if (action.content) {
        assert.ok(Math.abs((action.content.left + action.content.right) / 2 - action.cx) <= 1, 'error action content must be horizontally centred');
        assert.ok(Math.abs(action.content.cy - action.cy) <= 2, 'error action label must be vertically centred');
      }
    }
  };
  const contrast = (foreground, background) => {
    const rgb = (value) => value.match(/[\d.]+/g).map(Number);
    const luminance = (channels) =>
      channels
        .slice(0, 3)
        .map((value) => value / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const fg = rgb(foreground);
    const bg = rgb(background);
    const alpha = bg[3] ?? 1;
    return Math.min(
      ...[0, 255].map((backdrop) => {
        const values = [luminance(fg), luminance(bg.slice(0, 3).map((value) => value * alpha + backdrop * (1 - alpha)))].sort((a, b) => a - b);
        return (values[1] + 0.05) / (values[0] + 0.05);
      }),
    );
  };
  const inspectTotp = async (mode, size) => {
    await settle();
    const fields = await page.locator('.otp-input').evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        const bounds = node.getBoundingClientRect();
        const probe = document.createElement('span');
        Object.assign(probe.style, {
          position: 'fixed',
          visibility: 'hidden',
          whiteSpace: 'pre',
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          fontStretch: style.fontStretch,
          lineHeight: style.lineHeight,
          fontVariantNumeric: style.fontVariantNumeric,
          fontFeatureSettings: style.fontFeatureSettings,
          letterSpacing: style.letterSpacing,
        });
        probe.textContent = node.value;
        document.body.append(probe);
        const glyphWidth = probe.getBoundingClientRect().width;
        const glyphFontSize = Number.parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        const centreTarget = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        let opacity = 1;
        for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) opacity *= Number.parseFloat(getComputedStyle(ancestor).opacity);
        return {
          value: node.value,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          cy: bounds.y + bounds.height / 2,
          paddingLeft: Number.parseFloat(style.paddingLeft),
          paddingRight: Number.parseFloat(style.paddingRight),
          usableWidth: node.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
          usableHeight: node.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom),
          glyphWidth,
          glyphFontSize,
          fontSize: Number.parseFloat(style.fontSize),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          color: style.color,
          background: style.backgroundColor,
          visibility: style.visibility,
          display: style.display,
          opacity,
          unobscured: centreTarget === node,
        };
      }),
    );
    assert.equal(fields.length, 6, 'the TOTP form must show six code fields');
    assert.equal(fields.map((field) => field.value).join(''), '123456');
    for (const field of fields) {
      assert.equal(field.glyphFontSize, field.fontSize, 'the glyph probe must use the actual input font size');
      assert.ok(
        field.usableWidth >= field.glyphWidth + 1,
        `TOTP ${size}: digit ${field.value} needs ${field.glyphWidth + 1}px, has ${field.usableWidth}px`,
      );
      assert.ok(field.usableHeight >= field.fontSize - 1, 'TOTP digits must fit vertically');
      assert.ok(field.scrollWidth <= field.clientWidth + 1, 'TOTP digits must not scroll out of their content box');
      assert.equal(field.visibility, 'visible');
      assert.notEqual(field.display, 'none');
      assert.ok(field.opacity >= 0.9 && field.unobscured, 'entered TOTP digits must remain visibly paintable');
      assert.ok(contrast(field.color, field.background) >= 4.5, 'entered TOTP digits must contrast with their field');
      assert.ok(field.height >= 44, 'TOTP fields must retain usable targets');
      assert.ok(Math.abs(field.cy - fields[0].cy) < 0.6 && Math.abs(field.width - fields[0].width) < 0.6, 'TOTP fields must align evenly');
    }
    await shot(`${mode}-totp-${size}-filled`);
    return fields;
  };

  try {
    await page.goto(`${base}/settings?tab=appearance`, { waitUntil: 'domcontentloaded' });
    await page.locator('.appearance').waitFor();
    for (const mode of ['light', 'dark']) {
      await seedMode(mode);
      scenario = 'authenticated';
      const closedHeights = [];
      const cases = [
        ['real', 'Unable to connect to the application store. Check your server connection and retry.'],
        ['empty', ''],
        [
          'long',
          `The server returned an unexpected response.\n${'The previous configuration remains available while the connection is checked. '.repeat(70)}\n/srv/${'long-directory-name-'.repeat(40)}`,
        ],
      ];
      for (const [kind, message] of cases) {
        failure = message;
        await page.goto(`${base}/settings?tab=appstores`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: 'Unable to load this page', exact: true }).waitFor();
        await settle();
        const closed = await measure('.desktop-fallback');
        assertSurface(closed, mode);
        assertActions(closed);
        assert.equal(closed.detailsOpen, false);
        assert.equal(closed.panelText.includes('/settings'), false, 'page location belongs in collapsed Details');
        assert.equal(closed.pagePath, '/settings', 'Details must retain the exact failed pathname');
        assert.equal(closed.errorText, message || 'No error details were returned.');
        assert.ok(closed.panel.height < page.viewportSize().height * 0.65, 'the default error card should remain compact');
        closedHeights.push(closed.panel.height);
        await shot(`${mode}-error-${kind}-collapsed`);
        const summary = page.locator('.orbis-error-details summary');
        await summary.focus();
        await page.keyboard.press('Enter');
        await page.locator('.orbis-error-details[open]').waitFor();
        const expanded = await measure('.desktop-fallback');
        assertSurface(expanded, mode);
        assertActions(expanded);
        assert.equal(expanded.detailsOpen, true);
        assert.ok(expanded.panelText.includes('/settings'));
        assert.ok(expanded.panel.height > closed.panel.height, 'expanded Details must reveal content');
        if (kind === 'long') {
          assert.ok(expanded.detail.scrollHeight > expanded.detail.clientHeight, 'long diagnostics must use a bounded scroller');
          const scrolled = await page
            .locator('.orbis-error-details dd')
            .last()
            .evaluate((node) => {
              node.scrollTop = 80;
              return node.scrollTop;
            });
          assert.ok(scrolled > 0, 'long diagnostics must be scrollable');
        }
        await shot(`${mode}-error-${kind}-details`);
        await summary.focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('.orbis-error-details').evaluate((node) => node.open), false);
        report.errors.push({ mode, kind, closed, expanded });
      }
      assert.ok(Math.max(...closedHeights) - Math.min(...closedHeights) <= 1, 'hidden diagnostics must not enlarge the default card');
      failure = null;
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.locator('.desktop-system-bar').waitFor();
      await page.locator('.orbis-error').waitFor({ state: 'hidden' });
      assert.ok(page.url().includes('/settings'), 'Retry must recover the failed settings view');
      failure = 'The application store is temporarily unavailable.';
      await page.goto(`${base}/settings?tab=appstores`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Unable to load this page', exact: true }).waitFor();
      failure = null;
      await page.getByRole('link', { name: 'Open workspace', exact: true }).click();
      await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
      await page.locator('.workspace-grid').waitFor();
      assert.equal(await page.locator('.orbis-error').count(), 0, 'Open workspace must render the dashboard after a failed query');
      report.recovery.push({ mode, retry: true, openWorkspace: true });
      for (const route of ['login', 'reset-password', 'register', 'totp']) {
        scenario = route === 'register' ? 'register' : 'anonymous';
        await seedMode(mode);
        await page.goto(`${base}/${route === 'totp' ? 'login' : route}`, { waitUntil: 'domcontentloaded' });
        await page.locator('.desktop-auth .card').waitFor();
        if (route === 'totp') {
          await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('fixture@example.com');
          await page.getByLabel('Password', { exact: true }).fill('synthetic-otp-audit');
          await page.getByRole('button', { name: 'Log in', exact: true }).click();
          await page.getByRole('heading', { name: 'Two-factor authentication', exact: true }).waitFor();
        }
        await settle();
        const geometry = await measure('.desktop-auth');
        assertSurface(geometry, mode);
        assert.ok(geometry.credit?.contained, 'auth credit must stay inside the themed card');
        assert.equal(geometry.toolbar.length, 2, 'authentication toolbar should have theme and language controls');
        assert.ok(Math.abs(geometry.toolbar[0].cy - geometry.toolbar[1].cy) <= 1, 'authentication toolbar controls must share one centre line');
        assert.ok(Math.abs(geometry.toolbar[0].height - geometry.toolbar[1].height) <= 1, 'authentication toolbar controls must have equal height');
        assert.ok(
          geometry.credit.x >= geometry.panel.x &&
            geometry.credit.right <= geometry.panel.right &&
            geometry.credit.bottom <= geometry.panel.bottom + 1,
          'auth footer must fit its card',
        );
        geometry.credit.minimumContrast = contrast(geometry.credit.color, geometry.surface);
        assert.ok(geometry.credit.minimumContrast >= 4.5, 'auth credit must remain readable over its surface');
        for (const input of geometry.inputs) {
          assert.ok(input.width > 0 && input.x >= geometry.panel.x && input.right <= geometry.panel.right, 'auth fields must fit their panel');
          assert.ok(input.height >= 36, 'auth fields must remain reachable');
          if (input.hasPlaceholder) {
            assert.equal(input.placeholderColor, geometry.mutedToken, 'auth placeholders must use the current theme');
            assert.equal(input.placeholderOpacity, '1', 'placeholder contrast must not be reduced by stock opacity');
          }
        }
        for (const code of geometry.code) {
          assert.ok(code.x >= geometry.panel.x && code.right <= geometry.panel.right, 'reset instructions must fit their auth panel');
          assert.equal(code.color, geometry.inkToken, 'reset command text must use the active theme');
        }
        await shot(`${mode}-${route}`);
        if (route === 'login') {
          await page.getByRole('textbox', { name: 'Email address', exact: true }).focus();
          await page.keyboard.press('Tab');
          assert.equal(
            await page.evaluate(() => document.activeElement.getAttribute('type')),
            'password',
            'email must lead to password in keyboard order',
          );
          await page.getByRole('button', { name: `Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`, exact: true }).click();
          await page.locator(`.desktop-auth[data-desktop-mode="${mode === 'dark' ? 'light' : 'dark'}"]`).waitFor();
          await page.getByRole('button', { name: `Switch to ${mode} mode`, exact: true }).click();
          await page.locator(`.desktop-auth[data-desktop-mode="${mode}"]`).waitFor();
        }
        if (route === 'totp') {
          await page.getByRole('textbox', { name: 'digit-0', exact: true }).fill('123456');
          assert.equal(await page.locator('.otp-input').evaluateAll((nodes) => nodes.map((node) => node.value).join('')), '123456');
          const native = await inspectTotp(mode, 'native');
          let enlarged = null;
          if (page.viewportSize().width <= 390) {
            const originals = await page
              .locator('.otp-input')
              .evaluateAll((nodes) => nodes.map((node) => ({ font: getComputedStyle(node).fontSize, line: getComputedStyle(node).lineHeight })));
            await page.locator('.otp-input').evaluateAll(
              (nodes, originals) =>
                nodes.forEach((node, index) => {
                  node.style.setProperty('font-size', `${Number.parseFloat(originals[index].font) * 2}px`, 'important');
                  node.style.setProperty('line-height', `${Number.parseFloat(originals[index].line) * 2}px`, 'important');
                }),
              originals,
            );
            enlarged = await inspectTotp(mode, 'digits-200-percent');
            await page.locator('.otp-input').evaluateAll((nodes) =>
              nodes.forEach((node) => {
                node.style.removeProperty('font-size');
                node.style.removeProperty('line-height');
              }),
            );
          }
          const first = page.getByRole('textbox', { name: 'digit-0', exact: true });
          const second = page.getByRole('textbox', { name: 'digit-1', exact: true });
          await first.focus();
          await page.keyboard.press('ArrowRight');
          assert.equal(await second.evaluate((node) => node === document.activeElement), true, 'OTP ArrowRight must advance focus');
          await page.keyboard.press('ArrowLeft');
          assert.equal(await first.evaluate((node) => node === document.activeElement), true, 'OTP ArrowLeft must return focus');
          await page.getByRole('textbox', { name: 'digit-5', exact: true }).focus();
          await page.keyboard.press('Tab');
          const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
          assert.equal(await confirm.evaluate((node) => node === document.activeElement), true, 'OTP keyboard order must reach Confirm');
          assert.equal(await confirm.isEnabled(), true);
          await confirm.click();
          await page.locator('.orbis-notification').getByText('Incorrect authentication code.', { exact: true }).waitFor();
          await page.getByRole('heading', { name: 'Two-factor authentication', exact: true }).waitFor();
          report.totp.push({ mode, native, enlarged, keyboard: true, fixtureRejection: true });
        }
        report.auth.push({ mode, route, geometry });
      }
    }
    assert.deepEqual(report.mutations, [], 'error/auth visual checks must not submit server mutations');
    assert.equal(report.syntheticAuthRequests.filter((request) => request.path === '/api/auth/login').length, 2);
    assert.equal(report.syntheticAuthRequests.filter((request) => request.path === '/api/auth/verify-totp').length, 2);
    return report;
  } catch (error) {
    await shot('error-auth-failure');
    throw error;
  } finally {
    page.off('request', onRequest);
    await page.unroute('**/api/user-context', userHandler);
    await page.unroute('**/api/marketplace/all', storesHandler);
    await page.unroute('**/api/desktop-preferences', preferencesHandler);
    await page.unroute('**/api/auth/login', loginHandler);
    await page.unroute('**/api/auth/verify-totp', totpHandler);
    await page.unroute('**/api/**', preventUnknownMutation);
  }
};
