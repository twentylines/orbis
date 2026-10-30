import { getAllAppStoresOptions } from '@/api-client/@tanstack/react-query.gen';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { IconAlertCircle, IconBrandAppstore } from '@tabler/icons-react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAppContext } from '@/context/app-context';
import { useDesktopPreferences } from '@/desktop/preferences';
import { AppStoresTable } from '../components/app-stores-table/app-stores-table';
import { RefreshAppStoresButton } from '@/components/refresh-app-stores/refresh-app-stores';
import { StoreRecommendationSettings } from './store-recommendation-settings';
import { Link } from 'react-router';
import { AutomaticAppUpdateSwitch } from './app-update-policy';

export const AppStoresContainer = () => {
  const { t } = useTranslation();
  const { user } = useAppContext();
  const { preferences, update } = useDesktopPreferences();

  const { data } = useSuspenseQuery({
    ...getAllAppStoresOptions(),
  });

  return (
    <div className="settings-store-groups">
      <StoreRecommendationSettings
        shown={preferences.showStoreRecommendations}
        hidden={preferences.hiddenStoreRecommendationCategories}
        onChange={(showStoreRecommendations) => update({ showStoreRecommendations })}
        onRestore={() => update({ hiddenStoreRecommendationCategories: [] })}
      />
      {user.operator === true ? (
        <section className="appearance-section">
          <div>
            <h2>App updates</h2>
          </div>
          <div className="settings-store-update-controls">
            <AutomaticAppUpdateSwitch section="store" />
            <Link className="btn btn-outline-primary" to="/settings?tab=updates&setting=store-app-updates">
              More settings
            </Link>
          </div>
        </section>
      ) : null}
      <div id="setting-store-sources" className="app-stores-settings-heading">
        <div className="app-stores-settings-title">
          <IconBrandAppstore aria-hidden="true" />
          <h2>{t('SETTINGS_APPSTORES_TITLE')}</h2>
        </div>
        <RefreshAppStoresButton />
      </div>
      <Alert variant="warning" className="store-source-warning">
        <AlertIcon>
          <IconAlertCircle stroke={2} />
        </AlertIcon>
        <div>
          <AlertHeading>{t('COMMON_WARNING')}</AlertHeading>
          <AlertDescription>{t('SETTINGS_APPSTORES_WARNING')}</AlertDescription>
        </div>
      </Alert>
      <AppStoresTable appStores={data.appStores} />
    </div>
  );
};
