import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { automaticUpdateSettingsOptions } from '@/desktop/automatic-updates-api';
import { AutosavedSettingSwitch } from '../components/autosaved-setting-switch';
import type { SettingToggle } from '../hooks/use-autosaved-toggle';
import { useAutomaticUpdateToggle } from '../hooks/use-update-setting-toggles';

const AppPolicyContext = createContext<SettingToggle | null>(null);

export function AppUpdatePolicyProvider({ children }: { children: ReactNode }) {
  const visible = useWindowVisible();
  const { user } = useAppContext();
  const enabled = visible && user.operator;
  const status = useQuery({ ...automaticUpdateSettingsOptions(), enabled });
  const toggle = useAutomaticUpdateToggle('apps', status.data, enabled, status.isError ? 'App update settings could not be read.' : undefined);
  return <AppPolicyContext.Provider value={toggle}>{children}</AppPolicyContext.Provider>;
}

export function AutomaticAppUpdateSwitch() {
  const toggle = useContext(AppPolicyContext);
  if (!toggle) throw new Error('App update controls require their settings provider.');
  return (
    <div className="automatic-app-update-switch">
      <AutosavedSettingSwitch label="Update apps automatically" toggle={toggle} />
    </div>
  );
}
