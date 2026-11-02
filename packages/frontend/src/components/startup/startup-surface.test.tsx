import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartupSurface } from './startup-surface';
import { defaultDesktopPreferences } from '@/desktop/preferences';

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

test('setup handoff preloads wallpaper under space then exposes normal loading without a fake percentage', () => {
  const preparing = renderToStaticMarkup(
    <StartupSurface setupSpace prepareWallpaper appearance={defaultDesktopPreferences} label="Preparing Orbis" />,
  );
  expect(preparing).toContain('desktop-wallpaper-layer');
  expect(preparing).toContain('orbis-startup-space-field');
  const handoff = renderToStaticMarkup(<StartupSurface prepareWallpaper setupHandoff appearance={defaultDesktopPreferences} />);
  expect(handoff).toContain('data-setup-handoff="true"');
  expect(handoff).toContain('desktop-wallpaper-layer');
  expect(handoff).toContain('orbis-startup-space-field');
  expect(handoff).toContain('orbis-startup-brand');
  expect(handoff).not.toContain('aria-valuenow="100"');
});
