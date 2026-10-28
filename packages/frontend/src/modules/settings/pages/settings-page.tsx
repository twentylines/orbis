import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAppContext } from '@/context/app-context';
import { Suspense, lazy, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { AppStoresContainer } from '../containers/app-stores-container';
import { Appearance } from '../containers/appearance';
import { ClusterSettings } from '../containers/cluster-settings';
import { DelayedRouteLoading } from '@/desktop/route-loading';

const UserSettingsContainer = lazy(() => import('../containers/user-settings').then((module) => ({ default: module.UserSettingsContainer })));
const SecurityContainer = lazy(() => import('../containers/security').then((module) => ({ default: module.SecurityContainer })));
const LogsContainer = lazy(() => import('../containers/logs').then((module) => ({ default: module.LogsContainer })));
const About = lazy(() => import('../containers/about').then((module) => ({ default: module.About })));

export default () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  const { userSettings, user } = useAppContext();
  const currentTab = tab && ['appearance', 'settings', 'security', 'cluster', 'appstores', 'logs', 'about'].includes(tab) ? tab : 'appearance';
  const panels = useRef<HTMLDivElement>(null);
  const reservedHeight = useRef(0);

  const handleTabChange = (newTab: string) => {
    const body = panels.current?.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"] > .card-body');
    if (body) {
      const style = getComputedStyle(body);
      reservedHeight.current = body.getBoundingClientRect().height - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
    }
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('tab', newTab);
        return next;
      },
      { preventScrollReset: true },
    );
  };
  const loading = (
    <div className="desktop-route-placeholder" style={{ minHeight: reservedHeight.current || undefined }}>
      <DelayedRouteLoading label="Loading settings…" />
    </div>
  );

  return (
    <div className="desktop-settings" ref={panels}>
      <Tabs value={currentTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="settings">{t('SETTINGS_GENERAL_TAB_TITLE')}</TabsTrigger>
          <TabsTrigger value="security">{t('SETTINGS_SECURITY_TAB_TITLE')}</TabsTrigger>
          <TabsTrigger value="cluster">Cluster</TabsTrigger>
          <TabsTrigger value="appstores" className="d-none d-md-block">
            {t('SETTINGS_APPSTORES_TAB_TITLE')}
          </TabsTrigger>
          <TabsTrigger value="logs" className="d-none d-md-block">
            {t('SETTINGS_LOGS_TAB_TITLE')}
          </TabsTrigger>
          <TabsTrigger value="about" className="d-none d-md-block">
            About
          </TabsTrigger>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="nav-link dropdown-toggle d-block d-md-none"
              data-selection-active={['appstores', 'logs', 'about'].includes(currentTab)}
            >
              {t('MORE')}
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => handleTabChange('appstores')}>{t('SETTINGS_APPSTORES_TAB_TITLE')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleTabChange('logs')}>{t('SETTINGS_LOGS_TAB_TITLE')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleTabChange('about')}>About</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TabsList>
        <TabsContent value="appearance">
          <Appearance />
        </TabsContent>
        <TabsContent value="settings">
          <Suspense fallback={loading}>
            <UserSettingsContainer initialValues={userSettings} />
          </Suspense>
        </TabsContent>
        <TabsContent value="security">
          <Suspense fallback={loading}>
            <SecurityContainer totpEnabled={Boolean(user.totpEnabled)} username={user.username} />
          </Suspense>
        </TabsContent>
        <TabsContent value="cluster">
          <ClusterSettings />
        </TabsContent>
        <TabsContent value="appstores">
          <Suspense fallback={loading}>
            <AppStoresContainer />
          </Suspense>
        </TabsContent>
        <TabsContent value="logs">
          <Suspense fallback={loading}>
            <LogsContainer />
          </Suspense>
        </TabsContent>
        <TabsContent value="about">
          <Suspense fallback={loading}>
            <About />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
};
