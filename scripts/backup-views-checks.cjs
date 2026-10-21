const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser } = require('./live-compact-ui-qa.cjs');

const fixtures = [
  { id: 'media-test-1792526400000.tar.gz', date: 1792526400000, size: 2097152 },
  { id: 'media-library-backups-test-1792526400000-59a0f117-32dd-4c22-bf14-c5e7b513fe01.tar.gz', date: 1792526400000, size: 2147483648 },
  { id: 'media-library-backups-test-1792526400000-59a0f117-32dd-4c22-bf14-c5e7b513fe02.tar.gz', date: 1792526400000, size: 4294967296 },
];

async function geometry(root) {
  return root.evaluate((root) => {
    const rect = root.getBoundingClientRect();
    const text = [];
    const scrollHidden = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim() || !node.parentElement.getClientRects().length) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      let left = rect.left;
      let right = rect.right;
      let scrollLeft = rect.left;
      let scrollRight = rect.right;
      let accessibleEllipsis = false;
      for (let parent = node.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const p = parent.getBoundingClientRect();
        const label = parent.title || parent.getAttribute('aria-label') || '';
        if (style.textOverflow === 'ellipsis' && label.includes(node.textContent.trim())) accessibleEllipsis = true;
        if (['hidden', 'clip'].includes(style.overflowX)) {
          left = Math.max(left, p.left + Number.parseFloat(style.borderLeftWidth));
          right = Math.min(right, p.right - Number.parseFloat(style.borderRightWidth));
        }
        if (['auto', 'scroll'].includes(style.overflowX)) {
          scrollLeft = Math.max(scrollLeft, p.left + Number.parseFloat(style.borderLeftWidth));
          scrollRight = Math.min(scrollRight, p.right - Number.parseFloat(style.borderRightWidth));
        }
      }
      for (const r of range.getClientRects()) {
        if (!accessibleEllipsis && (r.left < left - 1 || r.right > right + 1)) {
          const finding = { text: node.textContent.trim(), left: r.left, right: r.right, clip: { left, right } };
          text.push(finding);
        } else if (!accessibleEllipsis && (r.left < scrollLeft - 1 || r.right > scrollRight + 1)) {
          scrollHidden.push({ text: node.textContent.trim(), left: r.left, right: r.right, clip: { left: scrollLeft, right: scrollRight } });
        }
      }
    }
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      root: { left: rect.left, right: rect.right },
      clippedText: text,
      scrollHidden,
    };
  });
}

async function focus(page) {
  return page.evaluate(() => {
    const target = document.activeElement;
    const r = target.getBoundingClientRect();
    const modal = target.closest('[role=dialog]');
    let left = 0;
    let right = innerWidth;
    let top = modal ? 0 : document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom;
    let bottom = modal ? innerHeight : document.querySelector('.desktop-dock').getBoundingClientRect().top;
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      if (parent === document.body || parent === document.documentElement) continue;
      const style = getComputedStyle(parent);
      const p = parent.getBoundingClientRect();
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) {
        left = Math.max(left, p.left + Number.parseFloat(style.borderLeftWidth));
        right = Math.min(right, p.right - Number.parseFloat(style.borderRightWidth));
      }
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
        top = Math.max(top, p.top + Number.parseFloat(style.borderTopWidth));
        bottom = Math.min(bottom, p.bottom - Number.parseFloat(style.borderBottomWidth));
      }
    }
    const style = getComputedStyle(target);
    const markerExtent = Number.parseFloat(style.outlineWidth) + Math.max(0, Number.parseFloat(style.outlineOffset));
    return {
      text: target.textContent.trim(),
      focusVisible: target.matches(':focus-visible'),
      markerVisible:
        style.outlineStyle !== 'none' &&
        Number.parseFloat(style.outlineWidth) > 0 &&
        style.outlineColor !== 'transparent' &&
        !/(?:,|\/)\s*0(?:\.0+)?\s*\)$/.test(style.outlineColor),
      markerExtent,
      wholeMarkerVisible:
        r.left - markerExtent >= left && r.right + markerExtent <= right && r.top - markerExtent >= top && r.bottom + markerExtent <= bottom,
      rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      clip: { left, right, top, bottom },
      outline: style.outline,
      shadow: style.boxShadow,
    };
  });
}

module.exports = async function inspectBackups({ page, base, preferences, screenshotDir, actions }) {
  assert.equal(base, 'http://localhost:8080', 'Backup views require isolated source fixtures');
  const report = { passed: false, samples: [], mutations: [], errors: [], cleanup: {}, fixtures };
  const viewport = page.viewportSize();
  const key = 'server-desktop-preferences-v1';
  const stored = await page.evaluate((key) => localStorage.getItem(key), key);
  const shadow = structuredClone(preferences);
  const handler = (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base || !['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/desktop-preferences') return route.fulfill({ json: shadow });
    if (url.pathname.startsWith('/api/backups/'))
      return route.fulfill({ json: { currentPage: 1, data: fixtures, lastPage: 1, total: fixtures.length } });
    return route.fallback();
  };
  const onError = (error) => report.errors.push(error.message);
  const capture = async (name) => {
    await browser.settled(page);
    await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), animations: 'disabled', fullPage: false });
  };
  await page.route('**/*', handler);
  page.on('pageerror', onError);
  try {
    for (const mode of ['light', 'dark'])
      for (const group of [
        { width: 1440, height: 1120, scale: 1 },
        { width: 390, height: 844, scale: 1 },
        { width: 320, height: 800, scale: 2 },
      ]) {
        const tag = `${mode}-${group.width}-text${group.scale}`;
        const sample = { mode, ...group, passed: false, findings: [], dialogs: [] };
        report.samples.push(sample);
        shadow.mode = mode;
        await browser.restoreText(page);
        await page.setViewportSize({ width: group.width, height: group.height });
        await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key, value: shadow });
        await page.goto(`${base}/apps/test/media?tab=backups`, { waitUntil: 'domcontentloaded' });
        const card = page.locator('.app-backups');
        await card.getByRole('button', { name: 'Backup now', exact: false }).waitFor();
        await page.waitForFunction((mode) => document.querySelector('.desktop[data-desktop-mode]')?.dataset.desktopMode === mode, mode);
        await page.evaluate(() => document.fonts.ready);
        await browser.scaleText(page, group.scale);
        const rows = card.locator('.app-backup-row');
        assert.equal(await rows.count(), 3);
        await browser.wheelVisible(page, card.locator('.card-header'));
        sample.table = await geometry(card);
        await capture(`${tag}-table`);
        const row = rows.last();
        const restore = row.getByRole('button', { name: 'Restore', exact: true });
        const remove = row.getByRole('button', { name: 'Delete', exact: true });
        await restore.focus();
        await page.keyboard.press('Tab');
        await browser.settled(page);
        assert.equal(await remove.evaluate((element) => element === document.activeElement), true);
        sample.actionFocus = await focus(page);
        if (!sample.actionFocus.focusVisible || !sample.actionFocus.markerVisible || !sample.actionFocus.wholeMarkerVisible)
          sample.findings.push('Last-row action or its focus marker is clipped');
        await capture(`${tag}-table-action-focus`);
        for (const [name, opener] of [
          ['restore', restore],
          ['delete', remove],
        ]) {
          await opener.focus();
          await page.keyboard.press('Enter');
          const dialog = page.getByRole('dialog');
          await dialog.waitFor();
          await browser.settled(page);
          const value = await geometry(dialog.locator('.modal-body'));
          value.name = name;
          value.identifierPresent = (await dialog.innerText()).includes(fixtures[2].id);
          const close = dialog.getByRole('button', { name: 'Close dialog', exact: true });
          await close.focus();
          await page.keyboard.press('Tab');
          await browser.settled(page);
          value.focus = await focus(page);
          value.intendedActionFocused = await dialog
            .getByRole('button', { name: name === 'restore' ? 'Restore' : 'Delete', exact: true })
            .evaluate((element) => element === document.activeElement);
          await capture(`${tag}-${name}-dialog`);
          if (group.scale === 2) {
            const body = dialog.locator('.modal-body');
            const metadata = dialog.locator('.backup-metadata');
            value.detailsRevealedByWheel = false;
            for (let attempt = 0; attempt < 20; attempt++) {
              const bounds = await body.boundingBox();
              const target = await metadata.boundingBox();
              if (target.y >= bounds.y + 8 && target.y + target.height <= bounds.y + bounds.height - 8) {
                value.detailsRevealedByWheel = true;
                break;
              }
              await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
              await page.mouse.wheel(0, 240);
              await browser.settled(page);
            }
            if (!value.detailsRevealedByWheel) sample.findings.push(`${name} backup details cannot be read by scrolling`);
            await capture(`${tag}-${name}-dialog-details`);
          }
          if (value.horizontalOverflow || value.clippedText.length) sample.findings.push(`${name} dialog text overflows`);
          if (!value.identifierPresent) sample.findings.push(`${name} dialog omits the selected identifier`);
          if (!value.intendedActionFocused || !value.focus.focusVisible || !value.focus.markerVisible || !value.focus.wholeMarkerVisible)
            sample.findings.push(`${name} dialog action focus is clipped or incorrect`);
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
          const openerHandle = await opener.elementHandle();
          value.openerFocusReturned = await page
            .waitForFunction((element) => element === document.activeElement, openerHandle, { timeout: 1500 })
            .then(
              () => true,
              () => false,
            );
          await openerHandle.dispose();
          if (!value.openerFocusReturned) sample.findings.push(`${name} dialog focus did not return`);
          sample.dialogs.push(value);
        }
        if (sample.table.horizontalOverflow) sample.findings.push('Document overflows horizontally');
        if (sample.table.clippedText.length) sample.findings.push('Backup row text is clipped');
        sample.passed = sample.findings.length === 0;
      }
    assert.deepEqual(actions, [], 'Backup view checks must not submit application actions');
  } catch (error) {
    report.errors.push(error.stack || error.message);
  } finally {
    for (const [operationName, operation] of [
      ['textRestored', () => browser.restoreText(page)],
      ['viewportRestored', () => page.setViewportSize(viewport)],
      [
        'storageRestored',
        () =>
          page.evaluate(({ key, stored }) => (stored === null ? localStorage.removeItem(key) : localStorage.setItem(key, stored)), { key, stored }),
      ],
      ['routesRestored', () => page.unroute('**/*', handler)],
      ['listenerRestored', () => page.off('pageerror', onError)],
    ]) {
      try {
        await operation();
        report.cleanup[operationName] = true;
      } catch (error) {
        report.cleanup[operationName] = false;
        report.errors.push(error.message);
      }
    }
  }
  report.passed =
    report.samples.length === 6 &&
    report.samples.every((sample) => sample.passed && sample.dialogs.length === 2) &&
    !report.mutations.length &&
    !report.errors.length &&
    Object.keys(report.cleanup).length === 5 &&
    Object.values(report.cleanup).every(Boolean);
  fs.writeFileSync(path.join(screenshotDir, 'backup-views.private.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return report;
};
