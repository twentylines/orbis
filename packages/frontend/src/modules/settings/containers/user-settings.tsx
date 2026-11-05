import { updateUserSettingsMutation } from '@/api-client/@tanstack/react-query.gen';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { type SettingsFormValues, UserSettingsForm } from '../components/user-settings-form/user-settings-form';
import { UpdateSchedules } from './automatic-updates-settings';
import { ReleaseChannelSettings } from './release-channel-settings';
import { SystemBackupsSettings } from '@/modules/system-backups/system-backups-settings';
import { SettingsBundleSettings } from '@/modules/system-backups/settings-bundle-settings';
import { useState } from 'react';
import { HostTransferPanel } from '@/modules/host-transfer/host-transfer-panel';

type Props = {
  initialValues?: SettingsFormValues;
  section?: 'general' | 'updates' | 'backups';
};

export const UserSettingsContainer = ({ initialValues, section = 'general' }: Props) => {
  const { t } = useTranslation();
  const { refreshAppContext, user } = useAppContext();
  const { refreshUserContext, setUserContext } = useUserContext();
  const [olderBackupsOpened, setOlderBackupsOpened] = useState(false);
  const updateSettings = useMutation({
    ...updateUserSettingsMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: (_data, variables) => {
      if (typeof variables.body.guestDashboard === 'boolean') {
        setUserContext({ isGuestDashboardEnabled: variables.body.guestDashboard });
      }
      refreshAppContext();
      refreshUserContext();
    },
  });

  const onSubmit = (values: SettingsFormValues) => updateSettings.mutateAsync({ body: { ...values } }).then(() => undefined);

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
        <details
          className="system-backups-overview"
          onToggle={(event) => {
            if (event.currentTarget.open) setOlderBackupsOpened(true);
          }}
        >
          <summary>Older full backups</summary>
          {olderBackupsOpened ? <SystemBackupsSettings allowCreate={false} /> : null}
        </details>
        <div id="setting-server-transfer">
          <HostTransferPanel contained />
        </div>
      </div>
    );
  return (
    <div className="settings-general-form">
      <UserSettingsForm initialValues={initialValues} onSubmit={onSubmit} loading={updateSettings.isPending} />
    </div>
  );
};
