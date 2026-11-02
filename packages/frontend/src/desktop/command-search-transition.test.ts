import { expect, test } from 'bun:test';

test('closing exposes the already-mounted top bar while its trigger stays hidden until the morph ends', async () => {
  const css = await Bun.file(new URL('./command-search.css', import.meta.url)).text();
  expect(css).toMatch(/\.desktop-search-trigger\[data-search-open="true"\]\s*\{\s*opacity:\s*0;/);
  expect(css).toMatch(/:has\(\.desktop-search-trigger\[data-search-open="true"\]\[data-search-closing="true"\]\) > \*\s*\{\s*visibility:\s*visible;/);
  expect(css).not.toMatch(/\.desktop-system-bar > \*\s*\{[^}]*transition:\s*opacity/s);
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

test('closing bar masks underlying controls with an opaque palette base without overriding the morph', async () => {
  const css = await Bun.file(new URL('./command-search.css', import.meta.url)).text();
  const fill = css.match(/\.desktop-search-surface\[data-closing="true"\] \.desktop-search-input::before\s*\{([^}]*)\}/s)?.[1] ?? '';
  expect(fill).toContain('inset: 0');
  expect(fill).toContain('border-radius: inherit');
  expect(fill).toContain('linear-gradient(to bottom, var(--desktop-chrome), var(--desktop-chrome)), var(--desktop-chrome-opaque)');
  expect(fill).not.toMatch(/animation:|transition:/);
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
