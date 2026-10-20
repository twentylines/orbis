const assert = require('node:assert/strict');
const { dom } = require('./host-devices-checks.cjs');

async function placeholder(page) {
  return page.locator('.desktop-search-input input').evaluate((input) => {
    const style = getComputedStyle(input);
    const canvas = document.createElement('canvas').getContext('2d');
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const spacing = Number.parseFloat(style.letterSpacing) || 0;
    return {
      accessibleName: input.getAttribute('aria-label'),
      text: input.placeholder,
      textWidth: canvas.measureText(input.placeholder).width + Math.max(0, input.placeholder.length - 1) * spacing,
      available: input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
    };
  });
}

function checkPlaceholder(value) {
  assert.equal(value.accessibleName, 'Search apps and settings', 'Search must retain its complete accessible scope');
  assert.ok(value.textWidth + 8 <= value.available, 'The complete search placeholder must fit with caret clearance');
}

async function digest(page) {
  return page.locator('.desktop-update-image').evaluate((row) => {
    const value = row.querySelector('code');
    const label = row.querySelector('span');
    const style = getComputedStyle(value);
    const range = document.createRange();
    range.selectNodeContents(value);
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, height: r.height };
    };
    return {
      text: value.textContent,
      title: value.title,
      label: label.textContent,
      row: box(row),
      value: box(value),
      gap: value.getBoundingClientRect().left - label.getBoundingClientRect().right,
      lines: new Set([...range.getClientRects()].filter((r) => r.width && r.height).map((r) => Math.round(r.top))).size,
      ellipsis: style.overflowX === 'hidden' && style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap',
      background: style.backgroundColor,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(Number.parseFloat),
      followsTextColour: style.color === getComputedStyle(row).color,
    };
  });
}

function checkDigest(value, expected) {
  assert.equal(value.text, expected, 'The full image identity must remain in the DOM');
  assert.equal(value.title, expected, 'The full image identity must remain available');
  assert.equal(value.label, 'Image');
  assert.equal(value.lines, 1, 'The image digest must occupy one readable line');
  assert.equal(value.ellipsis, true, 'Long image digests must use bounded ellipsis');
  assert.equal(value.background, 'rgba(0, 0, 0, 0)', 'The digest must not add an opaque code box');
  assert.deepEqual(value.padding, [0, 0, 0, 0], 'The digest must align with the surrounding metadata');
  assert.equal(value.followsTextColour, true, 'The digest must inherit the current theme text colour');
  assert.ok(value.value.left >= value.row.left && value.value.right <= value.row.right + 1, 'The image digest must fit its allocation');
  assert.ok(value.gap >= 8 && value.value.right - value.value.left >= 40, 'Image label and identifier need separate usable space');
}

async function revealDigest(page) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const bounds = await page.locator('.desktop-update-image').evaluate((row) => {
      const r = row.getBoundingClientRect();
      const top = document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom + 16;
      const bottom = document.querySelector('.desktop-dock').getBoundingClientRect().top - 16;
      return { top: r.top, bottom: r.bottom, limitTop: top, limitBottom: bottom, x: r.left + 20, y: top + 30 };
    });
    if (bounds.top >= bounds.limitTop && bounds.bottom <= bounds.limitBottom) return;
    await page.mouse.move(bounds.x, bounds.y);
    const delta = bounds.top < bounds.limitTop ? bounds.top - bounds.limitTop : bounds.bottom - bounds.limitBottom;
    await page.mouse.wheel(0, Math.max(-700, Math.min(700, delta)));
    await page.waitForTimeout(100);
  }
  throw new Error('Natural wheel could not reveal the complete image digest');
}

module.exports = async function inspectCompactCopy({ page, base, preferences, capture }) {
  const origin = new URL(base);
  assert.equal(origin.origin, 'http://localhost:8080', 'This check uses source fixtures only');
  const image = `sha256:${'a123bc45d678ef90'.repeat(4)}`;
  const report = { passed: false, samples: [], negatives: {}, mutations: [], external: [], cleanup: {} };
  const shadow = { ...structuredClone(preferences), windows: {} };
  const viewport = page.viewportSize();
  const handler = (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) {
      report.external.push(url.origin);
      return route.abort('blockedbyclient');
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.mutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    const body = {
      '/api/desktop-preferences': shadow,
      '/api/system/build': { version: 'development', commit: 'f'.repeat(40), imageDigest: image, runtipiCompatibility: '4.10.1' },
    }[url.pathname];
    return body ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.fallback();
  };
  await page.route('**/*', handler);
  try {
    for (const mode of ['light', 'dark'])
      for (const width of [320, 390])
        for (const scale of [1, 2]) {
          shadow.mode = mode;
          await dom.restoreText(page);
          await page.setViewportSize({ width, height: 800 });
          await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
          await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
          await page.locator('.desktop-search-trigger').click();
          await page.locator('.desktop-search-surface').waitFor();
          await dom.settle(page);
          await dom.scaleText(page, scale);
          const search = await placeholder(page);
          checkPlaceholder(search);
          await capture(`${mode}-${width}-text${scale}-search`, { scrollTop: false });
          if (mode === 'light' && width === 320 && scale === 1) {
            await page.locator('.desktop-search-input input').evaluate((input) => {
              input.placeholder = 'Search apps and settings';
            });
            const negative = await placeholder(page);
            assert.throws(() => checkPlaceholder(negative), /placeholder/);
            report.negatives.originalPlaceholder = negative;
            await capture('original-clipped-placeholder', { scrollTop: false });
            await page.locator('.desktop-search-input input').evaluate((input) => {
              input.placeholder = 'Search';
            });
            checkPlaceholder(await placeholder(page));
          }
          await page.keyboard.press('Escape');
          await page.locator('.desktop-search-surface').waitFor({ state: 'detached' });
          await dom.restoreText(page);
          await page.goto(`${base}/updates`, { waitUntil: 'domcontentloaded' });
          await page.locator('.desktop-update-image code').waitFor();
          await dom.settle(page);
          await dom.scaleText(page, scale);
          await revealDigest(page);
          const identity = await digest(page);
          checkDigest(identity, image);
          await capture(`${mode}-${width}-text${scale}-digest`, { scrollTop: false });
          if (mode === 'light' && width === 320 && scale === 1) {
            await page.locator('.desktop-update-image code').evaluate((code) => {
              code.style.whiteSpace = 'normal';
              code.style.overflow = 'visible';
              code.style.overflowWrap = 'anywhere';
            });
            const negative = await digest(page);
            assert.throws(() => checkDigest(negative, image), /one readable line/);
            report.negatives.originalDigestWrapping = negative;
            await capture('original-wrapped-digest', { scrollTop: false });
            await page.locator('.desktop-update-image code').evaluate((code) => {
              code.removeAttribute('style');
            });
            checkDigest(await digest(page), image);
          }
          report.samples.push({ mode, width, scale, search, digest: identity });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.external, []);
    report.passed = true;
    return report;
  } finally {
    await dom.restoreText(page);
    report.cleanup.textRestored = true;
    await page.setViewportSize(viewport);
    report.cleanup.viewportRestored = true;
    await page.unroute('**/*', handler);
    report.cleanup.routesRestored = true;
  }
};
module.exports.placeholder = placeholder;
module.exports.checkPlaceholder = checkPlaceholder;
module.exports.digest = digest;
module.exports.checkDigest = checkDigest;
