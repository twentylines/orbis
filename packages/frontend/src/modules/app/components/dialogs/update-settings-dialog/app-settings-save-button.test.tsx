import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppSettingsSaveButton } from './app-settings-save-button';

test('the actual header Save is a native submit associated with its own form, without a synthetic click handler', () => {
  const html = renderToStaticMarkup(<AppSettingsSaveButton formId="settings-first" pending={false} header />);
  expect(html).toContain('type="submit"');
  expect(html).toContain('form="settings-first"');
  expect(html).toContain('app-window-header-save');
  expect(html).toContain('>Save</button>');
  expect(html).not.toContain('disabled=""');
  expect(renderToStaticMarkup(<AppSettingsSaveButton formId="settings-second" pending={false} header />)).not.toContain('form="settings-first"');
});

test('pending submission disables the same button and exposes busy state while preserving the generic visible label', () => {
  const html = renderToStaticMarkup(<AppSettingsSaveButton formId="settings-first" pending header />);
  expect(html).toContain('disabled=""');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('form="settings-first"');
  expect(html).toContain('>Save</button>');
});
