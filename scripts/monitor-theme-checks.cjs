const assert = require('node:assert/strict');

module.exports = async function inspectMonitorThemes({ page, base, capture }) {
  const origin = new URL(base);
  assert.ok(
    ['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8080',
    'Monitor palette checks require isolated static8080 fixtures',
  );
  const width = page.viewportSize().width;
  const textScale = width === 320 ? 2 : 1;
  const presets = width === 320 ? ['frost', 'ocean', 'blush'] : ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'];
  const report = {
    width,
    textScale,
    source: 'Static preview HTML/assets, development telemetry fixtures and browser-local appearance responses',
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
  const settle = async () => {
    await page.locator('.desktop-route-window').evaluate(async (frame) => {
      const animations = [...frame.getAnimations(), ...frame.querySelector('.desktop-host-machine').getAnimations()];
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    });
    await page.waitForTimeout(300);
  };
  const measure = () =>
    page.locator('.desktop-host-overview').evaluate((hero) => {
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const rgba = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const color = (element, property) => rgba(getComputedStyle(element)[property]);
      const token = (name) => {
        const probe = document.createElement('span');
        probe.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`;
        hero.append(probe);
        const result = rgba(getComputedStyle(probe).color);
        probe.remove();
        return result;
      };
      const luminance = (channels) => {
        const linear = channels.slice(0, 3).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const background = getComputedStyle(hero).backgroundImage;
      const colors = [...background.matchAll(/(?:rgba?\([^)]*\)|color\([^)]*\)|#[a-f\d]{3,8})/gi)].map((match) => rgba(match[0]));
      const over = (foreground, behind) => {
        const alpha = foreground[3] / 255;
        const behindAlpha = behind[3] / 255;
        const combined = alpha + behindAlpha * (1 - alpha);
        return [
          ...foreground.slice(0, 3).map((value, index) => (value * alpha + behind[index] * behindAlpha * (1 - alpha)) / combined),
          combined * 255,
        ];
      };
      const parentLayers = [];
      for (let ancestor = hero.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        parentLayers.push({ color: rgba(style.backgroundColor), image: style.backgroundImage });
      }
      const backdrop = (imageBound) => {
        let result = [255, 255, 255, 255];
        for (const layer of parentLayers.toReversed()) {
          result = over(layer.color, result);
          if (layer.image !== 'none' && imageBound !== undefined) result = [imageBound, imageBound, imageBound, 255];
        }
        return result;
      };
      const paintedColors = colors.map((value) => over(value, backdrop()));
      const muted = token('--host-muted');
      const contrast = (backgroundColor) => {
        const textLuminance = luminance(over(muted, backgroundColor));
        const backgroundLuminance = luminance(backgroundColor);
        return (Math.max(textLuminance, backgroundLuminance) + 0.05) / (Math.min(textLuminance, backgroundLuminance) + 0.05);
      };
      const nominalContrast = paintedColors.map(contrast);
      // Black/white bounds also cover the wallpaper behind translucent themed surfaces.
      const boundedContrast = [0, 255].flatMap((bound) => colors.map((value) => contrast(over(value, backdrop(bound)))));
      const frame = hero.closest('.desktop-route-window');
      const header = frame.querySelector('.desktop-window-bar');
      const controls = [...header.querySelectorAll('.desktop-window-control')];
      const h2 = hero.querySelector('h2');
      const readings = hero.querySelector('.desktop-host-overview-readings');
      const visual = hero.querySelector('.desktop-host-visual');
      const faces = [...hero.querySelectorAll('.desktop-host-machine-front,.desktop-host-machine-side,.desktop-host-machine-top')];
      const envelope = faces.map(box);
      const fractured = [];
      const outside = [];
      const walker = document.createTreeWalker(hero, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim() || node.parentElement.closest('[aria-hidden="true"],svg,.visually-hidden')) continue;
        for (const match of node.textContent.matchAll(/[A-Za-z]{4,}/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
          if (new Set(rects.map((rect) => Math.round(rect.top * 10))).size > 1) fractured.push(match[0]);
          const bounds = box(hero);
          if (rects.some((rect) => rect.left < bounds.left + 8 || rect.right > bounds.right - 8)) outside.push(match[0]);
        }
      }
      const gradientLuminances = paintedColors.map(luminance);
      const headerBox = box(header);
      const icon = box(header.querySelector('.desktop-window-icon'));
      const label = box(header.querySelector('.desktop-window-label'));
      return {
        navigation: frame.dataset.windowNavigation,
        frame: {
          ...box(frame),
          scrollTop: frame.scrollTop,
          overflowY: getComputedStyle(frame).overflowY,
          transitionName: getComputedStyle(frame).viewTransitionName,
          scrollsFrame: frame.dataset.windowScrollsFrame,
        },
        content: {
          ...box(frame.querySelector('.desktop-window-content')),
          scrollTop: frame.querySelector('.desktop-window-content').scrollTop,
          transitionName: getComputedStyle(frame.querySelector('.desktop-window-content')).viewTransitionName,
        },
        header: headerBox,
        icon,
        label,
        controls: controls.map((control) => ({ ...box(control), glyph: box(control.querySelector('svg')) })),
        hero: box(hero),
        visual: box(visual),
        modelEnvelope: {
          left: Math.min(...envelope.map((rect) => rect.left)),
          right: Math.max(...envelope.map((rect) => rect.right)),
          top: Math.min(...envelope.map((rect) => rect.top)),
          bottom: Math.max(...envelope.map((rect) => rect.bottom)),
        },
        modelPalette: faces.map((face) => ({
          background: getComputedStyle(face).backgroundColor,
          image: getComputedStyle(face).backgroundImage,
          border: getComputedStyle(face).borderTopColor,
        })),
        gradient: background,
        gradientColors: colors,
        paintedColors,
        contrast: { nominal: nominalContrast, wallpaperBounds: boundedContrast, minimum: Math.min(...nominalContrast, ...boundedContrast) },
        luminance: gradientLuminances.length ? gradientLuminances.reduce((sum, value) => sum + value, 0) / gradientLuminances.length : null,
        tint: getComputedStyle(hero).getPropertyValue('--desktop-preset-tint').trim(),
        expected: { ink: token('--desktop-ink'), muted, edge: token('--desktop-edge'), line: token('--desktop-line') },
        actual: {
          title: color(h2, 'color'),
          value: color(readings.querySelector('strong'), 'color'),
          muted: color(readings.querySelector('span'), 'color'),
          heroLine: color(hero, 'borderTopColor'),
          readingsLine: color(readings, 'borderTopColor'),
        },
        fractured,
        outside,
        documentWidth: document.documentElement.scrollWidth,
        outerScroll: scrollY,
      };
    });
  const check = (metrics, initial = true) => {
    assert.ok(metrics.tint, 'Each preset must provide a mode-independent tint');
    assert.ok(metrics.gradientColors.length >= 2 && Number.isFinite(metrics.luminance), 'Theme gradient stops must resolve to colors');
    assert.deepEqual(metrics.actual.title, metrics.expected.ink, 'Hero title must use theme ink');
    assert.deepEqual(metrics.actual.value, metrics.expected.ink, 'Hero readings must use theme ink');
    assert.deepEqual(metrics.actual.muted, metrics.expected.muted, 'Hero labels must use the derived theme muted ink');
    assert.deepEqual(metrics.actual.heroLine, metrics.expected.edge, 'Hero edge must use the theme edge');
    assert.deepEqual(metrics.actual.readingsLine, metrics.expected.line, 'Hero divider must use the theme line');
    assert.ok(
      metrics.contrast.minimum >= 4.5,
      `Small labels must reach4.5:1 against both composited gradient endpoints: ${metrics.contrast.minimum}`,
    );
    assert.deepEqual(metrics.fractured, [], 'Meaningful hero words must remain whole');
    assert.deepEqual(metrics.outside, [], 'Meaningful hero text must retain side room');
    assert.ok(metrics.documentWidth <= width + 1, 'Monitor must not widen the document');
    assert.equal(metrics.frame.scrollTop, 0, 'The outer frame must not programmatically scroll its header out of view');
    assert.ok(metrics.header.top >= metrics.frame.top - 0.5, 'Header must not be cropped under its frame');
    if (initial) assert.ok(Math.abs(metrics.icon.left - metrics.hero.left) <= 1, 'Header icon and system status must share the route gutter');
    assert.ok(
      Math.abs(metrics.icon.top + metrics.icon.height / 2 - metrics.label.top - metrics.label.height / 2) <= 1,
      'Header icon and label must be centered',
    );
    if (metrics.navigation === 'desktop') {
      assert.equal(metrics.frame.transitionName, 'none', 'Desktop transition snapshots must not isolate the blurred frame from the wallpaper');
      assert.equal(metrics.content.transitionName, 'orbis-section', 'Desktop section motion must belong to the scrollable content layer');
      assert.equal(metrics.frame.overflowY, 'clip', 'Ordinary desktop frames must not become programmatic scroll containers');
      assert.equal(metrics.controls.length, 4);
      for (const control of metrics.controls) {
        assert.ok(
          Math.abs(control.top + control.height / 2 - (metrics.header.top + metrics.header.height / 2)) <= 0.75,
          'Frame controls must be centered',
        );
        assert.ok(Math.abs(control.glyph.top + control.glyph.height / 2 - (control.top + control.height / 2)) <= 0.5, 'Frame glyph must be centered');
      }
    } else {
      assert.equal(metrics.frame.transitionName, 'orbis-section', 'Small page section motion must remain on the parent page');
      assert.equal(metrics.content.transitionName, 'none', 'Small page content must not create a duplicate section snapshot');
      assert.equal(metrics.controls.length, 0, 'Small Monitor pages must not show window controls');
    }
    assert.ok(
      metrics.modelEnvelope.left >= metrics.hero.left + 8 && metrics.modelEnvelope.right <= metrics.hero.right - 8,
      'Model faces must retain horizontal room',
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
          await page.goto(`${base}/monitor`, { waitUntil: 'domcontentloaded' });
          await page.locator(`.desktop[data-desktop-mode="${mode}"][data-desktop-preset="${preset}"]`).waitFor();
          await page.locator('.desktop-host-overview-readings strong').first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          await settle();
          await scaleText();
          await settle();
          const initial = await measure();
          check(initial);
          await capture?.(`${name}-monitor`, { scrollTop: false });
          let afterFocus;
          if (initial.navigation === 'desktop') {
            await page.locator('.desktop-monitor button').last().focus();
            await settle();
            afterFocus = await measure();
            check(afterFocus, false);
            assert.ok(afterFocus.content.scrollTop > 0, 'Deep control focus must scroll only the tool content');
            await capture?.(`${name}-deep-focus`, { scrollTop: false });
          }
          let controlledFallback;
          if (initial.navigation === 'desktop' && preset === 'frost' && mode === 'light') {
            const frame = page.locator('.desktop-route-window');
            await frame.evaluate((element) => {
              element.querySelector('.desktop-window-bar').style.minHeight = `${element.clientHeight - 100}px`;
            });
            try {
              await page.waitForFunction(() => document.querySelector('.desktop-route-window')?.dataset.windowScrollsFrame === 'true');
              await page.locator('.desktop-window-control').first().focus();
              await page.locator('.desktop-monitor button').last().focus();
              await settle();
              const focused = await measure();
              const control = await page.locator('.desktop-monitor button').last().boundingBox();
              assert.equal(focused.frame.overflowY, 'auto', 'Controlled tall-header fallback must retain real frame scrolling');
              assert.ok(focused.frame.scrollTop > 0, 'Fallback must actually scroll to the last control');
              assert.ok(
                control.y >= focused.frame.top && control.y + control.height <= focused.frame.bottom,
                'Last control must remain reachable in fallback',
              );
              controlledFallback = { source: 'Browser-only temporary tall-header min-height; restored after probe', focused, control };
              await capture?.(`${name}-controlled-tall-header-fallback`, { scrollTop: false });
            } finally {
              await frame.evaluate((element) => {
                element.querySelector('.desktop-window-bar').style.minHeight = '';
              });
            }
            await page.waitForFunction(() => document.querySelector('.desktop-route-window')?.dataset.windowScrollsFrame === 'false');
            await settle();
            controlledFallback.restored = await measure();
            check(controlledFallback.restored, false);
          }
          report.samples.push({ preset, mode, textScale, initial, afterFocus, controlledFallback });
        } catch (error) {
          await capture?.(`${name}-monitor-failure`, { scrollTop: false }).catch(() => undefined);
          throw error;
        }
      }
    for (const preset of presets) {
      const light = report.samples.find((sample) => sample.preset === preset && sample.mode === 'light').initial;
      const dark = report.samples.find((sample) => sample.preset === preset && sample.mode === 'dark').initial;
      assert.equal(light.tint, dark.tint, 'Preset tint must survive mode changes');
      assert.ok(light.luminance > dark.luminance + 0.25, 'Dark mode must materially darken the system status background');
    }
    for (const mode of ['light', 'dark']) {
      const samples = report.samples.filter((sample) => sample.mode === mode);
      assert.equal(
        new Set(samples.map((sample) => sample.initial.gradient)).size,
        presets.length,
        'Every preset must produce its own status gradient',
      );
      assert.equal(
        new Set(samples.map((sample) => JSON.stringify(sample.initial.modelPalette))).size,
        presets.length,
        'Model palette must follow the active preset',
      );
    }
    assert.deepEqual(report.blockedWrites, [], 'Monitor palette inspection must not mutate apps or hosts');
    return report;
  } finally {
    await page.unroute('**/api/**', handler);
  }
};
