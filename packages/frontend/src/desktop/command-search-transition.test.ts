import { expect, test } from 'bun:test';

test('top-bar controls stay masked during the morph and return through a blur transition', async () => {
  const css = await Bun.file(new URL('./command-search.css', import.meta.url)).text();
  const open = css.match(/:has\(\.desktop-search-trigger\[data-search-open="true"\]\) \.desktop-toolbar-content > \*\s*\{([^}]*)\}/)?.[1] ?? '';
  const resting = css.match(/\.desktop-toolbar-content > \*\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(open).toContain('visibility: hidden');
  expect(open).toContain('pointer-events: none');
  expect(open).toContain('opacity: 0');
  expect(open).toMatch(/filter:\s*blur\(\d+px\)/);
  expect(resting).toContain('opacity: 1');
  expect(resting).toContain('filter: none');
  expect(resting).toMatch(/transition:\s*opacity[^,]*,\s*filter/);
});

test('the original bounds morph retains its opening and closing durations without fading the header', async () => {
  const source = await Bun.file(new URL('./command-search.tsx', import.meta.url)).text();
  const close = source.slice(source.indexOf('  const close = useCallback('), source.indexOf('  useLayoutEffect(() => {'));
  const opening = source.slice(
    source.indexOf('  useLayoutEffect(() => {'),
    source.indexOf('  useEffect(() => {\n    window.addEventListener(commandSearchEvent'),
  );
  expect(close).toContain('duration: 360');
  expect(opening).toContain('duration: 460');
  const closeHeader = close.slice(close.indexOf('const exit = element.animate('), close.indexOf("exit.id = 'orbis-search-bar-close'"));
  const openHeader = opening.slice(opening.indexOf('const enter = element.animate('), opening.indexOf("enter.id = 'orbis-search-bar-open'"));
  expect(closeHeader).not.toContain('opacity: 0');
  expect(openHeader).not.toContain('opacity: 0');
});

test('closing does not add an opaque paint layer or compositing boundary over the opening material', async () => {
  const css = await Bun.file(new URL('./command-search.css', import.meta.url)).text();
  expect(css).not.toContain('.desktop-search-input::before');
  expect(css).not.toContain('isolation: isolate');
  expect(css).not.toContain('--desktop-chrome-opaque');
  const input = css.match(/\.desktop-search-input\s*\{([^}]*)\}/s)?.[1] ?? '';
  expect(input).toContain('background: transparent');
  expect(input).not.toMatch(/opacity:|filter:/);
});

test('closing crossfades the label while preserving the actual query and accessible name', async () => {
  const source = await Bun.file(new URL('./command-search.tsx', import.meta.url)).text();
  const css = await Bun.file(new URL('./command-search.css', import.meta.url)).text();
  expect(source).toContain('value={search}');
  expect(source).not.toContain("value={closing ? '' : search}");
  expect(source).toMatch(/className="desktop-search-closing-label" aria-hidden="true"[\s\S]*?Search/);
  expect(source).toContain('aria-label="Search Orbis"');
  expect(css).toMatch(/\.desktop-search-surface\[data-closing="true"\] \.desktop-search-closing-label\s*\{\s*opacity:\s*1;/);
  expect(css).toContain('transition: opacity 90ms ease');
  expect(css).toContain('@media (prefers-reduced-motion: reduce)');
});

test('the returning search trigger stays sharp while its sibling controls reveal through blur', async () => {
  const css = await Bun.file(new URL('./command-search.css', import.meta.url)).text();
  const trigger = css.match(/\.desktop-system-bar \.desktop-system-actions \.desktop-search-trigger,[^{]+\{([^}]+)\}/)?.[1] ?? '';
  expect(trigger).toContain('filter: none');
  expect(trigger).toContain('transition: none');
  expect(css).not.toContain('.desktop-system-bar:has(.desktop-search-trigger[data-search-open="true"]) > * {');
});
