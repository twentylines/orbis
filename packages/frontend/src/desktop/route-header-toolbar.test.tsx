import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouteHeaderToolbar, RouteHeaderToolbarContext } from './route-header-toolbar';
import { RouteHeaderStatus } from './route-header-status';
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
      <RouteHeaderStatus>
        <SettingsDirtyIndicator dirty />
      </RouteHeaderStatus>,
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

test('the header status announces changes without an idle spinner and reserves space when clean', () => {
  const clean = renderToStaticMarkup(<SettingsDirtyIndicator dirty={false} />);
  const dirty = renderToStaticMarkup(<SettingsDirtyIndicator dirty />);
  const pending = renderToStaticMarkup(<SettingsDirtyIndicator dirty={false} pending />);
  for (const [markup, announcement] of [
    [clean, ''],
    [dirty, 'Unsaved changes'],
    [pending, 'Saving…'],
  ] as const) {
    expect(markup).toContain('<output class="settings-system-status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain(`<span class="visually-hidden">${announcement}</span>`);
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<input');
    expect(markup).toContain('class="settings-status-reserve" aria-hidden="true">Unsaved changes</span>');
  }
  expect(clean).not.toContain('settings-system-status-bubble');
  expect(dirty).toContain('class="settings-system-status-bubble"');
  expect(pending).toContain('class="settings-system-status-bubble"');
  expect(dirty).toContain('Unsaved changes');
  expect(dirty).not.toContain('<svg');
  expect(pending).toContain('Saving…');
  expect(pending).toContain('settings-status-spinner');
});
