import { updateUserSettings } from '@/api-client';
import { appContextQueryKey, userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { useAppContext } from '@/context/app-context';
import { useQueryClient } from '@tanstack/react-query';
import type { AppContextDto, UserContextDto } from '@/api-client';
import { useAutosavedToggle } from './use-autosaved-toggle';

const fields = {
  'guest-dashboard': 'guestDashboard',
  'advanced-settings': 'advancedSettings',
  'persist-proxy': 'persistTraefikConfig',
} as const;
type GeneralToggleId = keyof typeof fields;

function useGeneralSettingToggle(id: GeneralToggleId, enabled: boolean) {
  const app = useAppContext();
  const client = useQueryClient();
  const field = fields[id];
  const allowed = enabled && app.user.operator && (id !== 'persist-proxy' || app.userSettings.advancedSettings);
  return useAutosavedToggle({
    id,
    scope: 'general-settings',
    saved: Boolean(app.userSettings[field]),
    disabled: !allowed,
    save: async (checked, signal) => {
      await updateUserSettings({ body: { [field]: checked }, signal, throwOnError: true });
      await client.cancelQueries({ queryKey: appContextQueryKey(), exact: true });
      signal.throwIfAborted();
      client.setQueryData<AppContextDto>(appContextQueryKey(), (current) =>
        current ? { ...current, userSettings: { ...current.userSettings, [field]: checked } } : current,
      );
      if (field === 'guestDashboard') {
        await client.cancelQueries({ queryKey: userContextQueryKey(), exact: true });
        signal.throwIfAborted();
        client.setQueryData<UserContextDto>(userContextQueryKey(), (current) =>
          current ? { ...current, isGuestDashboardEnabled: checked } : current,
        );
      }
    },
  });
}

export function useGeneralSettingToggles(enabled = true) {
  return {
    'guest-dashboard': useGeneralSettingToggle('guest-dashboard', enabled),
    'advanced-settings': useGeneralSettingToggle('advanced-settings', enabled),
    'persist-proxy': useGeneralSettingToggle('persist-proxy', enabled),
  };
}
