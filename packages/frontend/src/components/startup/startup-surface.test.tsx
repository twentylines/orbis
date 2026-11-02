import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartupSurface } from './startup-surface';

test('setup uses the shared indeterminate progress and normal startup keeps its existing surface', () => {
  const setup = renderToStaticMarkup(<StartupSurface setupSpace label="Preparing Orbis" />);
  expect(setup).toContain('orbis-startup-setup-space');
  expect(setup).toContain('class="recovery-progress-bar"');
  expect(setup).toContain('aria-label="Preparing Orbis"');
  expect(setup).not.toContain('orbis-startup-brand');
  const ordinary = renderToStaticMarkup(<StartupSurface />);
  expect(ordinary).toContain('orbis-startup-brand');
  expect(ordinary).not.toContain('orbis-startup-space-content');
});
