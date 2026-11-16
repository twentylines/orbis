import { expect, it } from 'vitest';
import { type } from 'arktype';
import { toolbarActionIds } from '@runtipi/common/schemas/workspace-layout';
import { desktopPreferencesSchema } from './desktop-preferences.dto';
import { DEFAULT_DESKTOP_PREFERENCES } from './desktop-preferences.service';
import { mergeSettingsPreferences, splitSettingsPreferences } from '../system-backups/settings-backup-preferences';

const custom = () => ({
  ...DEFAULT_DESKTOP_PREFERENCES,
  toolbarOrder: [...toolbarActionIds].reverse(),
  workspace: {
    ...DEFAULT_DESKTOP_PREFERENCES.workspace,
    layout: {
      version: 1 as const,
      appView: 'icons' as const,
      widgets: { activity: { columns: 3 as const, height: 480 }, 'future-widget': { columns: 2 as const, height: 320 } },
    },
  },
});
it('continues accepting legacy preferences without either new optional field', () => {
  expect(desktopPreferencesSchema(DEFAULT_DESKTOP_PREFERENCES)).not.toBeInstanceOf(type.errors);
});
it('retains toolbar and versioned layout through DTO JSON parsing and section export/import', () => {
  const value = custom();
  const parsed = desktopPreferencesSchema.assert(JSON.parse(JSON.stringify(value)));
  expect(parsed).toEqual(value);
  const sections = splitSettingsPreferences(parsed);
  expect(sections.dashboard).toMatchObject({ toolbarOrder: value.toolbarOrder, workspace: value.workspace });
  const restored = mergeSettingsPreferences(DEFAULT_DESKTOP_PREFERENCES, JSON.parse(JSON.stringify(sections)));
  expect(restored).toEqual(value);
});
it('does not change dashboard layout when restoring a different section', () => {
  const value = custom();
  expect(mergeSettingsPreferences(value, { settings: { serverName: 'Other name' } })).toMatchObject({
    toolbarOrder: value.toolbarOrder,
    workspace: value.workspace,
  });
});
it('rejects unsupported layout versions instead of silently dropping account layout', () => {
  const value = custom();
  expect(desktopPreferencesSchema({ ...value, workspace: { ...value.workspace, layout: { ...value.workspace.layout, version: 2 } } })).toBeInstanceOf(
    type.errors,
  );
});
