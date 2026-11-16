import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { useDesktopPreferences } from '@/desktop/preferences';
import { Suspense, lazy, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigation, useSearchParams } from 'react-router';
import { AppStoresContainer } from '../containers/app-stores-container';
import { Appearance } from '../containers/appearance';
import { ClusterSettings } from '../containers/cluster-settings';
import { DelayedRouteLoading } from '@/desktop/route-loading';
import { useWindowVisible } from '@/desktop/window-visibility';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { SettingsWorkspace } from './settings-workspace';
import { HttpsSettings } from '../containers/https-settings';
import { httpsSetupVisible } from '@/desktop/secure-access';
import { SettingsSaveProvider } from './settings-save';
import { AppUpdatePolicyProvider } from '../containers/app-update-policy';
import {
  resolveSettingsSection,
  settingAvailable,
  settingsLocation,
  settingsCatalogue,
  type SettingEntry,
  type SettingsSection,
} from '../helpers/settings-catalogue';
import { revealSetting } from '../helpers/reveal-setting';

const TimeMachineSettings = lazy(() =>
  import('@/modules/time-machine/time-machine-settings').then((module) => ({ default: module.TimeMachineSettings })),
);
const loadUserSettings = () => import('../containers/user-settings').then((module) => ({ default: module.UserSettingsContainer }));
const UserSettingsContainer = lazy(loadUserSettings);
const SecurityContainer = lazy(() => import('../containers/security').then((module) => ({ default: module.SecurityContainer })));
const LogsContainer = lazy(() => import('../containers/logs').then((module) => ({ default: module.LogsContainer })));
const About = lazy(() => import('../containers/about').then((module) => ({ default: module.About })));

export default function SettingsPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const pendingLocation = navigation.location?.pathname === location.pathname ? navigation.location : undefined;
  const navigating = pendingLocation !== undefined;
  const viewParams = pendingLocation ? new URLSearchParams(pendingLocation.search) : searchParams;
  const viewHash = pendingLocation?.hash ?? location.hash;
  const { userSettings, user } = useAppContext();
  const { sessionAbortSignal } = useUserContext();
  const { syncState } = useDesktopPreferences();
  const visible = useWindowVisible();
  const access = {
    operator: user.operator === true,
    advanced: userSettings.advancedSettings === true,
    http: httpsSetupVisible(typeof window === 'undefined' ? '' : window.location.protocol),
  };
  const target = settingsCatalogue.find(
    (entry) => entry.id === viewParams.get('setting') || (!viewParams.has('setting') && `#${entry.anchor}` === viewHash),
  );
  const allowedTarget = target && settingAvailable(target, access) ? target : undefined;
  const requested =
    viewParams.get('secure_setup') === '1'
      ? access.http
        ? 'https'
        : 'security'
      : (allowedTarget?.section ?? resolveSettingsSection(viewParams.get('tab')));
  const current = requested === 'https' && !access.http ? 'security' : requested;
  useEffect(() => {
    if (searchParams.get('secure_setup') !== '1') return;
    const params = new URLSearchParams(searchParams);
    params.delete('secure_setup');
    params.delete('setting');
    params.set('tab', access.http ? 'https' : 'security');
    void navigate({ pathname: location.pathname, search: `?${params}`, hash: '' }, { replace: true, preventScrollReset: true });
  }, [access.http, searchParams, navigate, location.pathname]);
  const root = useRef<HTMLDivElement>(null);
  const revealGeneration = useRef(location.key);
  revealGeneration.current = location.key;
  const updateLocation = (section: SettingsSection, entry?: SettingEntry) => {
    void navigate(settingsLocation(location.pathname, location.search, section, entry), { preventScrollReset: true, flushSync: true });
  };

  useEffect(() => {
    const element = root.current;
    if (!element || !allowedTarget || !visible || navigating || revealGeneration.current !== location.key) return;
    if (revealSetting(element, allowedTarget, prefersReducedMotion())) return;
    const observer = new MutationObserver(() => {
      if (revealGeneration.current === location.key && revealSetting(element, allowedTarget, prefersReducedMotion())) observer.disconnect();
    });
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    const timeout = window.setTimeout(() => observer.disconnect(), 5000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [allowedTarget, visible, navigating, location.key]);

  const loading = (
    <div className="settings-loading">
      <DelayedRouteLoading label="Loading settings…" />
    </div>
  );
  const protect = (node: React.ReactNode) =>
    user.operator === true ? node : <p className="settings-permission">An operator manages these server settings.</p>;
  const serverPanel = (section: 'general' | 'updates' | 'backups') => (
    <Suspense fallback={loading}>
      <UserSettingsContainer initialValues={userSettings} section={section} />
    </Suspense>
  );
  return (
    <div className="desktop-settings" ref={root}>
      <SettingsSaveProvider backgroundSaving={syncState === 'saving'} signal={sessionAbortSignal} onSection={(section) => updateLocation(section)}>
        <AppUpdatePolicyProvider>
          <SettingsWorkspace
            current={current}
            access={access}
            onSection={(section) => updateLocation(section)}
            onSetting={(entry) => updateLocation(entry.section, entry)}
            panels={{
              general: serverPanel('general'),
              customise: <Appearance />,
              store: (
                <Suspense fallback={loading}>
                  <AppStoresContainer />
                </Suspense>
              ),
              updates: serverPanel('updates'),
              backups: serverPanel('backups'),
              'time-machine': protect(
                <Suspense fallback={loading}>
                  <TimeMachineSettings />
                </Suspense>,
              ),
              https: <HttpsSettings />,
              security: (
                <Suspense fallback={loading}>
                  <SecurityContainer totpEnabled={Boolean(user.totpEnabled)} username={user.username} />
                </Suspense>
              ),
              cluster: protect(
                <div id="setting-cluster-pairing">
                  <ClusterSettings />
                </div>,
              ),
              logs: protect(
                <div id="setting-system-logs">
                  <Suspense fallback={loading}>
                    <LogsContainer />
                  </Suspense>
                </div>,
              ),
              about: (
                <Suspense fallback={loading}>
                  <About />
                </Suspense>
              ),
            }}
          />
        </AppUpdatePolicyProvider>
      </SettingsSaveProvider>
    </div>
  );
}
