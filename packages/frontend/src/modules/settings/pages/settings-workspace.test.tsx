import { expect, test } from 'bun:test';
import { useContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DialogContent, DialogVisibilityContext } from '@/components/ui/Dialog/Dialog';
import { WindowVisibilityContext } from '@/desktop/window-visibility';
import { SettingsPanel, SettingsWorkspace } from './settings-workspace';
import { SettingsSaveProvider } from './settings-save';
import { settingsSections, type SettingsSection } from '../helpers/settings-catalogue';

function VisibilityProbe() {
  const visible = useContext(WindowVisibilityContext);
  return <input aria-label="Draft" defaultValue="Retained draft" data-visible={visible} />;
}
test('retained inactive content remains mounted but hidden with server observation suspended', () => {
  const inactive = renderToStaticMarkup(
    <SettingsPanel active={false} id="retained" label="General">
      <VisibilityProbe />
    </SettingsPanel>,
  );
  expect(inactive).toContain('hidden=""');
  expect(inactive).toContain('value="Retained draft"');
  expect(inactive).toContain('data-visible="false"');
  const active = renderToStaticMarkup(
    <SettingsPanel active id="retained" label="General">
      <VisibilityProbe />
    </SettingsPanel>,
  );
  expect(active).not.toContain('hidden=""');
  expect(active).toContain('data-visible="true"');
});
test('an inactive parent window cannot be made visible by a settings category', () => {
  const markup = renderToStaticMarkup(
    <WindowVisibilityContext.Provider value={false}>
      <SettingsPanel active id="child" label="Customise">
        <VisibilityProbe />
      </SettingsPanel>
    </WindowVisibilityContext.Provider>,
  );
  expect(markup).toContain('data-visible="false"');
});
test('categories expose a shared Orbis picker and only the visited category content initially', () => {
  const panels = Object.fromEntries(settingsSections.map(({ id }) => [id, <input key={id} aria-label={`Draft ${id}`} />])) as Record<
    SettingsSection,
    React.ReactNode
  >;
  const markup = renderToStaticMarkup(
    <SettingsWorkspace current="general" access={{ operator: true }} onSection={() => {}} onSetting={() => {}} panels={panels} />,
  );
  expect(markup).toContain('Settings categories');
  expect(markup).toContain('Backup &amp; recovery');
  expect(markup).toContain('Customisation');
  expect(markup).toContain('aria-label="Settings category"');
  expect(markup).not.toContain('<select');
  expect(markup).toContain('Draft general');
  expect(markup).not.toContain('Draft customise');
  expect(markup).not.toContain('More');
});

function DialogVisibilityProbe() {
  return <output data-dialog-visible={useContext(DialogVisibilityContext)} />;
}
test('settings opt-in visibility hides inactive dialog portals and retains surrounding controlled draft state', () => {
  const closed = renderToStaticMarkup(
    <SettingsPanel active={false} id="dialogs" label="Security">
      <VisibilityProbe />
      <DialogContent>
        <input aria-label="Private dialog draft" />
      </DialogContent>
      <DialogVisibilityProbe />
    </SettingsPanel>,
  );
  expect(closed).toContain('value="Retained draft"');
  expect(closed).toContain('data-dialog-visible="false"');
  expect(closed).not.toContain('Private dialog draft');
  const active = renderToStaticMarkup(
    <SettingsPanel active id="dialogs" label="Security">
      <DialogVisibilityProbe />
    </SettingsPanel>,
  );
  expect(active).toContain('data-dialog-visible="true"');
  const ordinary = renderToStaticMarkup(<DialogVisibilityProbe />);
  expect(ordinary).toContain('data-dialog-visible="true"');
});
test('a hidden parent settings window suppresses its active category dialog without changing the global default', () => {
  const hidden = renderToStaticMarkup(
    <WindowVisibilityContext.Provider value={false}>
      <SettingsPanel active id="nested" label="Security">
        <DialogContent>
          <input aria-label="Inactive portal" />
        </DialogContent>
        <DialogVisibilityProbe />
      </SettingsPanel>
    </WindowVisibilityContext.Provider>,
  );
  expect(hidden).toContain('data-dialog-visible="false"');
  expect(hidden).not.toContain('Inactive portal');
});

test('search and the single section Save keep their existing locations when the title status is added', () => {
  const panels = Object.fromEntries(settingsSections.map(({ id }) => [id, <input key={id} aria-label={`Draft ${id}`} />])) as Record<
    SettingsSection,
    React.ReactNode
  >;
  const markup = renderToStaticMarkup(
    <SettingsSaveProvider onSection={() => {}}>
      <SettingsWorkspace current="general" access={{ operator: true }} onSection={() => {}} onSetting={() => {}} panels={panels} />
    </SettingsSaveProvider>,
  );
  expect(markup.match(/type="search"/g)).toHaveLength(1);
  expect(markup.match(/>Save<\/button>/g)).toHaveLength(1);
  expect(markup.indexOf('<search')).toBeLessThan(markup.indexOf('class="settings-layout"'));
  const sectionHeader = markup.match(/<header class="settings-content-heading">[\s\S]*?<\/header>/)?.[0] ?? '';
  expect(sectionHeader).toContain('<h2>General</h2>');
  expect(sectionHeader).toContain('>Save</button>');
  expect(markup).not.toContain('<h1');
  expect(markup).not.toContain('settings-header-status');
});
