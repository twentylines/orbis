import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouteHeaderToolbar, RouteHeaderToolbarContext } from './route-header-toolbar';
import { SettingsDirtyIndicator } from '@/modules/settings/pages/settings-save';

test('an optional header slot never adds status content to an unrelated or unattached page', () => {
  expect(
    renderToStaticMarkup(
      <RouteHeaderToolbar>
        <SettingsDirtyIndicator dirty />
      </RouteHeaderToolbar>,
    ),
  ).toBe('');
  expect(
    renderToStaticMarkup(
      <RouteHeaderToolbarContext.Provider value={null}>
        <RouteHeaderToolbar>
          <SettingsDirtyIndicator dirty />
        </RouteHeaderToolbar>
      </RouteHeaderToolbarContext.Provider>,
    ),
  ).toBe('');
});

test('the compact dirty indicator reserves the same visible label structure before and after editing', () => {
  const clean = renderToStaticMarkup(<SettingsDirtyIndicator dirty={false} />);
  const dirty = renderToStaticMarkup(<SettingsDirtyIndicator dirty />);
  for (const markup of [clean, dirty]) {
    expect(markup).toContain('<output class="settings-header-status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('class="settings-header-status-label"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('class="settings-header-status-full">Unsaved changes');
    expect(markup).toContain('class="settings-header-status-short">Unsaved');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<input');
  }
  expect(clean).toContain('data-dirty="false"');
  expect(clean).toContain('<span class="visually-hidden"></span>');
  expect(dirty).toContain('data-dirty="true"');
  expect(dirty).toContain('<span class="visually-hidden">Unsaved changes</span>');
});
