import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import {
  automaticUpdateSettingsOptions,
  hasIndependentUpdateSchedules,
  readAutomaticUpdateSettings,
  readSystemUpdateSchedule,
  saveAutomaticUpdateSettings,
  saveSystemUpdateSchedule,
  systemUpdateScheduleOptions,
  type AutomaticUpdateStatus,
  type SystemUpdateSchedule,
} from '@/desktop/automatic-updates-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAutosavedToggle } from './use-autosaved-toggle';

export const automaticSettingsScope = 'automatic-update-settings';
export const systemSettingsScope = 'system-update-settings';
const unsupported = 'Update Orbis to change automatic update settings here.';

export function useAutomaticUpdateToggle(setting: 'apps' | 'orbis', status: AutomaticUpdateStatus | undefined, enabled: boolean, readError?: string) {
  const client = useQueryClient();
  const readable = status !== undefined && hasIndependentUpdateSchedules(status);
  return useAutosavedToggle({
    id: setting === 'apps' ? 'store-app-updates' : 'automatic-updates',
    scope: automaticSettingsScope,
    saved: status?.settings[setting]?.enabled ?? false,
    disabled: !enabled || !readable,
    readError: readError ?? (status && !readable ? unsupported : undefined),
    canSet: (next) => !next || status?.available === true,
    save: async (checked, signal) => {
      const latest = await readAutomaticUpdateSettings(signal);
      if (!hasIndependentUpdateSchedules(latest)) throw new Error(unsupported);
      if (checked && !latest.available) throw new Error('Automatic updates are currently unavailable.');
      if ((latest.settings[setting]?.enabled ?? false) === checked) {
        client.setQueryData(automaticUpdateSettingsOptions().queryKey, latest);
        return;
      }
      const settings =
        setting === 'apps'
          ? { ...latest.settings, apps: { enabled: checked } }
          : { ...latest.settings, apps: undefined, orbis: { ...latest.settings.orbis, enabled: checked } };
      const saved = await saveAutomaticUpdateSettings(settings, { expectedRevision: latest.revision }, signal);
      await client.cancelQueries({ queryKey: automaticUpdateSettingsOptions().queryKey, exact: true });
      signal.throwIfAborted();
      if ((saved.settings[setting]?.enabled ?? false) !== checked) throw new Error('The server did not save the automatic update setting.');
      client.setQueryData(automaticUpdateSettingsOptions().queryKey, saved);
      void client.invalidateQueries({ queryKey: systemUpdateScheduleOptions().queryKey });
    },
  });
}

export function useSystemUpdateToggle(status: SystemUpdateSchedule | undefined, enabled: boolean, readError?: string) {
  const client = useQueryClient();
  const readable = status !== undefined && hasIndependentUpdateSchedules(status);
  return useAutosavedToggle({
    id: 'system-updates',
    scope: systemSettingsScope,
    saved: status?.settings.enabled ?? false,
    disabled: !enabled || !readable || !status.available,
    readError: readError ?? (status && !readable ? unsupported : undefined),
    canSet: (next) => !next || Boolean(status?.settings.schedule),
    save: async (checked, signal) => {
      const latest = await readSystemUpdateSchedule(signal);
      if (!hasIndependentUpdateSchedules(latest)) throw new Error(unsupported);
      if (!latest.available || (checked && !latest.settings.schedule))
        throw new Error('Save a valid system update time before enabling automatic updates.');
      if (latest.settings.enabled === checked) {
        client.setQueryData(systemUpdateScheduleOptions().queryKey, latest);
        return;
      }
      const saved = await saveSystemUpdateSchedule({ enabled: checked, expectedRevision: latest.revision }, signal);
      await client.cancelQueries({ queryKey: systemUpdateScheduleOptions().queryKey, exact: true });
      signal.throwIfAborted();
      if (saved.settings.enabled !== checked) throw new Error('The server did not save the system update setting.');
      client.setQueryData(systemUpdateScheduleOptions().queryKey, saved);
    },
  });
}

export function useUpdateSettingToggles(ids: readonly string[], enabled: boolean) {
  const { user } = useAppContext();
  const visible = useWindowVisible();
  const allowed = enabled && visible && user.operator;
  const automatic = useQuery({
    ...automaticUpdateSettingsOptions(),
    enabled: allowed && (ids.includes('store-app-updates') || ids.includes('automatic-updates')),
  });
  const system = useQuery({ ...systemUpdateScheduleOptions(), enabled: allowed && ids.includes('system-updates') });
  const automaticError = automatic.isError ? 'Automatic update settings could not be read.' : undefined;
  return {
    'store-app-updates': useAutomaticUpdateToggle('apps', automatic.data, allowed, automaticError),
    'automatic-updates': useAutomaticUpdateToggle('orbis', automatic.data, allowed, automaticError),
    'system-updates': useSystemUpdateToggle(system.data, allowed, system.isError ? 'System update settings could not be read.' : undefined),
  };
}
