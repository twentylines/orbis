import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { historicalPoint } from './time-machine.test-data';
import { HistoricalHomePreview as HistoricalHome } from './historical-home-preview';
import { historicalHomeLayout, historicalHomeStyle } from './historical-home-preview';
import { bundledThemePacks } from '../../../../backend/src/modules/theme-packs/theme-pack-catalogue';
function saved() {
  const point = historicalPoint();
  if (!point.metadata?.preview.available) throw new Error('Missing saved fixture');
  return { point, preview: point.metadata.preview };
}
test('historical app ordering and minimum visible apps match Home without mutating captured metadata', () => {
  const { preview } = saved();
  preview.apps = Array.from({ length: 8 }, (_, index) => ({
    urn: `app${index}:store`,
    name: `Saved application ${index}`,
    running: index % 2 === 0,
  }));
  preview.desktop.workspace.pinnedApps = ['app5:store', 'app2:store'];
  preview.desktop.workspace.showAllApps = false;
  const before = JSON.stringify(preview);
  expect(historicalHomeLayout(preview).apps.map((app) => app.urn)).toEqual(['app5:store', 'app2:store', 'app0:store']);
  preview.desktop.workspace.showAllApps = true;
  expect(historicalHomeLayout(preview).apps).toHaveLength(8);
  preview.desktop.workspace.showAllApps = false;
  expect(JSON.stringify(preview)).toBe(before);
});
test('custom saved widget order, visibility and paired widths are retained', () => {
  const { point, preview } = saved();
  preview.desktop.workspace.order = ['storage', 'attention', 'applications', 'activity'];
  preview.desktop.workspace.hidden = ['activity'];
  expect(historicalHomeLayout(preview).rows).toEqual([['storage', 'attention'], ['applications']]);
  expect(historicalHomeLayout(preview).defaultColumns).toBe(false);
  const html = renderToStaticMarkup(<HistoricalHome point={point} />);
  expect(html.indexOf('data-saved-section="storage"')).toBeLessThan(html.indexOf('data-saved-section="applications"'));
  expect(html).not.toContain('data-saved-section="activity"');
  expect(html).toContain('Operation history was not captured');
  expect(html).toContain('Attention details were not captured');
});
test('saved default Home arrangement uses the same main stack and status column without fabricating readings', () => {
  const { point, preview } = saved();
  preview.desktop.workspace.order = ['applications', 'activity', 'storage', 'attention'];
  expect(historicalHomeLayout(preview).defaultColumns).toBe(true);
  const html = renderToStaticMarkup(<HistoricalHome point={point} />);
  expect(html).toContain('data-two-columns="true"');
  expect(html).toContain('tm-saved-main');
  expect(html).toContain('tm-saved-auxiliary');
  expect(html).toContain('Readings were not captured');
  expect(html).not.toContain('CPU');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('<a ');
});
test('captured theme palettes and appearance remain scoped and unresolved system mode remains neutral', () => {
  const { point, preview } = saved();
  const theme = bundledThemePacks[0];
  if (!theme) throw new Error('Missing theme fixture');
  preview.theme = structuredClone(theme);
  preview.theme.light.surface = '#fffef0';
  preview.desktop.appearance = {
    accent: '#a74271',
    textScale: 150,
    wallpaperFit: 'contain',
    wallpaperX: 72,
    wallpaperY: 36,
    wallpaperBlur: 4,
    wallpaperDim: 22,
  };
  expect(historicalHomeStyle(preview)).toMatchObject({
    '--tm-saved-surface': '#fffef0',
    '--tm-saved-ink': theme.light.ink,
    '--tm-saved-custom-accent': '#a74271',
    '--tm-saved-scale': 1.5,
    '--tm-saved-wallpaper-position': '72% 36%',
    '--tm-saved-wallpaper-fit': 'contain',
    '--tm-saved-wallpaper-dim': 0.22,
  });
  preview.desktop.mode = 'dark';
  expect(historicalHomeStyle(preview)).toMatchObject({ '--tm-saved-ink': theme.dark.ink, '--tm-saved-surface': theme.dark.surface });
  preview.desktop.mode = 'system';
  expect(historicalHomeStyle(preview)).not.toHaveProperty('--tm-saved-ink');
  expect(renderToStaticMarkup(<HistoricalHome point={point} />)).toContain('neutral colours');
});
test('only captured wallpaper is rendered, with explicit missing/loading/failure states and no current asset fallback', () => {
  const { point, preview } = saved();
  expect(renderToStaticMarkup(<HistoricalHome point={point} wallpaper="blob:unrelated-current" />)).not.toContain('<img');
  preview.wallpaperAsset = {
    available: true,
    identity: 'a'.repeat(64),
    cipherSha256: 'b'.repeat(64),
    bytes: 100,
    width: 10,
    height: 10,
    mime: 'image/webp',
    source: 'captured-builtin',
  };
  const html = renderToStaticMarkup(<HistoricalHome point={point} wallpaper="blob:captured-only" />);
  expect(html).toContain('src="blob:captured-only"');
  expect(html).not.toContain('/wallpapers/');
  expect(renderToStaticMarkup(<HistoricalHome point={point} assetLoading />)).toContain('Loading captured wallpaper');
  expect(renderToStaticMarkup(<HistoricalHome point={point} assetFailed />)).toContain('Captured wallpaper could not be displayed');
});
test('read-only rendering keeps long captured names and all shown apps without accessing current server state', () => {
  const { point, preview } = saved();
  preview.desktop.serverName = 'Saved server with a longer workspace name';
  preview.apps = Array.from({ length: 12 }, (_, index) => ({
    urn: `app${index}:store`,
    name: `Saved application ${index} & archive`,
    running: false,
  }));
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error('Live query forbidden');
  }) as unknown as typeof globalThis.fetch;
  try {
    const html = renderToStaticMarkup(<HistoricalHome point={point} />);
    expect(html.match(/class="tm-saved-app"/g)).toHaveLength(12);
    expect(html).toContain('Saved application 11 &amp; archive');
    expect(html).toContain(preview.desktop.serverName);
    expect(html).not.toContain('+6 saved apps');
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = fetch;
  }
});

test('one saved app uses singular copy and disclosure is an inline caption rather than another panel', () => {
  const { point } = saved();
  const html = renderToStaticMarkup(<HistoricalHome point={point} />);
  expect(html).toContain('1 app captured,');
  expect(html).not.toContain('1 apps');
  expect(html).not.toContain('captured ·');
  expect(html).toContain('<p class="tm-saved-caption">');
  expect(html).not.toContain('<footer');
  expect(html).toContain('app icons were not captured');
});
