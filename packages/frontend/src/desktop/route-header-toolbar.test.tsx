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

test('the System bar status announces saving changes only while dirty or pending', () => {
  const clean = renderToStaticMarkup(<SettingsDirtyIndicator dirty={false} />);
  const dirty = renderToStaticMarkup(<SettingsDirtyIndicator dirty />);
  const pending = renderToStaticMarkup(<SettingsDirtyIndicator dirty={false} pending />);
  for (const [markup, announcement] of [
    [clean, ''],
    [dirty, 'Unsaved changes'],
    [pending, 'Saving preferences…'],
  ] as const) {
    expect(markup).toContain('<output class="settings-system-status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain(`<span class="visually-hidden">${announcement}</span>`);
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<input');
  }
  expect(clean).not.toContain('settings-system-status-bubble');
  expect(dirty).toContain('class="settings-system-status-bubble"');
  expect(pending).toContain('class="settings-system-status-bubble"');
  expect(dirty).toContain('Unsaved changes');
  expect(pending).toContain('Saving preferences…');
});
