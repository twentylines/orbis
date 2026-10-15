const assert = require('node:assert/strict');

module.exports = async function inspectSelectComfort({ page, base, capture, modes = ['light', 'dark'], textScales = [1, 2] }) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '8080', 'select checks require static8080 fixtures');
  const width = page.viewportSize().width;
  if (width > 768) return { width, skipped: true };
  const report = { width, samples: [], blockedWrites: [] };
  let mode = 'light';
  const respond = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const guard = (route) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.fallback();
    report.blockedWrites.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
    return route.abort('blockedbyclient');
  };
  const context = (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return respond(route, {
      version: { current: '4.10.1', latest: '4.10.1', body: '', releases: [] },
      userSettings: {
        allowAutoThemes: false,
        localDomain: 'homelab.example.test',
        sslPort: 443,
        maxBackups: 5,
        guestDashboard: false,
        internalIp: '127.0.0.1',
        advancedSettings: true,
        timeZone: 'America/Argentina/Buenos_Aires',
        logLevel: 'info',
      },
      user: { id: 1, username: 'fixture', totpEnabled: false, locale: 'en', operator: true, hasSeenWelcome: true },
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
  await page.route('**/api/**', guard);
  await page.route('**/api/app-context', context);
  await page.route('**/api/desktop-preferences', preferences);
  const scaleText = (scale) =>
    page.evaluate((scale) => {
      if (scale === 1) return;
      const baseline = [...document.querySelectorAll('body,body *')]
        .filter((e) => e instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(e.tagName))
        .map((element) => ({ element, font: Number.parseFloat(getComputedStyle(element).fontSize), line: getComputedStyle(element).lineHeight }));
      for (const { element, font, line } of baseline) {
        element.style.setProperty('font-size', `${font * scale}px`, 'important');
        if (line !== 'normal') element.style.setProperty('line-height', `${Number.parseFloat(line) * scale}px`, 'important');
      }
    }, scale);
  const inspect = () =>
    page.getByRole('listbox').evaluate((root) => {
      const box = (element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const viewport = root.querySelector('[data-radix-select-viewport]');
      return {
        root: box(root),
        viewport: box(viewport),
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        options: [...root.querySelectorAll('[role="option"]')].map((item) => {
          const text = item.querySelector('.orbis-select-item-text');
          const indicator = item.querySelector('.orbis-select-item-indicator');
          return {
            box: box(item),
            text: item.textContent,
            accessibleName: item.getAttribute('aria-label'),
            checked: item.dataset.state === 'checked',
            label: box(text),
            indicator: box(indicator),
            glyph: indicator.querySelector('svg') ? box(indicator.querySelector('svg')) : null,
            words: [...text.querySelectorAll('.orbis-whole-word')].map((word) => {
              const range = document.createRange();
              range.selectNodeContents(word);
              return {
                text: word.textContent,
                box: box(word),
                clientWidth: word.clientWidth,
                scrollWidth: word.scrollWidth,
                title: word.closest('[title]')?.title,
                overflow: getComputedStyle(word).textOverflow,
                ys: [...new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.y * 10) / 10))],
              };
            }),
          };
        }),
      };
    });
  const check = (geometry) => {
    const height = page.viewportSize().height;
    const normalize = (text) => text.replace(/\s+/g, ' ').trim();
    assert.ok(geometry.root.x >= 15.4 && geometry.root.right <= width - 15.4, 'select popup needs16px side clearance');
    assert.ok(geometry.root.y >= 15.4 && geometry.root.bottom <= height - 15.4, 'select popup needs16px vertical clearance');
    assert.ok(geometry.viewport.height >= 40, 'select needs a usable scrolling viewport');
    for (const item of geometry.options) {
      assert.equal(normalize(item.accessibleName), normalize(item.text), 'string option must retain its full accessible name');
      assert.ok(item.label.right + 8 <= item.indicator.x, 'option text must reserve check-indicator space');
      assert.ok(item.indicator.right <= item.box.right - 7, 'selection indicator must fit inside option padding');
      if (item.glyph) assert.ok(Math.abs(item.glyph.width - 20) <= 0.6 && Math.abs(item.glyph.height - 20) <= 0.6, 'check glyph must not shrink');
      for (const word of item.words) {
        assert.ok(word.ys.length <= 1, `ordinary word must not split: ${word.text}`);
        assert.ok(word.box.x >= item.label.x - 0.6 && word.box.right <= item.label.right + 0.6, 'word must fit its text column');
        if (word.scrollWidth > word.clientWidth + 1) {
          assert.equal(word.overflow, 'ellipsis', 'oversized single token needs an explicit ellipsis');
          assert.equal(normalize(word.title), normalize(item.text), 'single-token ellipsis must retain the full label tooltip');
        }
      }
    }
  };
  const openList = async (trigger) => {
    await trigger.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await trigger.click();
    await page.getByRole('listbox').waitFor();
    await page.waitForTimeout(200);
  };
  try {
    for (const currentMode of modes)
      for (const scale of textScales) {
        mode = currentMode;
        await page.goto(`${base}/settings?tab=settings`, { waitUntil: 'domcontentloaded' });
        await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
        const timezone = page.getByRole('combobox', { name: 'Timezone', exact: true });
        await timezone.waitFor();
        await openList(timezone);
        const nativeFonts = await page.getByRole('listbox').evaluate((root) => ({
          font: Number.parseFloat(getComputedStyle(root).fontSize),
          line: Number.parseFloat(getComputedStyle(root).lineHeight),
          itemFont: Number.parseFloat(getComputedStyle(root.querySelector('[role="option"]')).fontSize),
          itemLine: Number.parseFloat(getComputedStyle(root.querySelector('[role="option"]')).lineHeight),
        }));
        await page.keyboard.press('Escape');
        await scaleText(scale);
        if (scale === 2)
          await page.addStyleTag({
            content: `
        .orbis-select-content{font-size:${nativeFonts.font * 2}px!important;line-height:${nativeFonts.line * 2}px!important}
        .orbis-select-item{font-size:${nativeFonts.itemFont * 2}px!important;line-height:${nativeFonts.itemLine * 2}px!important}
      `,
          });
        await openList(timezone);
        const geometry = await inspect();
        check(geometry);
        assert.ok(geometry.scrollHeight > geometry.clientHeight, 'long timezone lists must have vertical scrolling');
        await capture?.(`${mode}-text${scale * 100}-timezone-open`, { scrollTop: false });
        await page.keyboard.press('End');
        await page.waitForFunction(() => {
          const options = [...document.querySelectorAll('[role="listbox"] [role="option"]')];
          const item = options.at(-1);
          const viewport = item?.closest('[data-radix-select-viewport]');
          if (!item || !viewport || document.activeElement !== item) return false;
          const row = item.getBoundingClientRect();
          const box = viewport.getBoundingClientRect();
          return row.top >= box.top - 0.6 && row.bottom <= box.bottom + 0.6;
        });
        const last = await page.locator('[role="option"]:focus').evaluate((e) => {
          const r = e.getBoundingClientRect();
          const viewport = e.closest('[data-radix-select-viewport]').getBoundingClientRect();
          return { text: e.textContent, top: r.top, bottom: r.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
        });
        assert.ok(last.top >= last.viewportTop - 0.6 && last.bottom <= last.viewportBottom + 0.6, 'keyboard End must reveal the full last option');
        await page.keyboard.press('Home');
        await page.waitForFunction(() => document.activeElement === document.querySelector('[role="listbox"] [role="option"]'));
        await page.keyboard.type('(GMT+12', { delay: 40 });
        const typed = await page.locator('[role="option"]:focus').innerText();
        assert.ok(typed.startsWith('(GMT+12'), 'timezone typeahead must still find matching labels');
        await page.keyboard.press('Enter');
        await page.getByRole('listbox').waitFor({ state: 'hidden' });
        await page.waitForFunction((trigger) => document.activeElement === trigger, await timezone.elementHandle());
        assert.equal(await timezone.evaluate((e) => e === document.activeElement), true, 'selection must return focus to the labelled trigger');
        assert.equal((await timezone.innerText()).replace(/\s+/g, ' '), typed.replace(/\s+/g, ' '), 'trigger must copy the complete selected label');
        await capture?.(`${mode}-text${scale * 100}-timezone-selected`, { scrollTop: false });
        const level = page.getByRole('combobox', { name: 'Log level', exact: true });
        await openList(level);
        const logLevel = await inspect();
        check(logLevel);
        await capture?.(`${mode}-text${scale * 100}-log-level-open`, { scrollTop: false });
        await page.keyboard.press('Escape');
        report.samples.push({ mode, textScale: scale, timezone: geometry, logLevel, keyboardLast: last, typeahead: typed });
      }
    assert.deepEqual(
      report.blockedWrites.filter((request) => request.path !== '/api/desktop-preferences'),
      [],
      'no app/host/auth mutation may be attempted',
    );
    return report;
  } catch (error) {
    await capture?.('select-comfort-failure', { scrollTop: false }).catch(() => undefined);
    throw error;
  } finally {
    await page.unroute('**/api/desktop-preferences', preferences);
    await page.unroute('**/api/app-context', context);
    await page.unroute('**/api/**', guard);
  }
};
