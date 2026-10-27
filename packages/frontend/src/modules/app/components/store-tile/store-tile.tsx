import type React from 'react';
import './store-tile.css';
import { AppLogo } from '@/components/app-logo/app-logo';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import type { AppInfoSimple } from '@/types/app.types';
import { useTranslation } from 'react-i18next';
import { useStorePreview } from '../../pages/store-preview-context';
import { nextStorePreviewHistory, type StorePreviewHistory } from '../../pages/store-preview-navigation';
import { Link, useLocation } from 'react-router';
import { colorSchemeForCategory } from '../../helpers/table-helpers';

export const StoreTile: React.FC<{ app: AppInfoSimple; isLoading: boolean }> = ({ app, isLoading }) => {
  const { t } = useTranslation();
  const location = useLocation();
  const preview = useStorePreview();

  const isNew = (app.created_at ?? 0) + 14 * 24 * 60 * 60 * 1000 > Date.now();

  const [appId, storeId] = app.urn.split(':');

  return (
    <Link
      ref={preview?.onCardMount}
      aria-label={app.name}
      className="app-tile"
      to={`/app-store/${encodeURIComponent(storeId ?? '')}/${encodeURIComponent(appId ?? '')}${location.search}`}
      state={nextStorePreviewHistory(location.state as StorePreviewHistory | null, location.search, location.pathname.startsWith('/app-store/'))}
      preventScrollReset
      data-store-app={app.urn}
      aria-controls={preview?.split ? 'store-app-preview' : undefined}
      aria-expanded={preview?.split ? preview.selectedUrn === app.urn : undefined}
    >
      <div key={app.id} className="d-flex overflow-hidden align-items-start catalogue-tile">
        <Skeleton loading={isLoading}>
          <AppLogo className="logo" urn={app.urn} placeholder={isLoading} />
        </Skeleton>
        <div className="card-body">
          <div className="d-flex align-items-center" style={{ columnGap: '0.75rem' }}>
            <h3 className="text-bold mb-2 catalogue-tile-name" title={app.name}>
              <Skeleton loading={isLoading}>
                <span>
                  <WrapWords text={app.name} />
                </span>
              </Skeleton>
            </h3>
            {isNew ? <div className="text-white badge me-1 bg-green">{t('APP_NEW')}</div> : null}
          </div>
          <p className="text-muted mb-2 catalogue-tile-description" title={app.short_desc}>
            <Skeleton loading={isLoading}>
              <span>
                <WrapWords text={app.short_desc} />
              </span>
            </Skeleton>
          </p>
          {app.categories?.map((category) => (
            <Skeleton loading={isLoading} key={`${app.id}-${category}`}>
              <div className={`text-white badge me-1 bg-${colorSchemeForCategory[category]}`}>
                {t(`APP_CATEGORY_${category.toUpperCase() as Uppercase<typeof category>}`)}
              </div>
            </Skeleton>
          ))}
        </div>
      </div>
    </Link>
  );
};
