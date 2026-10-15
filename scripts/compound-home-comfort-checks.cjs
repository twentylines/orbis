const assert = require('node:assert/strict');

const preferenceKey = 'server-desktop-preferences-v1';
const serverNames = ['Hades', 'Hades Media and Automation Server', 'DocumentationArchivePrimaryStorageNode'];
const serverAddress = '2001:db8:1234:5678:90ab:cdef:1234:5678';
const linkFixtures = [
  { id: 1, title: 'Documentation hub', url: 'https://example.test/recovery' },
  { id: 2, title: 'Service availability', url: 'https://example.test/status' },
  { id: 3, title: 'Backup verification', url: 'https://example.test/backups' },
];

// GET overlays keep the compound cases isolated from the real server and account.
module.exports = async function inspectCompoundHomeComfort({ page, base, capture, fixtures, textScale = 2, modes = ['light', 'dark'] }) {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8080', 'Compound Home checks require static loopback fixtures');
  assert.ok([1, 2].includes(textScale));
  assert.ok(fixtures?.preferences && fixtures.apps?.length >= 3 && fixtures.tasks?.tasks?.length >= 2 && fixtures.containers?.containers?.length);

  const originalUrl = page.url();
  const originalCache = originalUrl.startsWith(origin.origin) ? await page.evaluate((key) => localStorage.getItem(key), preferenceKey) : null;
  const apps = structuredClone(fixtures.apps);
  apps[1].info.name = 'Audiobookshelf';
  apps[2].info.name = 'Nextcloud collaborative workspace and private file storage';
  if (apps.length < 4) {
    apps.push({
      ...structuredClone(apps[0]),
      info: { ...apps[0].info, urn: 'compound:test', name: 'Jellyfin Media Library and Transcoding Server' },
      app: { ...apps[0].app, id: 104 },
    });
  }
  const tasks = structuredClone(fixtures.tasks);
  tasks.tasks[0] = { ...tasks.tasks[0], appUrn: apps[1].info.urn, action: 'backup', status: 'running' };
  tasks.tasks[1] = { ...tasks.tasks[1], appUrn: apps[2].info.urn, action: 'start', status: 'failed' };
  const containers = structuredClone(fixtures.containers);
  containers.containers[0] = {
    ...containers.containers[0],
    appUrn: apps[1].info.urn,
    name: 'audiobookshelf-private-media-library',
    state: 'running',
  };
  let preferences = structuredClone(fixtures.preferences);
  const report = { textScale, viewport: page.viewportSize(), samples: [], blockedMutations: [], mockedPreferenceWrites: 0 };
  const overlays = new Map([
    ['/api/apps/installed', () => ({ installed: apps })],
    ['/api/tasks', () => tasks],
    ['/api/system/containers', () => containers],
    ['/api/links', () => ({ links: linkFixtures })],
    ['/api/desktop-preferences', () => preferences],
    [
      '/api/app-context',
      () => ({
        version: { current: '4.10.1', latest: '4.10.1', body: '', releases: [] },
        userSettings: {
          allowAutoThemes: false,
          localDomain: 'local.test',
          sslPort: 443,
          maxBackups: 5,
          guestDashboard: false,
          internalIp: serverAddress,
        },
        user: { id: 1, username: 'fixture', totpEnabled: false, locale: 'en', operator: true, hasSeenWelcome: true },
        apps: [],
        updatesAvailable: 0,
      }),
    ],
  ]);
  const guard = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path === '/api/desktop-preferences') {
      report.mockedPreferenceWrites++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(preferences) });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      report.blockedMutations.push({ path, method: request.method() });
      return route.abort('blockedbyclient');
    }
    const data = overlays.get(path);
    if (data) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data()) });
    return route.fallback();
  };
  await page.route('**/api/**', guard);
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = 0;
      onopen = null;
      onmessage = null;
      onerror = null;
      constructor(url) {
        super();
        this.url = new URL(url, location.origin).href;
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
    window.EventSource = FixtureEventSource;
  });

  const scale = () =>
    page.evaluate((factor) => {
      const baseline = [...document.querySelectorAll('body,body *')]
        .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName))
        .map((element) => {
          const style = getComputedStyle(element);
          return { element, font: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight) };
        });
      for (const { element, font, line } of baseline) {
        if (!Number.isFinite(font)) continue;
        element.style.setProperty('font-size', `${font * factor}px`, 'important');
        if (Number.isFinite(line)) element.style.setProperty('line-height', `${line * factor}px`, 'important');
      }
    }, textScale);

  try {
    for (const mode of modes) {
      for (const [index, serverName] of serverNames.entries()) {
        preferences = {
          ...structuredClone(fixtures.preferences),
          mode,
          serverName,
          workspace: { ...structuredClone(fixtures.preferences.workspace), pinnedApps: apps.slice(0, 4).map(({ info }) => info.urn) },
        };
        await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
        await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
        await page.getByRole('heading', { name: serverName, exact: true }).waitFor();
        await page.getByText('Backup Audiobookshelf', { exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(650);
        await page.mouse.move(0, 0);
        if (textScale === 2) await scale();
        await page.waitForTimeout(200);

        const sample = await page.evaluate(() => {
          const box = (node) => {
            const { x, y, right, bottom, width, height } = node.getBoundingClientRect();
            return { x, y, right, bottom, width, height };
          };
          const records = [];
          const selectors = ['.workspace-heading h1', '.workspace-links a', '.workspace-recent-tasks strong', '.workspace-recent-tasks b'];
          for (const selector of selectors) {
            for (const node of document.querySelectorAll(selector)) {
              const words = [];
              const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const text = walker.currentNode;
                if (text.parentElement.closest('svg,.visually-hidden,[hidden]')) continue;
                for (const match of text.textContent.matchAll(/[A-Za-z]{3,}/g)) {
                  const range = document.createRange();
                  range.setStart(text, match.index);
                  range.setEnd(text, match.index + match[0].length);
                  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
                  let clippedBy = null;
                  for (let ancestor = text.parentElement; ancestor; ancestor = ancestor.parentElement) {
                    const style = getComputedStyle(ancestor);
                    if (style.textOverflow === 'ellipsis' && style.overflowX === 'hidden' && ancestor.scrollWidth > ancestor.clientWidth + 1) {
                      clippedBy = { text: ancestor.textContent.trim(), title: ancestor.title, bounds: box(ancestor) };
                      break;
                    }
                    if (ancestor === node) break;
                  }
                  words.push({ text: match[0], lines: new Set(rects.map((rect) => Math.round(rect.y))).size, clippedBy });
                }
              }
              records.push({
                selector,
                text: node.textContent.trim(),
                box: box(node),
                font: Number.parseFloat(getComputedStyle(node).fontSize),
                words,
              });
            }
          }
          const heading = document.querySelector('.workspace-heading h1');
          const bar = document.querySelector('.desktop-system-bar');
          const brand = bar.querySelector('.desktop-brand');
          const controls = [...bar.querySelectorAll('.desktop-task-trigger,.desktop-mode-toggle,.desktop-search-trigger,.desktop-icon-button')];
          const brandPaint = [...brand.children]
            .filter((node) => node.getBoundingClientRect().width > 0)
            .map((node) => {
              const style = getComputedStyle(node);
              const range = document.createRange();
              range.selectNodeContents(node);
              const clipped = style.overflow === 'hidden' && style.textOverflow === 'ellipsis';
              return node.tagName === 'IMG' || clipped ? box(node) : box({ getBoundingClientRect: () => range.getBoundingClientRect() });
            });
          const connection = document.querySelector('.desktop-connection');
          const ipLabel = connection.querySelector('.desktop-connection-label');
          return {
            records,
            headerBar: box(bar),
            headerPaint: {
              brand: box(brand),
              parts: brandPaint,
              controls: controls.map((control) => ({ bounds: box(control), glyph: box(control.querySelector('svg')) })),
            },
            heading: {
              title: heading.title,
              accessible: heading.getAttribute('aria-label'),
              font: Number.parseFloat(getComputedStyle(heading).fontSize),
            },
            alignment: {
              brandLeft: bar.querySelector('.desktop-brand').getBoundingClientRect().left,
              headingLeft: heading.getBoundingClientRect().left,
              homeRight: document.querySelector('.workspace-heading').getBoundingClientRect().right,
              logoutRight: bar.querySelector('.desktop-icon-button').getBoundingClientRect().right,
            },
            taskLabels: [...document.querySelectorAll('.workspace-recent-tasks a')].map((link) => ({
              text: link.querySelector('strong').textContent.trim(),
              accessible: link.getAttribute('aria-label'),
              title: link.title,
              titles: [...link.querySelectorAll('[title]')].map((node) => node.title),
              status: link.querySelector('b').textContent.trim(),
              time: link.querySelector('small').textContent.trim(),
            })),
            connection: {
              text: ipLabel.textContent,
              accessible: connection.getAttribute('aria-label'),
              title: connection.title,
              bounds: box(connection),
              label: box(ipLabel),
              ellipsis: getComputedStyle(ipLabel).textOverflow,
            },
            links: [...document.querySelectorAll('.workspace-links a')].map((link) => ({
              text: link.textContent.trim(),
              title: link.title,
              accessible: link.getAttribute('aria-label'),
              box: box(link),
              icon: box(link.querySelector('svg')),
            })),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        const name = `${mode}-compound-home-${textScale}-${index}`;
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await capture?.(`${name}-heading`, { scrollTop: false });
        for (const [label, selector] of [
          ['links', '.workspace-links'],
          ['tasks', '.workspace-operations'],
        ]) {
          await page
            .locator(selector)
            .evaluate((node) => window.scrollTo({ top: scrollY + node.getBoundingClientRect().top - 150, behavior: 'instant' }));
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await capture?.(`${name}-${label}`, { scrollTop: false });
        }
        report.samples.push({ mode, serverName, ...sample });
        const otherTheme = report.samples.find((item) => item.serverName === serverName && item.mode !== mode);
        if (otherTheme) {
          assert.ok(
            Math.abs(otherTheme.headerPaint.controls[1].bounds.width - sample.headerPaint.controls[1].bounds.width) <= 1,
            'Switching Light/Dark labels must preserve the mode button width',
          );
        }
        assert.equal(sample.overflow, false, `${name}: horizontal overflow`);
        assert.ok(Math.abs(sample.alignment.brandLeft - sample.alignment.headingLeft) <= 1, 'Home heading must retain the header content column');
        assert.ok(Math.abs(sample.alignment.homeRight - sample.alignment.logoutRight) <= 1, 'Home right edge must retain the header content column');
        assert.ok(
          sample.headerPaint.parts.every((part) => part.x >= sample.headerPaint.brand.x - 1 && part.right <= sample.headerPaint.brand.right + 1),
          `Painted brand text must stay inside its link: ${JSON.stringify(sample.headerPaint)}`,
        );
        assert.ok(
          Math.max(...sample.headerPaint.parts.map((part) => part.right)) + 4 <= sample.headerPaint.controls[0].bounds.x,
          'Painted brand text needs clearance before the first header control',
        );
        for (const control of sample.headerPaint.controls)
          assert.ok(control.glyph.width >= 18, 'Enlarged control labels must not collapse their icon');
        assert.equal(sample.connection.text, serverAddress, 'The connected footer must retain the complete address in its text');
        assert.equal(sample.connection.title, serverAddress, 'Truncated server addresses need their full hover label');
        assert.ok(sample.connection.accessible.includes(serverAddress), 'Truncated server addresses need their full accessible label');
        assert.ok(
          sample.connection.label.x >= sample.connection.bounds.x - 1 && sample.connection.label.right <= sample.connection.bounds.right + 1,
          'Long server addresses must remain inside the connection footer',
        );
        assert.ok(
          sample.connection.bounds.x >= sample.headerBar.x - 1 && sample.connection.bounds.right <= sample.headerBar.right + 1,
          'The connection footer must remain inside the system bar',
        );
        assert.equal(sample.connection.ellipsis, 'ellipsis', 'Long server addresses need explicit bounded ellipsis');
        if (index === 0) assert.ok(sample.heading.font >= 34 * textScale, 'The short default Hades heading must keep its established scale');
        else {
          assert.equal(sample.heading.title, serverName, 'Long server names need their full hover label');
          assert.equal(sample.heading.accessible, serverName, 'Long server names need their full accessible label');
        }
        for (const record of sample.records) {
          for (const word of record.words) {
            assert.ok(word.lines <= 1, `${name}: fractured ordinary word ${word.text} in ${record.text}`);
            if (word.clippedBy) {
              const identifierFallback = record.selector === '.workspace-heading h1' && index === 2;
              const taskSummary =
                record.selector === '.workspace-recent-tasks strong' && ['Audiobookshelf', apps[2].info.name].includes(word.clippedBy.text);
              assert.ok(identifierFallback || taskSummary, `${name}: ordinary words should remain visible: ${word.text}`);
              if (identifierFallback) assert.ok(sample.heading.title === serverName && sample.heading.accessible === serverName);
            }
          }
        }
        for (const [taskIndex, appName] of ['Audiobookshelf', apps[2].info.name].entries()) {
          const task = sample.taskLabels[taskIndex];
          assert.ok(task.accessible?.includes(appName), 'Task summaries must retain the full application accessible name');
          assert.ok(task.title.includes(appName) || task.titles.includes(appName), 'Task summaries must retain the full application hover label');
          assert.ok(
            task.accessible.includes(task.status) && task.accessible.includes(task.time),
            'Task accessible names must preserve status and displayed time',
          );
        }
        for (const [linkIndex, link] of sample.links.entries()) {
          assert.ok(link.icon.width >= 16, `Long link text must not collapse its arrow: ${link.text}`);
          assert.ok(link.icon.x >= link.box.x - 1 && link.icon.right <= link.box.right + 1, 'Link arrows must stay inside their link');
          assert.equal(link.title, link.text, 'Long links need their full hover label');
          assert.equal(link.accessible, link.text, 'Long links need their full accessible label');
          if (linkIndex > 0 && link.box.y > sample.links[linkIndex - 1].box.y + 1) {
            assert.ok(link.box.y - sample.links[linkIndex - 1].box.bottom >= 12, 'Multiline Home links need visible row separation');
          }
        }
      }
    }
    assert.deepEqual(report.blockedMutations, []);
    return report;
  } finally {
    await page.unroute('**/api/**', guard);
    if (!page.isClosed() && page.url().startsWith(origin.origin)) {
      await page.evaluate(({ key, value }) => (value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value)), {
        key: preferenceKey,
        value: originalCache,
      });
      if (originalUrl.startsWith(origin.origin)) await page.goto(originalUrl, { waitUntil: 'domcontentloaded' });
    }
  }
};
