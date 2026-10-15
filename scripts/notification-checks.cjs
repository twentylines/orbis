const assert = require('node:assert/strict');

// Dedicated page with visual-qa's API fixtures. Only the loaded production toast API is invoked.
module.exports = async function inspectNotifications({ page, base, capture, checkTiming = true }) {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'notification checks require loopback fixtures');
  const presets = ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'];
  const modes = ['light', 'dark'];
  const report = { themes: [], behavior: {}, mutations: [] };
  let bindings;
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.pathname !== '/api/desktop-preferences')
      report.mutations.push({ path: url.pathname, method: request.method() });
  };
  page.on('request', onRequest);
  await page.addInitScript(() => {
    const streams = [];
    class NotificationEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      CONNECTING = 0;
      OPEN = 1;
      CLOSED = 2;
      readyState = 0;
      onopen = null;
      onmessage = null;
      onerror = null;
      constructor(url) {
        super();
        this.url = new URL(url, location.origin).href;
        streams.push(this);
        setTimeout(() => {
          if (this.readyState === 2) return;
          this.readyState = 1;
          this.onopen?.(new Event('open'));
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = NotificationEventSource;
    window.__orbisNotificationStreams = {
      emit: (data) => {
        let delivered = 0;
        for (const source of streams) {
          if (source.readyState === 1 && new URL(source.url).pathname === '/api/sse/app') {
            source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
            delivered += 1;
          }
        }
        return delivered;
      },
    };
  });

  const tray = () => page.locator('.orbis-notifications[aria-label="Notifications"]');
  const cards = () => page.locator('.orbis-notification');
  const card = (id) => page.locator(`[data-notification-id="${id}"]`);
  const shot = async (name) => {
    if (capture) await capture(name, { scrollTop: false });
  };
  const settle = async () => {
    await page.waitForTimeout(300);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const resolveBindings = async () => {
    const found = await page.evaluate(async () => {
      const urls = [...new Set(performance.getEntriesByType('resource').map((entry) => entry.name))].filter((name) => {
        const url = new URL(name);
        return (
          url.origin === location.origin &&
          url.pathname.startsWith('/assets/') &&
          url.pathname.endsWith('.js') &&
          !url.pathname.includes('/manifest-')
        );
      });
      let toast;
      let react;
      const failures = [];
      for (const url of urls) {
        try {
          const module = await import(url);
          for (const [key, value] of Object.entries(module)) {
            if (
              !toast &&
              typeof value === 'function' &&
              ['success', 'error', 'loading', 'custom', 'promise', 'dismiss', 'remove'].every((name) => typeof value[name] === 'function')
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
        } catch (error) {
          failures.push({ url, message: String(error) });
        }
      }
      return { toast, react, failures };
    });
    assert.ok(found.toast && found.react, `public production toast/React exports must be discoverable: ${JSON.stringify(found)}`);
    return found;
  };
  const invoke = async (operation, message, options = {}) =>
    page.evaluate(
      async ({ bindings, operation, message, options }) => {
        const toast = (await import(bindings.toast.url))[bindings.toast.key];
        if (operation === 'remove') {
          toast.remove();
          return;
        }
        if (operation === 'dismiss') {
          toast.dismiss(options.id);
          return;
        }
        if (operation === 'custom-action') {
          const React = (await import(bindings.react.url))[bindings.react.key];
          return toast.custom(
            (item) =>
              React.createElement(
                'div',
                null,
                React.createElement('p', null, message),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'btn btn-outline-primary',
                    onClick: () => {
                      document.documentElement.dataset.notificationQaAction = 'activated';
                      toast.dismiss(item.id);
                    },
                  },
                  'Review server update',
                ),
              ),
            options,
          );
        }
        if (operation.startsWith('promise-')) {
          const failed = operation === 'promise-error';
          const promise = new Promise((resolve, reject) =>
            setTimeout(() => (failed ? reject(new Error('fixture failure')) : resolve('fixture result')), 500),
          );
          void toast
            .promise(
              promise,
              {
                loading: 'Promise operation is running',
                success: 'Promise operation completed',
                error: 'Promise operation failed',
              },
              options,
            )
            .catch(() => undefined);
          return options.id;
        }
        return operation === 'blank' ? toast(message, options) : toast[operation](message, options);
      },
      { bindings, operation, message, options },
    );
  const clear = async () => {
    await invoke('remove');
    await page.waitForFunction(() => document.querySelectorAll('.orbis-notification').length === 0);
    await settle();
  };
  const expectType = async (id, type) => {
    await page.locator(`[data-notification-id="${id}"][data-notification-type="${type}"]`).waitFor();
    assert.equal(await card(id).count(), 1, 'a toast update must retain a single card/id');
  };
  const measure = async () =>
    tray().evaluate((element) => {
      const box = (node) => {
        const rect = node.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
          cx: rect.x + rect.width / 2,
          cy: rect.y + rect.height / 2,
        };
      };
      const resolved = (value, property) => {
        const probe = document.createElement('span');
        probe.style[property] = value;
        probe.style.position = 'fixed';
        probe.style.visibility = 'hidden';
        document.body.append(probe);
        const result = getComputedStyle(probe)[property];
        probe.remove();
        return result;
      };
      const styles = getComputedStyle(element);
      const token = (name, property = 'color') => resolved(styles.getPropertyValue(name), property);
      const desktop = document.querySelector('.desktop');
      return {
        tray: box(element),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        mode: element.dataset.desktopMode,
        preset: element.dataset.desktopPreset,
        desktopMode: desktop.dataset.desktopMode,
        desktopPreset: desktop.dataset.desktopPreset,
        tokens: {
          ink: token('--desktop-ink'),
          surface: token('--desktop-surface', 'backgroundColor'),
          success: token('--desktop-positive'),
          error: token('--desktop-negative'),
          accent: token('--desktop-accent'),
        },
        header: box(document.querySelector('.desktop-system-bar')),
        dock: box(document.querySelector('.desktop-dock')),
        overflow: document.documentElement.scrollWidth > innerWidth,
        cards: [...element.querySelectorAll('.orbis-notification')].map((node) => {
          const message = node.querySelector('.orbis-notification-message');
          const icon = node.querySelector('.orbis-notification-icon');
          const dismiss = node.querySelector('.orbis-notification-dismiss');
          return {
            id: node.dataset.notificationId,
            type: node.dataset.notificationType,
            box: box(node),
            background: getComputedStyle(node).backgroundColor,
            color: getComputedStyle(node).color,
            iconColor: getComputedStyle(icon).color,
            icon: box(icon),
            dismiss: box(dismiss),
            message: box(message),
            action: message.querySelector('button') ? box(message.querySelector('button')) : null,
            role: node.getAttribute('role'),
            live: node.getAttribute('aria-live'),
          };
        }),
      };
    });
  const assertGeometry = (geometry) => {
    assert.equal(geometry.overflow, false);
    assert.ok(geometry.tray.y >= geometry.header.bottom + 4, 'notifications must start below the system bar');
    assert.ok(geometry.tray.bottom <= geometry.dock.y - 8, 'the notification stack must clear the dock');
    assert.equal(geometry.mode, geometry.desktopMode);
    assert.equal(geometry.preset, geometry.desktopPreset);
    for (const item of geometry.cards) {
      assert.equal(item.color, geometry.tokens.ink, 'portal foreground must use the current theme');
      assert.equal(item.background, geometry.tokens.surface, 'portal surface must use the current theme');
      const iconToken = item.type === 'success' ? 'success' : item.type === 'error' ? 'error' : 'accent';
      assert.equal(item.iconColor, geometry.tokens[iconToken]);
      assert.ok(item.box.x >= 16 && item.box.right <= page.viewportSize().width - 16, 'toast must fit the viewport horizontally');
      assert.ok(Math.abs(item.icon.cy - item.dismiss.cy) < 0.6, 'icon and dismiss centres must align');
      assert.ok(item.message.right <= item.dismiss.x - 8, 'message must stay clear of the dismiss control');
      if (item.action)
        assert.ok(
          item.action.right <= item.message.right + 1,
          `notification action right ${item.action.right} must fit message right ${item.message.right}`,
        );
      assert.ok(['status', 'alert'].includes(item.role) && ['polite', 'assertive'].includes(item.live), 'messages must retain live-region semantics');
    }
  };

  try {
    await page.goto(`${base}/settings?tab=appearance`, { waitUntil: 'domcontentloaded' });
    await page.locator('.appearance').waitFor();
    await page.locator('.appearance-modes').getByRole('button', { name: 'Light', exact: true }).waitFor();
    await page.locator('.appearance-modes').getByRole('button', { name: 'Dark', exact: true }).waitFor();
    report.behavior.modeLabels = ['Light', 'Dark'];
    await tray().waitFor({ state: 'attached' });
    bindings = await resolveBindings();
    report.bindings = bindings;
    await page.waitForFunction(() => window.__orbisNotificationStreams?.emit);
    assert.equal(await page.evaluate(() => window.__orbisNotificationStreams.emit({ event: 'start_success', appUrn: 'media:test' })), 1);
    await page.locator('.orbis-notification[data-notification-type="success"]').getByText('media started.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__orbisNotificationStreams.emit({ event: 'start_error', appUrn: 'media:test' })), 1);
    await page.locator('.orbis-notification[data-notification-type="error"]').waitFor();
    report.behavior.inheritedSseCalls = true;
    await clear();

    for (const outcome of ['success', 'error']) {
      const id = `notification-qa-promise-${outcome}`;
      await invoke(`promise-${outcome}`, '', { id, duration: 600000 });
      await expectType(id, 'loading');
      await expectType(id, outcome);
      await clear();
    }
    report.behavior.promiseUpdatesSameCard = true;
    if (checkTiming) {
      await page.mouse.move(0, 0);
      await page.getByRole('textbox', { name: 'Server name', exact: true }).focus();
      const id = await invoke('loading', 'Long-running server operation');
      await expectType(id, 'loading');
      await page.waitForTimeout(5300);
      assert.equal(await card(id).isVisible(), true, 'loading must remain visible beyond the default success timeout');
      await invoke('success', 'Server operation completed', { id, duration: 600000 });
      await expectType(id, 'success');
      await clear();
      report.behavior.loadingPersistsUntilCompletion = true;
    }

    const ids = [];
    ids.push(await invoke('blank', 'Orbis can keep server notices in the same place.', { duration: 600000 }));
    ids.push(await invoke('loading', 'Checking your homelab services and their current configuration', { duration: 600000 }));
    ids.push(await invoke('success', 'Your server settings were saved successfully.', { duration: 600000 }));
    ids.push(
      await invoke(
        'error',
        'A service could not be updated. The previous configuration remains available so you can review the issue and try again. /srv/' +
          'long-storage-directory-'.repeat(8),
        { duration: 600000 },
      ),
    );
    const actionId = await invoke(
      'custom-action',
      'A server update is ready. Review the changelog and choose when to apply it; your current services can keep running in the meantime.',
      { duration: 600000 },
    );
    ids.push(actionId);
    for (const preset of presets) {
      await page.locator(`.appearance-preset-${preset}`).focus();
      await page.keyboard.press('Enter');
      await page.locator(`.desktop[data-desktop-preset="${preset}"]`).waitFor();
      for (const mode of modes) {
        if (!(await page.locator(`.desktop[data-desktop-mode="${mode}"]`).count())) {
          await page.getByRole('button', { name: `Switch to ${mode} mode`, exact: true }).click();
          await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
        }
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          document.querySelector('.orbis-notifications').scrollTop = 0;
        });
        await settle();
        const geometry = await measure();
        assert.deepEqual(geometry.cards.map((item) => item.id).sort(), [...ids].sort(), 'visible notifications must survive a theme change');
        assertGeometry(geometry);
        report.themes.push(geometry);
        await shot(`${preset}-${mode}-notifications`);
      }
    }
    report.behavior.allTypesAndThemeChanges = true;
    const scroll = await tray().evaluate((node) => ({ top: node.scrollTop, height: node.clientHeight, total: node.scrollHeight, outer: scrollY }));
    if (scroll.total > scroll.height) {
      const first = await cards().first().boundingBox();
      await page.mouse.move(first.x + first.width / 2, first.y + 30);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(200);
      const after = await tray().evaluate((node) => ({ top: node.scrollTop, outer: scrollY }));
      assert.ok(after.top > scroll.top, 'overflowing notification stacks must scroll');
      assert.equal(after.outer, scroll.outer, 'notification scrolling must not move the desktop');
      report.behavior.stackScroll = after;
    }
    await card(actionId).getByRole('button', { name: 'Review server update', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.notificationQaAction), 'activated');
    report.behavior.customAction = true;
    await clear();

    const input = page.getByRole('textbox', { name: 'Server name', exact: true });
    await input.focus();
    const keyboardIds = [];
    for (let index = 0; index < 3; index += 1) keyboardIds.push(await invoke('blank', `Keyboard notification ${index + 1}`, { duration: 600000 }));
    await cards().first().getByRole('button', { name: 'Dismiss notification', exact: true }).focus();
    const remaining = new Set(keyboardIds);
    for (let index = 0; index < 3; index += 1) {
      const focusedId = await page.evaluate(() => document.activeElement?.closest('[data-notification-id]')?.dataset.notificationId);
      assert.ok(remaining.has(focusedId), 'keyboard focus must target an active notification');
      remaining.delete(focusedId);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(20);
      if (!remaining.size)
        assert.equal(await input.evaluate((node) => document.activeElement === node), true, 'last dismissal must restore prior app focus');
    }
    await page.waitForFunction(() => document.querySelectorAll('.orbis-notification').length === 0);
    report.behavior.rapidKeyboardDismiss = true;
    await page.mouse.move(0, 0);
    const automatic = await invoke('success', 'Short-lived notification', { duration: 150 });
    await card(automatic).waitFor();
    await card(automatic).waitFor({ state: 'hidden', timeout: 2000 });
    report.behavior.autoDismissAfterKeyboard = true;

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedId = await invoke('loading', 'Reduced motion operation', { duration: 600000 });
    await expectType(reducedId, 'loading');
    await settle();
    const reduced = await card(reducedId).evaluate((node) => ({
      iconAnimation: getComputedStyle(node.querySelector('.orbis-notification-icon svg')).animationName,
      activeAnimations: node.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length,
      transition: getComputedStyle(node.querySelector('.orbis-notification-dismiss')).transitionDuration,
    }));
    assert.equal(reduced.iconAnimation, 'none');
    assert.equal(reduced.activeAnimations, 0);
    assert.equal(reduced.transition, '0s');
    report.behavior.reducedMotion = reduced;
    await shot('reduced-motion-notification');
    await clear();
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await page.goto(`${base}/apps/test/media`, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-workspace-identity').waitFor();
    await page.locator('.app-actions').getByRole('button', { name: 'Stop', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const modalId = await invoke('error', 'This notice remains available while a dialog is open.', { duration: 600000 });
    await expectType(modalId, 'error');
    await settle();
    const hit = await card(modalId)
      .locator('.orbis-notification-dismiss')
      .evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return { accessible: target === node || node.contains(target), hidden: Boolean(node.closest('[aria-hidden="true"]')) };
      });
    assert.equal(hit.accessible, true, 'notification controls must render above modal layers');
    assert.equal(hit.hidden, false, 'live notifications must remain exposed while a dialog is open');
    await shot('modal-with-notification');
    await card(modalId).getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    assert.equal(await dialog.isVisible(), true, 'dismissing a notification must not dismiss the open dialog');
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    report.behavior.modalLayering = hit;
    assert.deepEqual(report.mutations, [], 'notification fixtures must not issue server lifecycle commands');
    return report;
  } catch (error) {
    await shot('notifications-failure').catch(() => undefined);
    throw error;
  } finally {
    if (bindings) await clear().catch(() => undefined);
    await page.emulateMedia({ reducedMotion: null });
    page.off('request', onRequest);
  }
};
