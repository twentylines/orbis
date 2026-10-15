const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Use a dedicated page with visual-qa's API fixtures; the init script lasts for this page.
module.exports = async function inspectConnectionStatus(
  page,
  {
    setServerAddress,
    screenshotDir,
    captureHeader,
    modes = ['light', 'dark'],
    defaultAddress = '127.0.0.1',
    addresses = setServerAddress ? ['127.0.0.1', '2001:0db8:85a3:0000:0000:8a2e:0370:7334'] : [defaultAddress],
    viewports = [
      { width: 1440, height: 1120 },
      { width: 1024, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 320, height: 800 },
    ],
    captureWidths = [1440, 320],
    prefix = 'connection',
  } = {},
) {
  const base = new URL(page.url()).origin;
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'connection checks require loopback fixtures');
  assert.ok(setServerAddress || addresses.every((address) => address === defaultAddress), 'different addresses require a fixture callback');
  const initialViewport = page.viewportSize();
  const mutations = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.pathname !== '/api/desktop-preferences')
      mutations.push({ method: request.method(), path: url.pathname });
  };
  page.on('request', onRequest);
  await page.addInitScript(() => {
    const instances = [];
    class HeldEventSource extends EventTarget {
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
        instances.push(this);
      }
      close() {
        this.readyState = this.CLOSED;
      }
    }
    const active = () => instances.filter((source) => new URL(source.url).pathname === '/api/sse/app' && source.readyState !== 2);
    window.EventSource = HeldEventSource;
    window.__orbisConnectionFixtureStreams = {
      summary: () => instances.map((source) => ({ url: source.url, state: source.readyState })),
      open: () => {
        const source = active().at(-1);
        if (!source) return false;
        source.readyState = 1;
        source.onopen?.(new Event('open'));
        return true;
      },
      fail: () => {
        const source = active().at(-1);
        if (!source || source.readyState !== 1) return false;
        source.onerror?.(new Event('error'));
        return true;
      },
    };
  });

  const report = [];
  const near = (a, b, message) => assert.ok(Math.abs(a - b) <= 0.6, `${message}: ${a} vs ${b}`);
  const settle = async () => {
    await page.locator('.desktop-system-bar').evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  };
  const measure = () =>
    page.locator('.desktop-system-bar').evaluate((bar) => {
      const box = (element) => {
        const rect = element.getBoundingClientRect();
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
      const visible = (element) => element && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0;
      const connection = bar.querySelector('.desktop-connection');
      const label = connection.querySelector('.desktop-connection-label');
      const dot = connection.querySelector('.desktop-connection-dot');
      const range = document.createRange();
      range.selectNodeContents(label);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const style = getComputedStyle(label);
      const controls = [...bar.querySelectorAll('.desktop-task-trigger, .desktop-mode-toggle, .desktop-search-trigger, .desktop-icon-button')].map(
        (element) => ({
          ...box(element),
          glyph: box(element.querySelector('svg')),
          label: element.getAttribute('aria-label'),
        }),
      );
      const parts = [
        ...bar.querySelectorAll('.desktop-brand, .desktop-current'),
        ...bar.querySelectorAll('.desktop-task-trigger, .desktop-mode-toggle, .desktop-search-trigger, .desktop-icon-button'),
        connection,
      ]
        .filter(visible)
        .map(box);
      return {
        bar: box(bar),
        output: box(connection),
        label: box(label),
        dot: box(dot),
        text: connection.innerText.trim(),
        title: connection.title,
        accessibleName: connection.getAttribute('aria-label'),
        labels: connection.querySelectorAll('.desktop-connection-label').length,
        small: connection.querySelectorAll('small').length,
        childElements: connection.children.length,
        textRects: rects.map((rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom })),
        labelScrollWidth: label.scrollWidth,
        labelClientWidth: label.clientWidth,
        typography: {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
        },
        controls,
        parts,
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
      };
    });
  const check = async (state, address, context) => {
    const text = state === 'connected' ? address : state === 'connecting' ? 'Connecting' : 'Reconnecting';
    await page.waitForFunction(
      ({ state, text }) =>
        document.querySelector(`.desktop-connection-dot.is-${state}`) && document.querySelector('.desktop-connection-label')?.textContent === text,
      { state, text },
    );
    await settle();
    const result = await measure();
    assert.equal(result.text, text, `${context}: exact single visible label`);
    assert.equal(result.title, text, `${context}: title`);
    assert.equal(result.accessibleName, state === 'connected' ? `Connected to server ${address}` : text, `${context}: accessible name`);
    assert.equal(result.labels, 1, `${context}: one label`);
    assert.equal(result.small, 0, `${context}: no secondary small text`);
    assert.equal(result.childElements, 2, `${context}: only dot and label`);
    assert.equal(result.textRects.length, 1, `${context}: label must occupy one line`);
    assert.ok(result.labelScrollWidth <= result.labelClientWidth + 1, `${context}: full label must fit`);
    assert.ok(result.textRects[0].right <= result.label.right + 0.6, `${context}: text must not be ellipsized`);
    assert.ok(result.textRects[0].x >= result.label.x - 0.6, `${context}: text must not clip at its start`);
    near(result.dot.cy, result.label.cy, `${context}: dot and label centre`);
    near(result.output.cy, result.label.cy, `${context}: output and label centre`);
    assert.ok(result.dot.right + 3 <= result.label.x, `${context}: dot and text need separation`);
    assert.ok(result.output.x >= result.bar.x + 8 && result.output.right <= result.bar.right - 8, `${context}: connection needs header insets`);
    assert.ok(result.output.y >= result.bar.y && result.output.bottom <= result.bar.bottom, `${context}: connection must fit vertically`);
    assert.ok(result.bar.x >= 0 && result.bar.right <= result.viewport.width + 0.6, `${context}: header must fit viewport`);
    assert.ok(result.documentWidth <= result.viewport.width, `${context}: no document overflow`);
    assert.equal(result.controls.length, 4, `${context}: all header controls present`);
    for (const control of result.controls) {
      near(control.cy, result.controls[0].cy, `${context}: controls aligned`);
      near(control.height, result.controls[0].height, `${context}: control heights`);
      near(control.glyph.cy, control.cy, `${context}: control icon centre`);
      assert.ok(control.x >= result.bar.x + 8 && control.right <= result.bar.right - 8, `${context}: control horizontal fit`);
      assert.ok(control.y >= result.bar.y && control.bottom <= result.bar.bottom, `${context}: control vertical fit`);
    }
    for (let i = 0; i < result.parts.length; i++) {
      for (const other of result.parts.slice(i + 1)) {
        const part = result.parts[i];
        const overlapX = Math.min(part.right, other.right) - Math.max(part.x, other.x);
        const overlapY = Math.min(part.bottom, other.bottom) - Math.max(part.y, other.y);
        assert.ok(overlapX <= 0.6 || overlapY <= 0.6, `${context}: header elements overlap`);
      }
    }
    return result;
  };

  try {
    if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
    for (const address of addresses) {
      if (setServerAddress) await setServerAddress(address);
      const family = address.includes(':') ? 'ipv6' : 'ipv4';
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        for (const mode of modes) {
          await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
          await page.getByRole('heading', { name: 'Hades', exact: true }).waitFor();
          await page.waitForFunction(() =>
            window.__orbisConnectionFixtureStreams?.summary().some(({ url, state }) => new URL(url).pathname === '/api/sse/app' && state === 0),
          );
          if ((await page.locator('.desktop').getAttribute('data-desktop-mode')) !== mode) {
            await page.getByRole('button', { name: `Switch to ${mode} mode`, exact: true }).click();
            await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
          }
          const context = `${viewport.width}px ${mode} ${family}`;
          const states = [];
          for (const state of ['connecting', 'connected', 'reconnecting']) {
            if (state === 'connected') assert.equal(await page.evaluate(() => window.__orbisConnectionFixtureStreams.open()), true);
            if (state === 'reconnecting') assert.equal(await page.evaluate(() => window.__orbisConnectionFixtureStreams.fail()), true);
            const result = await check(state, address, `${context} ${state}`);
            if (states.length) {
              assert.deepEqual(result.typography, states[0].geometry.typography, `${context}: status changes must preserve typography`);
              result.controls.forEach((control, index) => {
                near(control.y, states[0].geometry.controls[index].y, `${context}: status changes must preserve control baseline`);
                near(control.height, states[0].geometry.controls[index].height, `${context}: status changes must preserve control height`);
              });
            }
            if (captureWidths.includes(viewport.width)) {
              const clip = {
                x: Math.max(0, Math.floor(result.bar.x) - 8),
                y: Math.max(0, Math.floor(result.bar.y) - 8),
                width: Math.min(viewport.width, Math.ceil(result.bar.width) + 16),
                height: Math.ceil(result.bar.height) + 16,
              };
              const name = `${prefix}-${viewport.width}-${mode}-${family}-${state}.png`;
              if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, name), clip, animations: 'disabled' });
              if (captureHeader) await captureHeader(name, { clip });
            }
            states.push({ state, geometry: result });
          }
          await page.evaluate(() => window.dispatchEvent(new Event('online')));
          await page.waitForFunction(() =>
            window.__orbisConnectionFixtureStreams.summary().some(({ url, state }) => new URL(url).pathname === '/api/sse/app' && state === 0),
          );
          assert.equal(await page.evaluate(() => window.__orbisConnectionFixtureStreams.open()), true);
          await check('connected', address, `${context} recovered`);
          report.push({ width: viewport.width, mode, address, states, recovered: true });
        }
      }
    }
    assert.deepEqual(mutations, [], 'connection checks must not submit app, store or host operations');
    return report;
  } finally {
    page.off('request', onRequest);
    if (setServerAddress) await setServerAddress(defaultAddress);
    if (initialViewport) await page.setViewportSize(initialViewport);
  }
};
