import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAppContext } from '@/context/app-context';
import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { AppStoresContainer } from '../containers/app-stores-container';
import { Appearance } from '../containers/appearance';

const GeneralActionsContainer = lazy(() => import('../containers/general-actions').then((module) => ({ default: module.GeneralActionsContainer })));
const UserSettingsContainer = lazy(() => import('../containers/user-settings').then((module) => ({ default: module.UserSettingsContainer })));
const SecurityContainer = lazy(() => import('../containers/security').then((module) => ({ default: module.SecurityContainer })));
const LogsContainer = lazy(() => import('../containers/logs').then((module) => ({ default: module.LogsContainer })));

export default () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  const { userSettings, user } = useAppContext();
  const currentTab = tab && ['actions', 'appearance', 'settings', 'security', 'appstores', 'logs'].includes(tab) ? tab : 'actions';

  const handleTabChange = (newTab: string) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('tab', newTab);
        return next;
      },
      { preventScrollReset: true },
    );
  };

  return (
    <div className="desktop-settings">
      <Tabs value={currentTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="actions">{t('SETTINGS_ACTIONS_TAB_TITLE')}</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="settings">{t('SETTINGS_GENERAL_TAB_TITLE')}</TabsTrigger>
          <TabsTrigger value="security">{t('SETTINGS_SECURITY_TAB_TITLE')}</TabsTrigger>
          <TabsTrigger value="appstores" className="d-none d-md-block">
            {t('SETTINGS_APPSTORES_TAB_TITLE')}
          </TabsTrigger>
          <TabsTrigger value="logs" className="d-none d-md-block">
            {t('SETTINGS_LOGS_TAB_TITLE')}
          </TabsTrigger>
          <DropdownMenu>
            <DropdownMenuTrigger className="nav-link dropdown-toggle d-block d-md-none">{t('MORE')}</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => handleTabChange('appstores')}>{t('SETTINGS_APPSTORES_TAB_TITLE')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleTabChange('logs')}>{t('SETTINGS_LOGS_TAB_TITLE')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TabsList>
        <TabsContent value="actions">
          <Suspense>
            <GeneralActionsContainer />
          </Suspense>
        </TabsContent>
        <TabsContent value="appearance">
          <Appearance />
        </TabsContent>
        <TabsContent value="settings">
          <Suspense>
            <UserSettingsContainer initialValues={userSettings} />
          </Suspense>
        </TabsContent>
        <TabsContent value="security">
          <Suspense>
            <SecurityContainer totpEnabled={Boolean(user.totpEnabled)} username={user.username} />
          </Suspense>
        </TabsContent>
        <TabsContent value="appstores">
          <Suspense>
            <AppStoresContainer />
          </Suspense>
        </TabsContent>
        <TabsContent value="logs">
          <Suspense>
            <LogsContainer />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
};
