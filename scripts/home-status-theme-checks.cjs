const assert = require('node:assert/strict');

module.exports = async function inspectHomeStatusThemes({ page, base, capture }) {
  const origin = new URL(base);
  assert.ok(
    ['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8080',
    'Home status palette checks require isolated static8080 fixtures',
  );
  const width = page.viewportSize().width;
  const textScale = width === 320 ? 2 : 1;
  const presets = width === 320 ? ['frost', 'ocean', 'blush'] : ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'];
  const report = {
    width,
    textScale,
    source: 'Static preview HTML/assets, development telemetry fixtures and browser-local appearance responses',
    cardCapture: 'Native browser element screenshot of .workspace-activity; no image editing',
    samples: [],
    preferenceWrites: 0,
    blockedWrites: [],
  };
  let preferences;
  const handler = (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const respond = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/desktop-preferences') {
      if (request.method() === 'GET') return respond(preferences);
      if (request.method() === 'PUT') {
        report.preferenceWrites++;
        return respond(JSON.parse(request.postData() || '{}'));
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      report.blockedWrites.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  };
  const settle = async () => {
    await page.locator('.workspace-widget-activity').evaluate(async (widget) => {
      const finite = widget.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY);
      await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
    });
    await page.waitForTimeout(250);
  };
  const scaleText = () =>
    page.evaluate((scale) => {
      if (scale === 1) return;
      const baseline = [...document.querySelectorAll('body,body *')]
        .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'META', 'LINK'].includes(element.tagName))
        .map((element) => ({
          element,
          font: Number.parseFloat(getComputedStyle(element).fontSize),
          line: Number.parseFloat(getComputedStyle(element).lineHeight),
        }));
      for (const { element, font, line } of baseline) {
        if (Number.isFinite(font)) element.style.setProperty('font-size', `${font * scale}px`, 'important');
        if (Number.isFinite(line)) element.style.setProperty('line-height', `${line * scale}px`, 'important');
      }
    }, textScale);
  const measure = () =>
    page.locator('.workspace-activity').evaluate((card) => {
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const rgba = (value) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const color = (element, property = 'color') => rgba(getComputedStyle(element)[property]);
      const token = (name) => {
        const probe = document.createElement('span');
        probe.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`;
        card.append(probe);
        const value = color(probe);
        probe.remove();
        return value;
      };
      const gradientColors = (value) => [...value.matchAll(/(?:rgba?\([^)]*\)|color\([^)]*\)|#[a-f\d]{3,8})/gi)].map((match) => rgba(match[0]));
      const luminance = (channels) => {
        const linear = channels.slice(0, 3).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const over = (foreground, behind) => {
        const alpha = foreground[3] / 255;
        const behindAlpha = behind[3] / 255;
        const combined = alpha + behindAlpha * (1 - alpha);
        return [
          ...foreground.slice(0, 3).map((value, index) => (value * alpha + behind[index] * behindAlpha * (1 - alpha)) / combined),
          combined * 255,
        ];
      };
      const contrast = (foreground, background) => {
        const textLuminance = luminance(over(foreground, background));
        const backgroundLuminance = luminance(background);
        return (Math.max(textLuminance, backgroundLuminance) + 0.05) / (Math.min(textLuminance, backgroundLuminance) + 0.05);
      };
      const parentLayers = [];
      for (let ancestor = card.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        parentLayers.push({ color: rgba(style.backgroundColor), image: style.backgroundImage });
      }
      const backdrop = (imageBound) => {
        let value = [255, 255, 255, 255];
        for (const layer of parentLayers.toReversed()) {
          value = over(layer.color, value);
          if (layer.image !== 'none' && imageBound !== undefined) value = [imageBound, imageBound, imageBound, 255];
        }
        return value;
      };
      const style = getComputedStyle(card);
      const gradient = style.backgroundImage;
      const stops = gradientColors(gradient);
      const baseColor = rgba(style.backgroundColor);
      const painted = stops.map((stop) => over(stop, over(baseColor, backdrop())));
      const bounded = [0, 255].flatMap((bound) => stops.map((stop) => over(stop, over(baseColor, backdrop(bound)))));
      const expected = {
        ink: token('--desktop-ink'),
        muted: token('--desktop-status-muted'),
        edge: token('--desktop-edge'),
        line: token('--desktop-line'),
        accent: token('--desktop-accent'),
      };
      const before = getComputedStyle(card, '::before');
      const gridColors = [
        ...new Map(
          gradientColors(before.backgroundImage)
            .filter((value) => value[3] > 0)
            .map((value) => [JSON.stringify(value), value]),
        ).values(),
      ];
      const scanColors = gradientColors(getComputedStyle(card, '::after').backgroundImage).filter((value) => value[3] > 0);
      const decorated = [...painted, ...bounded].flatMap((background) => {
        let grid = background;
        for (const ink of gridColors) grid = over([...ink.slice(0, 3), ink[3] * Number(before.opacity)], grid);
        return [background, grid, ...scanColors.map((scan) => over(scan, grid))];
      });
      const groups = [
        { selector: '#workspace-activity-title', token: 'ink', surface: 'card' },
        { selector: '.workspace-section-heading p', token: 'muted', surface: 'card' },
        { selector: '.workspace-gauge > span:last-child', token: 'ink', surface: 'card' },
        { selector: '.workspace-dial strong', token: 'ink', surface: 'dial' },
        { selector: '.workspace-network-heading', token: 'muted', surface: 'network' },
        { selector: '.workspace-network-rate', token: 'ink', surface: 'network' },
        { selector: '.workspace-status-storage > span', token: 'ink', surface: 'card' },
        { selector: '.workspace-status-storage > strong > span', token: 'ink', surface: 'card' },
        { selector: '.workspace-status-storage > strong small', token: 'muted', surface: 'card' },
        { selector: '.workspace-status-storage > small', token: 'muted', surface: 'card' },
        { selector: '.container-resources-heading h2', token: 'ink', surface: 'card' },
        { selector: '.container-resources-sort button', token: 'ink', surface: 'sort' },
        { selector: '.container-resources-sort > span', token: 'muted', surface: 'card' },
        { selector: '.container-resource-name strong', token: 'ink', surface: 'card' },
        { selector: '.container-resource-name small', token: 'muted', surface: 'card' },
        { selector: '.container-resource-values small', token: 'muted', surface: 'card' },
        { selector: '.container-resource-values b', token: 'ink', surface: 'card' },
      ];
      const labels = groups.flatMap((group) =>
        [...card.querySelectorAll(group.selector)].map((element) => {
          let backgrounds = decorated;
          if (group.surface === 'network')
            backgrounds = decorated.map((background) => over(color(element.closest('.workspace-network'), 'backgroundColor'), background));
          if (group.surface === 'sort') backgrounds = decorated.map((background) => over(color(element, 'backgroundColor'), background));
          if (group.surface === 'dial') {
            const dial = element.closest('.workspace-dial');
            const inner = gradientColors(getComputedStyle(dial, '::before').backgroundImage);
            backgrounds = decorated.flatMap((background) => inner.map((stop) => over(stop, background)));
          }
          return {
            ...group,
            text: element.textContent.trim(),
            box: box(element),
            color: color(element),
            backgroundColors: backgrounds,
            minimumContrast: Math.min(...backgrounds.map((background) => contrast(color(element), background))),
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
          };
        }),
      );
      const fractured = [];
      const outside = [];
      const clipped = [];
      const cardBox = box(card);
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim() || node.parentElement.closest('[aria-hidden="true"],svg,.visually-hidden')) continue;
        for (const match of node.textContent.matchAll(/[A-Za-z]{4,}/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
          if (new Set(rects.map((rect) => Math.round(rect.top * 10))).size > 1) fractured.push(match[0]);
          if (rects.some((rect) => rect.left < cardBox.left + 8 || rect.right > cardBox.right - 8)) outside.push(match[0]);
          for (let ancestor = node.parentElement; ancestor && ancestor !== card; ancestor = ancestor.parentElement) {
            if (!['hidden', 'clip'].includes(getComputedStyle(ancestor).overflowX)) continue;
            const bounds = box(ancestor);
            if (rects.some((rect) => rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5)) clipped.push(match[0]);
          }
        }
      }
      return {
        card: cardBox,
        grid: box(card.closest('.workspace-grid')),
        systemBar: box(document.querySelector('.desktop-system-bar')),
        padding: { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) },
        gradient,
        baseColor,
        decoration: {
          grid: before.backgroundImage,
          opacity: before.opacity,
          scan: getComputedStyle(card, '::after').backgroundImage,
          gridColors,
          scanColors,
        },
        gradientColors: stops,
        paintedColors: painted,
        tint: style.getPropertyValue('--desktop-preset-tint').trim(),
        luminance: painted.reduce((sum, value) => sum + luminance(value), 0) / painted.length,
        contrast: {
          endpoints: [...painted, ...bounded].map((background) => contrast(expected.muted, background)),
          decoratedEndpoints: decorated.map((background) => contrast(expected.muted, background)),
          minimum: Math.min(...labels.map((label) => label.minimumContrast)),
        },
        expected,
        border: color(card, 'borderTopColor'),
        storageDivider: color(card.querySelector('.workspace-status-storage'), 'borderTopColor'),
        usageDivider: color(card.querySelector('.container-resources'), 'borderTopColor'),
        networkLine: color(card.querySelector('.workspace-network'), 'borderTopColor'),
        labels,
        containerRows: card.querySelectorAll('.container-resource-list > li').length,
        fractured,
        outside,
        clipped,
        documentWidth: document.documentElement.scrollWidth,
        outerScroll: scrollY,
      };
    });
  const check = (metrics) => {
    assert.ok(metrics.tint && metrics.gradientColors.length >= 2, 'Home status must resolve the active preset gradient');
    assert.deepEqual(metrics.border, metrics.expected.edge, 'Home status border must use the themed edge');
    for (const key of ['storageDivider', 'usageDivider', 'networkLine'])
      assert.deepEqual(metrics[key], metrics.expected.line, `${key} must use the themed line`);
    assert.equal(metrics.containerRows, 2, 'Both running fixture containers must appear in compact Usage');
    assert.ok(metrics.labels.length >= 25, 'All gauge, network, storage and Usage readings must be painted');
    for (const label of metrics.labels) {
      assert.ok(label.text && label.box.width > 0 && label.box.height > 0, `${label.selector} must remain visible`);
      assert.deepEqual(label.color, metrics.expected[label.token], `${label.selector} must use themed ${label.token}`);
      assert.ok(label.minimumContrast >= 4.5, `${label.selector} contrast must reach4.5:1: ${label.minimumContrast}`);
      assert.ok(label.scrollWidth <= label.clientWidth + 1, `${label.selector} must not clip its text horizontally`);
    }
    assert.deepEqual(metrics.fractured, [], 'Home status ordinary words must remain whole');
    assert.deepEqual(metrics.outside, [], 'Home status text must retain side room');
    assert.deepEqual(metrics.clipped, [], 'Nested status labels must not be clipped');
    assert.ok(metrics.documentWidth <= width + 1, 'Home status must not widen the document');
    assert.ok(metrics.padding.left >= 14 && metrics.padding.right >= 14, 'Home status must preserve its responsive inner padding');
    assert.ok(
      metrics.card.left >= metrics.grid.left - 0.5 && metrics.card.right <= metrics.grid.right + 0.5,
      'Status must remain aligned inside the Home grid',
    );
  };
  await page.route('**/api/**', handler);
  try {
    for (const preset of presets)
      for (const mode of ['light', 'dark']) {
        preferences = {
          serverName: 'Hades',
          preset,
          mode,
          density: 'comfortable',
          wallpaper: 'sandstone',
          windows: {},
          workspace: { order: ['applications', 'activity', 'storage', 'attention'], hidden: [], wide: ['applications'], pinnedApps: [] },
        };
        const name = `${preset}-${mode}-text${textScale * 100}`;
        try {
          await page.evaluate((value) => localStorage.setItem('server-desktop-preferences-v1', JSON.stringify(value)), preferences);
          await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
          await page.locator(`.desktop[data-desktop-mode="${mode}"][data-desktop-preset="${preset}"]`).waitFor();
          await page.waitForFunction(() => {
            const card = document.querySelector('.workspace-activity');
            return (
              card?.querySelectorAll('.container-resource-list > li').length === 2 &&
              card.querySelector('.workspace-dial strong')?.textContent.includes('%')
            );
          });
          await page.evaluate(() => document.fonts.ready);
          await settle();
          await scaleText();
          await settle();
          const initial = await measure();
          check(initial);
          await capture?.(`${name}-home-full-viewport`, { scrollTop: true });
          await capture?.(`${name}-status-card-native-clip`, { element: '.workspace-activity' });
          assert.equal(page.viewportSize().width, width, 'Native card screenshot must preserve the requested viewport');
          report.samples.push({ preset, mode, textScale, initial });
        } catch (error) {
          await capture?.(`${name}-home-status-failure`, { scrollTop: false }).catch(() => undefined);
          throw error;
        }
      }
    for (const preset of presets) {
      const light = report.samples.find((sample) => sample.preset === preset && sample.mode === 'light').initial;
      const dark = report.samples.find((sample) => sample.preset === preset && sample.mode === 'dark').initial;
      assert.equal(light.tint, dark.tint, 'Home preset tint must survive mode changes');
      assert.ok(light.luminance > dark.luminance + 0.25, 'Home status must materially brighten in light mode');
    }
    for (const mode of ['light', 'dark'])
      assert.equal(
        new Set(report.samples.filter((sample) => sample.mode === mode).map((sample) => sample.initial.gradient)).size,
        presets.length,
        'Home status gradients must follow every preset',
      );
    assert.deepEqual(report.blockedWrites, [], 'Home palette inspection must not mutate apps or hosts');
    return report;
  } finally {
    await page.unroute('**/api/**', handler);
  }
};
