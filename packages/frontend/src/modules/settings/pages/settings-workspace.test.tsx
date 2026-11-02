import { expect, test } from 'bun:test';
import { Children, isValidElement, useContext, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DialogContent, DialogVisibilityContext } from '@/components/ui/Dialog/Dialog';
import { WindowVisibilityContext } from '@/desktop/window-visibility';
import { ColourModeChoice } from '@/desktop/colour-mode-choice';
import { SettingsPanel, SettingsSearch, SettingsWorkspace } from './settings-workspace';
import { SettingsSaveProvider, SettingsSavingIndicator, settingsHeaderActionPortal } from './settings-save';
import { settingsCatalogue, settingsSections, type SettingsSection } from '../helpers/settings-catalogue';

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

test('Time Machine retains one category heading and its own settings panel', () => {
  const panels = Object.fromEntries(settingsSections.map(({ id }) => [id, <div key={id}>{id} content</div>])) as Record<
    SettingsSection,
    React.ReactNode
  >;
  const markup = renderToStaticMarkup(
    <SettingsWorkspace current="time-machine" access={{ operator: true }} onSection={() => {}} onSetting={() => {}} panels={panels} />,
  );
  expect(markup.match(/<h2>Time Machine<\/h2>/g)).toHaveLength(1);
  expect(markup).toContain('time-machine content');
  expect(markup).not.toContain('backups content');
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

test('settings search renders as a header control while section Save stays in its content heading', () => {
  const panels = Object.fromEntries(settingsSections.map(({ id }) => [id, <input key={id} aria-label={`Draft ${id}`} />])) as Record<
    SettingsSection,
    React.ReactNode
  >;
  const search = renderToStaticMarkup(<SettingsSearch access={{ operator: true }} onSetting={() => {}} />);
  const markup = renderToStaticMarkup(
    <SettingsSaveProvider onSection={() => {}}>
      <SettingsWorkspace current="general" access={{ operator: true }} onSection={() => {}} onSetting={() => {}} panels={panels} />
    </SettingsSaveProvider>,
  );
  expect(search.match(/type="search"/g)).toHaveLength(1);
  expect(search).toContain('class="settings-search settings-header-search"');
  expect(search).toContain('placeholder="Find a setting"');
  expect(search).toContain('data-focus-surface="parent"');
  expect(markup).not.toContain('class="settings-search settings-header-search"');
  expect(markup.match(/>Save<\/button>/g)).toHaveLength(1);
  const sectionHeader = markup.match(/<header class="settings-content-heading">[\s\S]*?<\/header>/)?.[0] ?? '';
  expect(sectionHeader).toContain('<h2>General</h2>');
  expect(sectionHeader).toContain('>Save</button>');
  expect(sectionHeader).toContain('settings-save-actions');
  expect(sectionHeader.indexOf('settings-save-secondary-actions')).toBeLessThan(sectionHeader.indexOf('>Save</button>'));
  expect(markup).not.toContain('<h1');
  expect(markup).not.toContain('settings-header-status');
});

test('a secondary header action follows the active section slot and disappears while hidden or unmounted', () => {
  const backupTarget = { nodeType: 1, ownerDocument: {} } as unknown as HTMLElement;
  const otherTarget = { nodeType: 1, ownerDocument: {} } as unknown as HTMLElement;
  const action = <button type="button">Refresh</button>;
  const active = settingsHeaderActionPortal(action, backupTarget, true);
  expect(active && Reflect.get(active, 'containerInfo')).toBe(backupTarget);
  expect(active && Reflect.get(active, 'children')).toBe(action);

  expect(settingsHeaderActionPortal(action, backupTarget, false)).toBeNull();
  expect(Reflect.get(settingsHeaderActionPortal(action, otherTarget, true) as object, 'containerInfo')).toBe(otherTarget);
  expect(Reflect.get(settingsHeaderActionPortal(action, backupTarget, true) as object, 'containerInfo')).toBe(backupTarget);
  expect(settingsHeaderActionPortal(action, null, true)).toBeNull();
});

test('OLED search target resolves to the separate switch control', () => {
  const entry = settingsCatalogue.find((item) => item.id === 'oled-dark-mode');
  expect(entry?.focus).toBe('[data-setting-focus="oled"]');
  const controls = (function flatten(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    return Children.toArray(node).flatMap((child) =>
      isValidElement<Record<string, unknown>>(child) ? [child, ...flatten(child.props.children as ReactNode)] : [],
    );
  })(
    ColourModeChoice({
      mode: 'system',
      oledDark: false,
      onChange: () => undefined,
    }),
  );
  expect(controls.some((control) => control.props['data-setting-focus'] === 'oled')).toBe(true);
});

test('React-mounted handlers query through the portal target, clear and blur, and run the shared Save plan', async () => {
  const child = Bun.spawn([process.execPath, new URL('./settings-workspace-interaction.fixture.tsx', import.meta.url).pathname], {
    cwd: new URL('../../../../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({
    mountedReact: true,
    portalTarget: true,
    network: false,
    layout: false,
    eventsSeen: ['prepare', 'commit'],
    headerActionMoves: ['header', 'hidden', 'restored', 'removed'],
  });
});

test('save activity retains its reserved content while the polite announcement follows actual pending state', () => {
  const idle = renderToStaticMarkup(<SettingsSavingIndicator pending={false} />);
  const pending = renderToStaticMarkup(<SettingsSavingIndicator pending />);
  expect(idle).toContain('data-saving="false" aria-hidden="true">Saving changes…');
  expect(pending).toContain('data-saving="true" aria-hidden="true">Saving changes…');
  expect(idle).toContain('class="visually-hidden"></span>');
  expect(pending).toContain('class="visually-hidden">Saving changes…</span>');
  expect(idle).toContain('aria-live="polite"');
  expect(pending).toContain('aria-live="polite"');
});
