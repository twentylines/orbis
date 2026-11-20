import { updateUserSettings } from '@/api-client/sdk.gen';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { lazy } from 'react';
import { type SettingsFormValues, UserSettingsForm } from '../components/user-settings-form/user-settings-form';
import { UpdateSchedules } from './automatic-updates-settings';
import { ReleaseChannelSettings } from './release-channel-settings';
import { useGeneralSettingToggles } from '../hooks/use-general-setting-toggles';

const SettingsBundleSettings = lazy(() =>
  import('@/modules/system-backups/settings-bundle-settings').then((module) => ({ default: module.SettingsBundleSettings })),
);
const SystemBackupsSettings = lazy(() =>
  import('@/modules/system-backups/system-backups-settings').then((module) => ({ default: module.SystemBackupsSettings })),
);
const HostTransferPanel = lazy(() => import('@/modules/host-transfer/host-transfer-panel').then((module) => ({ default: module.HostTransferPanel })));

type Props = {
  initialValues?: SettingsFormValues;
  section?: 'general' | 'updates' | 'backups';
};

export const UserSettingsContainer = ({ initialValues, section = 'general' }: Props) => {
  const { t } = useTranslation();
  const { refreshAppContext, user } = useAppContext();
  const { refreshUserContext, sessionAbortSignal } = useUserContext();
  const toggles = useGeneralSettingToggles(section === 'general');
  const updateSettings = useMutation({
    scope: { id: 'general-settings' },
    networkMode: 'always',
    retry: false,
    mutationFn: async ({ body, signal }: { body: SettingsFormValues; signal: AbortSignal }) => {
      signal.throwIfAborted();
      await updateUserSettings({ body, signal, throwOnError: true });
      signal.throwIfAborted();
    },
    onError: (e: TranslatableError, { signal }) => {
      if (!signal.aborted) toast.error(t(e.message, e.intlParams));
    },
    onSuccess: (_, { signal }) => {
      if (signal.aborted) return;
      refreshAppContext();
      refreshUserContext();
    },
  });

  const onSubmit = (body: SettingsFormValues) => updateSettings.mutateAsync({ body, signal: sessionAbortSignal });

  if (user?.operator !== true) return <p className="settings-permission">Server settings are managed by an operator.</p>;
  if (section === 'updates')
    return (
      <div className="settings-update-groups">
        <div id="setting-release-channel">
          <ReleaseChannelSettings />
        </div>
        <UpdateSchedules />
      </div>
    );
  if (section === 'backups')
    return (
      <div id="setting-server-backups" className="settings-backup-groups">
        <SettingsBundleSettings />
        <SystemBackupsSettings allowCreate={false} downloadsOnly />
        <div id="setting-server-transfer">
          <HostTransferPanel contained />
        </div>
      </div>
    );
  return (
    <div className="settings-general-form">
      <UserSettingsForm key={user.id} initialValues={initialValues} onSubmit={onSubmit} signal={sessionAbortSignal} toggles={toggles} />
    </div>
  );
};
