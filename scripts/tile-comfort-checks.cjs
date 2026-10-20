const auditAssert = require('node:assert/strict');
const { browser: reading } = require('./live-compact-ui-qa.cjs');

const installedCopy = [
  { name: 'Audiobookshelf', short_desc: 'Private audiobook and podcast library with synchronised listening progress' },
  {
    name: 'Jellyfin Media Library and Transcoding Server',
    short_desc: 'Stream films, television shows and music from a private media library on your home server.',
  },
  {
    name: 'Paperless document archive and optical character recognition',
    short_desc: 'Keep scanned household documents searchable with automatic text recognition and private storage.',
  },
];
const catalogueCopy = [
  {
    name: 'Audiobookshelf',
    short_desc: 'Control household lights, sensors and automations from one dashboard without sharing your private data.',
  },
  {
    name: 'Jellyfin Media Library and Transcoding Server',
    short_desc: 'Stream your favourite films, television shows and music from a private library on your home server.',
  },
  {
    name: 'Paperless document archive and optical character recognition',
    short_desc: 'Organise household documents with private storage, automatic text recognition and useful search tools.',
  },
];

async function auditSettle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime) && a.effect.getComputedTiming().endTime <= 4000)
        .map((a) => a.finished.catch(() => undefined)),
    );
  });
  await page.waitForTimeout(250);
}
async function auditScale(page, scale) {
  if (scale === 1) return;
  await page.evaluate((scale) => {
    const baseline = [...document.querySelectorAll('body,body *')]
      .filter((e) => e instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(e.tagName))
      .map((e) => ({
        e,
        font: Number.parseFloat(getComputedStyle(e).fontSize),
        line: getComputedStyle(e).lineHeight,
        original: ['font-size', 'line-height'].map((name) => [name, e.style.getPropertyValue(name), e.style.getPropertyPriority(name)]),
      }));
    window.__orbisTileTextOriginals = baseline.map(({ e, original }) => [e, original]);
    for (const { e, font, line } of baseline) {
      if (Number.isFinite(font)) e.style.setProperty('font-size', `${font * scale}px`, 'important');
      if (line !== 'normal' && Number.isFinite(Number.parseFloat(line)))
        e.style.setProperty('line-height', `${Number.parseFloat(line) * scale}px`, 'important');
    }
  }, scale);
  await auditSettle(page);
}
async function auditMetrics(page, route) {
  return page.evaluate((route) => {
    const box = (e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const body = document.querySelector('.desktop-window-content');
    const frame = body.closest('.desktop-route-window');
    const icon = frame.querySelector('.desktop-window-icon');
    const cards = [
      ...document.querySelectorAll(route === 'apps' ? '.desktop-installed-grid .app-link .app-tile' : '.desktop-catalogue-item a.app-tile'),
    ];
    const textNodes = (e) => {
      const nodes = [];
      const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const n = w.currentNode;
        if (n.textContent.trim() && !n.parentElement.closest('svg,.visually-hidden,[aria-hidden="true"],[hidden]')) nodes.push(n);
      }
      return nodes;
    };
    const inspect = (e, container) => {
      const bounds = container.getBoundingClientRect();
      const wordIssues = [];
      const hyphenations = [];
      const clipped = [];
      const rects = [];
      const ellipses = [];
      for (const n of textNodes(e)) {
        const word = n.parentElement.closest('.orbis-whole-word');
        const name = word?.closest('.app-tile-name,.catalogue-tile-name');
        const wordStyle = word && getComputedStyle(word);
        const accessibleEllipsis =
          name &&
          name.title === name.textContent.trim() &&
          wordStyle.whiteSpace === 'nowrap' &&
          wordStyle.overflowX === 'hidden' &&
          wordStyle.textOverflow === 'ellipsis' &&
          word.scrollWidth > word.clientWidth + 1;
        if (accessibleEllipsis)
          ellipses.push({ text: word.textContent, title: name.title, box: box(word), scrollWidth: word.scrollWidth, clientWidth: word.clientWidth });
        for (const m of n.textContent.matchAll(/[A-Za-z][A-Za-z']{2,}/g)) {
          const r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          const parts = [...r.getClientRects()].filter((p) => p.width && p.height);
          if (new Set(parts.map((p) => Math.round(p.top * 10))).size > 1) {
            const fragments = [];
            for (let i = 0; i < m[0].length; i++) {
              const one = document.createRange();
              one.setStart(n, m.index + i);
              one.setEnd(n, m.index + i + 1);
              const p = [...one.getClientRects()].filter((p) => p.width && p.height).at(-1);
              if (!p) continue;
              let fragment = fragments.find((f) => Math.abs(f.top - p.top) < 1);
              if (!fragment) {
                fragment = { top: p.top, text: '', left: p.left, right: p.right };
                fragments.push(fragment);
              }
              fragment.text += m[0][i];
              fragment.left = Math.min(fragment.left, p.left);
              fragment.right = Math.max(fragment.right, p.right);
            }
            const style = getComputedStyle(n.parentElement);
            const lang = n.parentElement.closest('[lang]')?.lang;
            const info = {
              word: m[0],
              hyphens: style.hyphens,
              lang,
              fragments,
              parts: parts.map((p) => ({ left: p.left, right: p.right, top: p.top, width: p.width })),
            };
            const lines = [...new Set(parts.map((p) => Math.round(p.top * 10)))].sort((a, b) => a - b);
            const syntheticHyphens = lines.slice(0, -1).every((line) => {
              const row = parts.filter((p) => Math.round(p.top * 10) === line).sort((a, b) => a.left - b.left);
              return (
                row.length >= 2 &&
                row.at(-1).width > 1 &&
                row.at(-1).width <= Number.parseFloat(style.fontSize) * 0.6 &&
                Math.abs(row.at(-1).left - row.at(-2).right) <= 1
              );
            });
            if (
              style.hyphens === 'auto' &&
              lang &&
              fragments.every((f) => f.text.length >= 2) &&
              fragments.map((f) => f.text).join('') === m[0] &&
              syntheticHyphens
            )
              hyphenations.push(info);
            else wordIssues.push(info);
          }
          for (const ink of parts) {
            const wordBox = accessibleEllipsis && word.getBoundingClientRect();
            const p = wordBox ? { ...ink.toJSON(), left: Math.max(ink.left, wordBox.left), right: Math.min(ink.right, wordBox.right) } : ink;
            rects.push({ left: p.left, right: p.right, top: p.top, bottom: p.bottom });
            if (p.left < bounds.left + 8 - 1 || p.right > bounds.right - 8 + 1 || p.top < bounds.top - 1 || p.bottom > bounds.bottom + 1)
              clipped.push(m[0]);
            for (let ancestor = n.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor);
              const a = ancestor.getBoundingClientRect();
              if (['hidden', 'clip'].includes(style.overflowX) && (p.left < a.left - 1 || p.right > a.right + 1))
                clipped.push(`${m[0]} [ancestor clipped]`);
              if (['hidden', 'clip'].includes(style.overflowY) && (p.top < a.top - 1 || p.bottom > a.bottom + 1))
                clipped.push(`${m[0]} [ancestor clipped]`);
            }
          }
        }
      }
      return { wordIssues, hyphenations, clipped, rects, ellipses };
    };
    const result = cards.map((e) => {
      const name = e.querySelector(route === 'apps' ? '.fw-bolder' : 'h3');
      const description = e.querySelector(route === 'apps' ? '.app-tile-copy > .text-muted' : 'p.text-muted');
      const img = e.querySelector('img');
      const body = e.querySelector('.card-body');
      const ink = inspect(body, e);
      const health = e.querySelector('.docker-health');
      const healthParts = health
        ? textNodes(health).flatMap((n) => {
            const r = document.createRange();
            r.selectNodeContents(n);
            return [...r.getClientRects()].filter((p) => p.width && p.height);
          })
        : [];
      const notice = e.querySelector('.app-tile-notice');
      const healthInk = healthParts.length
        ? { top: Math.min(...healthParts.map((p) => p.top)), bottom: Math.max(...healthParts.map((p) => p.bottom)) }
        : null;
      return {
        health: healthInk ? { ink: healthInk, bottomGap: e.getBoundingClientRect().bottom - healthInk.bottom } : null,
        notice: notice ? { box: box(notice), minHeight: getComputedStyle(notice).minHeight, lineHeight: getComputedStyle(notice).lineHeight } : null,
        box: box(e),
        name: name.textContent.trim(),
        nameTitle: name.title,
        description: description.textContent.trim(),
        accessibleName: e.getAttribute('aria-label') || e.closest('a')?.getAttribute('aria-label'),
        descriptionTitle: description.title,
        descriptionOverflow: {
          scrollWidth: description.scrollWidth,
          clientWidth: description.clientWidth,
          scrollHeight: description.scrollHeight,
          clientHeight: description.clientHeight,
        },
        ink,
        img: img ? { loaded: img.complete && img.naturalWidth > 0, box: box(img) } : null,
      };
    });
    const filters = [...document.querySelectorAll('.action-bar input,.action-bar button[role="combobox"]')];
    const grid = document.querySelector(route === 'apps' ? '.desktop-installed-grid' : '.desktop-catalogue-grid');
    const allTiles =
      route === 'apps'
        ? [...grid.children].map((wrapper) => {
            const e = wrapper.querySelector('.app-tile,.card');
            return {
              box: box(e),
              wrapper: box(wrapper),
              kind: wrapper.classList.contains('button-tile') ? 'action' : e.classList.contains('app-tile') ? 'installed' : 'custom-link',
              ink: inspect(e, e),
            };
          })
        : result.map((e) => ({ box: e.box, wrapper: e.box, kind: 'catalogue', ink: e.ink }));
    const customLinks =
      route === 'apps'
        ? [...grid.querySelectorAll('[data-testid^="link-tile-"]')].map((e) => ({
            title: e.querySelector('.fw-bolder').textContent,
            description: e.querySelector('.text-muted').textContent,
          }))
        : [];
    const columns = getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      body: box(body),
      frame: { ...box(frame), navigation: frame.dataset.windowNavigation },
      icon: box(icon),
      bar: box(document.querySelector('.desktop-system-bar')),
      dock: box(document.querySelector('.desktop-dock')),
      cards: result,
      allTiles,
      customLinks,
      columns,
      filters: filters.map((e) => ({ box: box(e), text: e.getAttribute('placeholder') || e.textContent.trim(), ink: inspect(e, e) })),
      filterOuter: document.querySelector('.action-bar') ? box(document.querySelector('.action-bar')) : null,
      scroll: { document: scrollY, frame: frame.scrollTop, content: body.scrollTop },
    };
  }, route);
}
async function auditFocusFilters(page) {
  const controls = page.locator('.action-bar input,.action-bar button[role="combobox"]');
  await auditAssert.equal(await controls.count(), 3);
  await controls.first().focus();
  const states = [];
  for (let i = 0; i < 3; i++) {
    if (i) await page.keyboard.press('Tab');
    await page.waitForTimeout(220);
    const state = await page.evaluate(() => {
      const e = document.activeElement;
      const r = e.getBoundingClientRect();
      const b = document.querySelector('.desktop-system-bar').getBoundingClientRect();
      const d = document.querySelector('.desktop-dock').getBoundingClientRect();
      const s = getComputedStyle(e);
      return {
        role: e.getAttribute('role'),
        tag: e.tagName,
        inside: !!e.closest('.action-bar'),
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        barBottom: b.bottom,
        dockTop: d.top,
        outline: s.outline,
        shadow: s.boxShadow,
      };
    });
    auditAssert.ok(state.inside, 'Native Tab left expected filter sequence');
    auditAssert.ok(state.top >= state.barBottom + 3 && state.bottom <= state.dockTop - 3, 'Filter keyboard focus obscured by chrome');
    states.push(state);
  }
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(180);
  auditAssert.equal(
    await page
      .locator('.action-bar button[role="combobox"]')
      .first()
      .evaluate((e) => e === document.activeElement),
    true,
  );
  return states;
}
function assertComposition(metrics, { routeName, viewport, apps, catalogue, auditLinks }) {
  const expected = routeName === 'apps' ? apps.map((a) => a.info) : catalogue;
  auditAssert.equal(metrics.cards.length, expected.length, 'Actual fixture card count');
  for (let i = 0; i < expected.length; i++) {
    const card = metrics.cards[i];
    auditAssert.equal(card.name, expected[i].name, 'Complete fixture name must remain in DOM');
    auditAssert.equal(card.nameTitle, expected[i].name, 'App-name title must expose the complete identifier');
    auditAssert.equal(card.description, expected[i].short_desc, 'Complete fixture description must remain in DOM');
    auditAssert.deepEqual(card.ink.wordIssues, [], 'Ordinary card words fractured');
    auditAssert.deepEqual(card.ink.clipped, [], 'Card text lost comfortable8px edge clearance');
    auditAssert.ok(card.img?.loaded, 'Fixture app icon not visible');
    auditAssert.ok(card.img.box.left >= card.box.left + 8 && card.img.box.right <= card.box.right - 8, 'Icon touches card edge');
    auditAssert.ok(
      card.descriptionOverflow.scrollWidth <= card.descriptionOverflow.clientWidth + 1 &&
        card.descriptionOverflow.scrollHeight <= card.descriptionOverflow.clientHeight + 1,
      'Description is visually clipped',
    );
  }
  if (routeName === 'apps') {
    auditAssert.ok(
      metrics.cards.every((c) => c.health),
      'Installed DockerHealth ink missing',
    );
    const gaps = metrics.cards.map((c) => c.health.bottomGap);
    const sameRow = [];
    for (const c of metrics.cards) {
      let row = sameRow.find((row) => Math.abs(row[0].box.top - c.box.top) < 1);
      if (!row) {
        row = [];
        sameRow.push(row);
      }
      row.push(c);
    }
    metrics.healthBaseline = {
      bottomGapSpread: Math.max(...gaps) - Math.min(...gaps),
      rows: sameRow
        .filter((row) => row.length > 1)
        .map((row) => ({
          inkBottoms: row.map((c) => c.health.ink.bottom),
          spread: Math.max(...row.map((c) => c.health.ink.bottom)) - Math.min(...row.map((c) => c.health.ink.bottom)),
        })),
    };
    auditAssert.ok(metrics.healthBaseline.bottomGapSpread <= 1, 'DockerHealth ink must reserve equal bottom space across notice/no-notice tiles');
    auditAssert.ok(
      metrics.healthBaseline.rows.every((row) => row.spread <= 1),
      'Same-row DockerHealth ink baselines must align',
    );
  }
  auditAssert.ok(metrics.documentWidth <= viewport.width + 1, 'Document overflow');
  const left = Math.min(...metrics.cards.map((c) => c.box.left));
  const right = Math.max(...metrics.cards.map((c) => c.box.right));
  auditAssert.ok(Math.abs(left - metrics.icon.left) <= 1, 'Cards and heading icon gutter');
  const contentRight = metrics.body.right - (metrics.icon.left - metrics.body.left);
  const allRows = [];
  for (const tile of metrics.allTiles) {
    let row = allRows.find((r) => Math.abs(r[0].wrapper.top - tile.wrapper.top) < 2);
    if (!row) {
      row = [];
      allRows.push(row);
    }
    row.push(tile);
    auditAssert.ok(Math.abs(tile.box.top - tile.wrapper.top) <= 1, 'Painted card top must fill grid wrapper');
    auditAssert.ok(Math.abs(tile.box.bottom - tile.wrapper.bottom) <= 1, 'Painted card bottom must fill grid wrapper');
    auditAssert.deepEqual(tile.ink.wordIssues, [], 'All installed/action tile labels must retain whole words');
    auditAssert.deepEqual(tile.ink.clipped, [], 'All tile text requires8px edge room');
  }
  for (const row of allRows) {
    row.sort((a, b) => a.box.left - b.box.left);
    auditAssert.ok(
      Math.max(...row.map((t) => t.box.top)) - Math.min(...row.map((t) => t.box.top)) <= 1,
      'Painted cards in one row must share top edge',
    );
    auditAssert.ok(
      Math.max(...row.map((t) => t.box.bottom)) - Math.min(...row.map((t) => t.box.bottom)) <= 1,
      'Painted cards in one row must share bottom edge',
    );
    auditAssert.ok(Math.abs(row[0].box.left - metrics.icon.left) <= 1, 'Every painted row must share header left gutter');
    if (row.length === metrics.columns)
      auditAssert.ok(Math.abs(row.at(-1).box.right - contentRight) <= 1, 'Every complete painted row must share content right gutter');
    for (let i = 1; i < row.length; i++) auditAssert.ok(row[i].box.left - row[i - 1].box.right >= 11, 'Painted card gaps must retain12px');
  }
  if (routeName === 'apps') {
    auditAssert.deepEqual(
      metrics.customLinks,
      auditLinks.map((l) => ({ title: l.title, description: l.description })),
      'Custom link full copy must remain visible',
    );
    const widths = metrics.allTiles.map((t) => t.box.width);
    auditAssert.ok(Math.max(...widths) - Math.min(...widths) <= 1, 'Installed/action tile columns must have equal painted widths');
  }
  if (routeName === 'apps' && metrics.cards.every((c) => c.box.width > (contentRight - metrics.icon.left) * 0.8)) {
    for (const card of metrics.cards) {
      auditAssert.ok(Math.abs(card.box.left - metrics.icon.left) <= 1, 'Every single-column installed card must share title left gutter');
      auditAssert.ok(Math.abs(card.box.right - contentRight) <= 1, 'Every single-column installed card must share content right gutter');
    }
  }
  if (routeName === 'store') {
    auditAssert.ok(Math.abs(metrics.filters[0].box.left - left) <= 1, 'Search and card left edges');
    auditAssert.ok(Math.abs(metrics.filters.at(-1).box.right - right) <= 1, 'Category and card right edges');
    for (const f of metrics.filters) {
      auditAssert.deepEqual(f.ink.wordIssues, [], 'Filter ordinary words fractured');
    }
  }
}

module.exports = async function inspectTileComfort({
  page,
  base,
  fixtures,
  capture,
  modes = ['light', 'dark'],
  textScales = [1, 2],
  routes = ['apps', 'store'],
}) {
  const origin = new URL(base);
  auditAssert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '8080',
    'Tile comfort requires isolated static8080 fixtures',
  );
  auditAssert.equal(typeof capture, 'function', 'Tile comfort requires a screenshot callback');
  auditAssert.ok(
    fixtures?.apps?.length >= 3 && fixtures?.catalogue?.length >= 3 && fixtures.preferences,
    'Supply existing app, catalogue and preference fixtures',
  );
  for (const [selected, allowed] of [
    [modes, ['light', 'dark']],
    [textScales, [1, 2]],
    [routes, ['apps', 'store']],
  ])
    auditAssert.ok(
      selected.length && new Set(selected).size === selected.length && selected.every((value) => allowed.includes(value)),
      'Unsupported or duplicate tile audit parameter',
    );
  const viewport = page.viewportSize();
  const apps = structuredClone(fixtures.apps.slice(0, 3));
  apps.forEach((item, index) => {
    Object.assign(item.info, installedCopy[index]);
  });
  const catalogue = structuredClone(fixtures.catalogue.slice(0, 3));
  catalogue.forEach((item, index) => {
    Object.assign(item, catalogueCopy[index]);
  });
  const auditLinks = [
    {
      id: 1,
      title: 'Home automation documentation and maintenance handbook',
      description:
        'Read detailed instructions for service maintenance, household devices and account recovery before changing the server configuration.',
      url: 'https://example.invalid/household-handbook',
      iconUrl: `${origin.origin}/api/marketplace/apps/${encodeURIComponent(apps[0].info.urn)}/image`,
    },
  ];
  const report = {
    viewport,
    scope: 'Isolated compiled-source app/link/catalogue fixtures; browser-only preferences; other GETs fall back to the existing visual harness',
    compositions: [],
    mutations: [],
    preferencePuts: 0,
    browserErrors: [],
    negativeControls: [],
  };
  const storageKey = 'server-desktop-preferences-v1';
  const originalStorage = await page.evaluate((key) => localStorage.getItem(key), storageKey);
  let preferences = structuredClone(fixtures.preferences);
  const onError = (error) => report.browserErrors.push(error.message);
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) return route.abort('blockedbyclient');
    const respond = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/desktop-preferences') {
      if (request.method() === 'GET') return respond(preferences);
      if (request.method() === 'PUT') {
        report.preferencePuts++;
        return respond(preferences);
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      report.mutations.push({ path: url.pathname, method: request.method() });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/apps/installed') return respond({ installed: apps });
    if (url.pathname === '/api/links') return respond({ links: auditLinks });
    if (url.pathname === '/api/marketplace/enabled')
      return respond({
        appStores: [
          { id: 1, slug: 'official', name: 'Official community app store', enabled: true },
          { id: 2, slug: 'test', name: 'Homelab maintained applications', enabled: true },
        ],
      });
    if (url.pathname === '/api/marketplace/apps/search') {
      const query = (url.searchParams.get('search') || '').toLowerCase();
      return respond({
        data: catalogue.filter((app) => `${app.name} ${app.short_desc}`.toLowerCase().includes(query)).map((app) => ({ ...app, available: true })),
        nextCursor: null,
      });
    }
    return route.fallback();
  };
  page.on('pageerror', onError);
  await page.route('**/api/**', handler);
  try {
    for (const mode of modes)
      for (const scale of textScales)
        for (const routeName of routes) {
          const tag = `tiles-${mode}-text${scale}-${routeName}`;
          report.current = tag;
          preferences = { ...structuredClone(fixtures.preferences), mode, windows: {} };
          await page.evaluate(({ key, preferences }) => localStorage.setItem(key, JSON.stringify(preferences)), { key: storageKey, preferences });
          try {
            await page.goto(`${base}${routeName === 'apps' ? '/apps' : '/app-store'}`, { waitUntil: 'domcontentloaded' });
            await page
              .locator(routeName === 'apps' ? '.desktop-installed-grid .app-link' : '.desktop-catalogue-item')
              .first()
              .waitFor();
            await page.waitForFunction(() =>
              [...document.querySelectorAll('.desktop-installed-grid img,.desktop-catalogue-grid img')].every(
                (image) => image.complete && image.naturalWidth > 0,
              ),
            );
            await auditSettle(page);
            await auditScale(page, scale);
            if (viewport.width === 320 && scale === 2 && routeName === 'store') {
              const words = page.locator('.catalogue-tile-name').first().locator('.orbis-whole-word');
              await words.evaluateAll((elements) => {
                for (const element of elements) element.classList.remove('orbis-whole-word');
              });
              try {
                const negative = await auditMetrics(page, routeName);
                auditAssert.ok(
                  negative.cards[0].ink.wordIssues.some((issue) => issue.word === 'Audiobookshelf'),
                  'The original Audiobookshelf word fracture must still be rejected',
                );
                await reading.wheelVisible(page, page.locator('.catalogue-tile-name').first());
                await capture(`${tag}-original-fracture-negative`, { scrollTop: false, fullPage: false });
                report.negativeControls.push({ mode, textScale: scale, route: routeName, rejected: negative.cards[0].ink.wordIssues });
              } finally {
                await page
                  .locator('.catalogue-tile-name')
                  .first()
                  .locator('span span')
                  .evaluateAll((elements) => {
                    for (const element of elements) element.classList.add('orbis-whole-word');
                  });
              }
            }
            const metrics = await auditMetrics(page, routeName);
            report.pending = { mode, textScale: scale, route: routeName, metrics };
            assertComposition(metrics, { routeName, viewport, apps, catalogue, auditLinks });
            await capture(tag, { scrollTop: false, fullPage: false });
            if (viewport.width < 1100) await capture(`${tag}-full-page`, { scrollTop: false, fullPage: true });
            const name = page.locator(routeName === 'apps' ? '.app-tile-name' : '.catalogue-tile-name').first();
            await reading.wheelVisible(page, name);
            const nameVisibility = await name.evaluate((element) => {
              const r = element.getBoundingClientRect();
              const frame = element.closest('.desktop-route-window');
              const content = frame.querySelector('.desktop-window-content');
              return {
                top: r.top,
                bottom: r.bottom,
                readingTop:
                  frame.dataset.windowNavigation === 'desktop'
                    ? content.getBoundingClientRect().top
                    : document.querySelector('.desktop-system-bar').getBoundingClientRect().bottom,
                readingBottom:
                  frame.dataset.windowNavigation === 'desktop'
                    ? content.getBoundingClientRect().bottom
                    : document.querySelector('.desktop-dock').getBoundingClientRect().top,
              };
            });
            auditAssert.ok(
              nameVisibility.top >= nameVisibility.readingTop + 8 && nameVisibility.bottom <= nameVisibility.readingBottom - 8,
              'App-name capture must show the entire name clear of navigation',
            );
            await capture(`${tag}-name-native-scroll`, { scrollTop: false, fullPage: false });
            const focus = routeName === 'store' ? await auditFocusFilters(page) : null;
            if (focus) await capture(`${tag}-filter-focus`, { scrollTop: false, fullPage: false });
            if (routeName === 'apps' && viewport.width === 320 && scale === 2) {
              await page.locator('[data-testid^="link-tile-"] .fw-bolder').scrollIntoViewIfNeeded();
              await page.waitForTimeout(400);
              await capture(`${tag}-custom-link-native-scroll`, { scrollTop: false, fullPage: false });
            }
            report.compositions.push({ mode, textScale: scale, route: routeName, metrics, nameVisibility, focus, capture: tag });
            delete report.pending;
          } catch (error) {
            await capture(`${tag}-failure`, { scrollTop: false, fullPage: viewport.width < 1100 }).catch(() => undefined);
            error.tileComfortReport = report;
            throw error;
          }
        }
    auditAssert.equal(report.compositions.length, modes.length * textScales.length * routes.length);
    auditAssert.deepEqual(report.mutations, [], 'Tile inspection must not send app/account/host mutations');
    auditAssert.deepEqual(report.browserErrors, [], 'Tile inspection must not have browser errors');
    report.passed = true;
    return report;
  } finally {
    page.off('pageerror', onError);
    await page.unroute('**/api/**', handler);
    if (!page.isClosed())
      await page.evaluate(
        ({ key, original }) => {
          for (const [element, properties] of window.__orbisTileTextOriginals || []) {
            if (!element.isConnected) continue;
            for (const [name, value, priority] of properties) {
              if (value) element.style.setProperty(name, value, priority);
              else element.style.removeProperty(name);
            }
          }
          delete window.__orbisTileTextOriginals;
          if (original === null) localStorage.removeItem(key);
          else localStorage.setItem(key, original);
        },
        { key: storageKey, original: originalStorage },
      );
  }
};
