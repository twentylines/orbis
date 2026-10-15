const assert = require('node:assert/strict');

const labels = [
  'Jellyfin Media Library and Transcoding Server',
  'Nextcloud Collaborative Library and Private File Synchronization',
  'Paperless Library Archive and Optical Character Recognition',
];
const descriptions = [
  'Media and entertainment · Private streaming, transcoding and collection management',
  'Collaboration and productivity · Library synchronization and shared document processing',
  'Documents and information · Searchable library archive and optical character recognition',
];
const technicalToken = 'HomeAssistantCommunityAddonsSynchronizationSupervisor';
const installed = ['media', 'dns', 'backup'].map((id, index) => ({
  info: { id, urn: `${id}:test`, name: labels[index], short_desc: descriptions[index], available: true },
  app: { id: index + 1, status: 'running', version: 1, ignoredVersion: null },
  metadata: { latestVersion: 1 },
}));
const catalogue = ['media', 'dns', 'photos'].map((id, index) => ({
  id,
  urn: `${id}:official`,
  name: `${labels[index]} Community Edition`,
  short_desc: `${descriptions[index]} for your homelab`,
  available: true,
  categories: ['utilities'],
  created_at: 0,
}));
catalogue.push({
  id: 'technical',
  urn: 'technical:official',
  name: technicalToken,
  short_desc: 'Library infrastructure · An intentionally oversized single identifier',
  available: true,
  categories: ['utilities'],
  created_at: 0,
});
const longQuery = 'linuxserver/nextcloud:2026.10.16-release-candidate.1234567890-arm64';

module.exports = async function inspectSearchComfort({ page, base, capture }) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.protocol === 'http:' && origin.port === '8080');
  const report = { source: 'isolated long-result fixtures', samples: [], keyboard: [], preferenceWritesMocked: 0, mutations: [], pageErrors: [] };
  let preferences;
  const handler = (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const respond = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (target.pathname === '/api/desktop-preferences') {
      if (request.method() === 'GET') return respond(preferences);
      if (request.method() === 'PUT') {
        preferences = JSON.parse(request.postData());
        report.preferenceWritesMocked += 1;
        return respond(preferences);
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      report.mutations.push({ method: request.method(), path: target.pathname });
      return route.abort('blockedbyclient');
    }
    if (target.pathname === '/api/apps/installed') return respond({ installed });
    if (target.pathname === '/api/marketplace/apps/search') {
      const query = (target.searchParams.get('search') || '').toLowerCase();
      const data = catalogue.filter((item) => `${item.name} ${item.short_desc}`.toLowerCase().includes(query));
      return respond({ data, total: data.length, currentPage: 1, lastPage: 1 });
    }
    return route.fallback();
  };
  const onError = (error) => report.pageErrors.push(error.message);
  page.on('pageerror', onError);
  await page.route('**/api/**', handler);
  const dialog = () => page.getByRole('dialog', { name: 'Search Orbis', exact: true });
  const scaleText = (scale) =>
    page.evaluate((value) => {
      const baseline = [...document.querySelectorAll('body,body *')]
        .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'META', 'LINK'].includes(element.tagName))
        .map((element) => ({
          element,
          font: Number.parseFloat(getComputedStyle(element).fontSize),
          line: Number.parseFloat(getComputedStyle(element).lineHeight),
        }));
      for (const { element, font, line } of baseline) {
        if (Number.isFinite(font)) element.style.setProperty('font-size', `${font * value}px`, 'important');
        if (Number.isFinite(line)) element.style.setProperty('line-height', `${line * value}px`, 'important');
      }
    }, scale);
  const inspect = (kind) =>
    dialog().evaluate(
      (root, { technicalToken, longQuery, kind }) => {
        const box = (element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const fractures = [];
        const overflow = [];
        const ellipses = [];
        for (const word of root.querySelectorAll('.orbis-whole-word')) {
          if (word.scrollWidth <= word.clientWidth + 1) continue;
          const parent = word.closest('.desktop-search-result-text');
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          const style = getComputedStyle(word);
          context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          ellipses.push({
            word: word.textContent,
            fullWidth: context.measureText(word.textContent).width,
            available: parent.clientWidth,
            legitimate: word.textContent === technicalToken && context.measureText(word.textContent).width > parent.clientWidth,
          });
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          if (!node.textContent.trim() || !parent.getBoundingClientRect().width || parent.closest('svg,.visually-hidden')) continue;
          const boundedWord = parent.closest('.orbis-whole-word');
          if (boundedWord && boundedWord.textContent === technicalToken && boundedWord.scrollWidth > boundedWord.clientWidth + 1) continue;
          const container = parent.closest('[data-search-result],.desktop-search-footer,.desktop-search-feedback,.desktop-search-group') || root;
          const boundary = box(container);
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects())
            if (rect.width && (rect.x < boundary.x - 1 || rect.right > boundary.right + 1)) overflow.push(node.textContent.trim());
          const queryStart = kind === 'no-results' ? node.textContent.indexOf(longQuery) : -1;
          for (const match of node.textContent.matchAll(/[A-Za-z]{3,}/g)) {
            if (match[0] === technicalToken || (queryStart >= 0 && match.index >= queryStart && match.index < queryStart + longQuery.length))
              continue;
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            if (new Set([...range.getClientRects()].filter((rect) => rect.width).map((rect) => Math.round(rect.y))).size > 1)
              fractures.push(match[0]);
          }
        }
        const input = root.querySelector('input');
        const inputStyle = getComputedStyle(input);
        const close = root.querySelector('.desktop-search-close');
        const header = root.querySelector('.desktop-search-input');
        const results = root.querySelector('.desktop-search-results');
        return {
          surface: box(root),
          header: box(header),
          input: box(input),
          close: box(close),
          inputLine: Number.parseFloat(inputStyle.lineHeight),
          inputPadding: Number.parseFloat(inputStyle.paddingTop) + Number.parseFloat(inputStyle.paddingBottom),
          fractures,
          overflow,
          ellipses,
          documentOverflow: document.documentElement.scrollWidth > innerWidth,
          resultsOverflow: results.scrollWidth > results.clientWidth + 1,
          results: [...root.querySelectorAll('[data-search-result]')].map((button) => ({
            label: button.querySelector('strong').title,
            button: box(button),
            copy: box(button.querySelector('.desktop-search-result-text')),
          })),
        };
      },
      { technicalToken, longQuery, kind },
    );
  try {
    for (const mode of ['light', 'dark'])
      for (const scale of [1, 2])
        for (const kind of ['empty', 'results', 'no-results']) {
          preferences = {
            serverName: 'Hades',
            preset: 'frost',
            mode,
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
          await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
          await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
          await page.getByRole('button', { name: 'Search apps and settings', exact: true }).click();
          await dialog().waitFor();
          const input = dialog().getByRole('searchbox', { name: 'Search apps and settings', exact: true });
          if (kind === 'results') {
            await input.fill('library');
            await dialog().getByRole('region', { name: 'App Store', exact: true }).getByRole('button').last().waitFor();
          } else if (kind === 'no-results') {
            await input.fill(longQuery);
            await dialog()
              .getByText(/^No matches for/)
              .waitFor();
          }
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(500);
          if (scale === 2) await scaleText(scale);
          await page.waitForTimeout(150);
          const geometry = await inspect(kind);
          assert.equal(
            await input.inputValue(),
            kind === 'results' ? 'library' : kind === 'no-results' ? longQuery : '',
            'The complete query must remain editable',
          );
          await capture?.(`${mode}-search-text-${scale}-${kind}`, { scrollTop: false });
          report.samples.push({ mode, scale, kind, ...geometry });
          assert.deepEqual(geometry.fractures, [], `${mode}/${scale}/${kind}: ordinary words must remain whole`);
          assert.deepEqual(geometry.overflow, [], `${mode}/${scale}/${kind}: visible text must stay inside its surface`);
          assert.equal(geometry.documentOverflow || geometry.resultsOverflow, false);
          assert.ok(
            geometry.ellipses.every((word) => word.legitimate),
            'Tested ordinary words must fit; only the oversized identifier may use bounded ellipsis',
          );
          assert.ok(
            geometry.input.height >= geometry.inputLine + geometry.inputPadding - 1,
            'Input height must accommodate its enlarged line and padding',
          );
          assert.ok(
            geometry.close.height >= 44 && geometry.close.width >= 44 && geometry.input.right <= geometry.close.x - 8,
            'Input and close control must retain separate comfortable targets',
          );
          assert.ok(
            Math.abs(geometry.input.y + geometry.input.height / 2 - geometry.close.y - geometry.close.height / 2) < 1,
            'Input and close control centres must align',
          );
          if (kind === 'results') {
            const expected = [...installed.map((item) => item.info), ...catalogue];
            for (const item of expected) {
              const result = dialog().getByRole('button', { name: `${item.name}, ${item.short_desc}`, exact: true });
              assert.equal(await result.count(), 1, 'Each full result name and description must remain accessible');
              assert.equal(await result.locator('strong').getAttribute('title'), item.name);
            }
            const buttons = dialog().locator('[data-search-result]');
            await input.focus();
            await input.press('ArrowDown');
            assert.equal(await buttons.first().evaluate((element) => document.activeElement === element), true);
            await page.keyboard.press('End');
            assert.equal(await buttons.last().evaluate((element) => document.activeElement === element), true);
            await page.keyboard.press('Home');
            assert.equal(await buttons.first().evaluate((element) => document.activeElement === element), true);
            await page.keyboard.press('ArrowUp');
            assert.equal(await input.evaluate((element) => document.activeElement === element), true);
            await input.press('ArrowDown');
            await page.keyboard.press('End');
            await page.keyboard.press('Enter');
            await page.waitForURL(`${base}/app-store/official/technical`);
            await dialog().waitFor({ state: 'hidden' });
            report.keyboard.push({ mode, scale, fullAccessibleNames: expected.length, firstLastHomeInput: true, enterSelection: true });
          } else {
            if (kind === 'empty') await dialog().getByRole('button', { name: 'Close search', exact: true }).click();
            else await page.keyboard.press('Escape');
            await dialog().waitFor({ state: 'hidden' });
            await page.waitForFunction(() => document.activeElement === document.querySelector('.desktop-search-trigger'));
          }
        }
    assert.deepEqual(report.mutations, []);
    assert.deepEqual(report.pageErrors, []);
    return report;
  } finally {
    page.off('pageerror', onError);
    await page.unroute('**/api/**', handler);
  }
};
