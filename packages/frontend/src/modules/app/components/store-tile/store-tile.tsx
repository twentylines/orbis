import { AppLogo } from '@/components/app-logo/app-logo';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { useWindowVisible } from '@/desktop/window-visibility';
import type { AppInfoSimple } from '@/types/app.types';
import { IconChevronRight } from '@tabler/icons-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { useStorePreview } from '../../pages/store-preview-context';
import { nextStorePreviewHistory, type StorePreviewHistory } from '../../pages/store-preview-navigation';
import './store-tile.css';

export function StoreTile({ app, isLoading }: { app: AppInfoSimple; isLoading: boolean }) {
  const { t } = useTranslation();
  const location = useLocation();
  const preview = useStorePreview();
  const visible = useWindowVisible();
  const id = useId();
  const age = Date.now() - app.created_at;
  const isNew = app.created_at > 0 && age >= 0 && age < 14 * 24 * 60 * 60 * 1000;
  const [appId, storeId] = app.urn.split(':');

  return (
    <Link
      ref={visible ? preview?.onCardMount : undefined}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-description${app.deprecated || !app.available ? ` ${id}-notice` : ''}`}
      className="app-tile orbis-store-tile"
      to={`/app-store/${encodeURIComponent(storeId ?? '')}/${encodeURIComponent(appId ?? '')}${location.search}`}
      state={nextStorePreviewHistory(location.state as StorePreviewHistory | null, location.search, location.pathname.startsWith('/app-store/'))}
      preventScrollReset
      data-store-app={visible ? app.urn : undefined}
      aria-controls={preview?.split ? 'store-app-preview' : undefined}
      aria-expanded={preview?.split ? preview.selectedUrn === app.urn : undefined}
    >
      <div className="orbis-store-tile-art">
        <div className="orbis-store-tile-art-backdrop" aria-hidden="true">
          <img
            src={`/api/marketplace/apps/${encodeURIComponent(app.urn)}/image`}
            width={160}
            height={160}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        </div>
        <Skeleton loading={isLoading}>
          <AppLogo className="orbis-store-logo" urn={app.urn} size={72} placeholder={isLoading} />
        </Skeleton>
        <span className="orbis-store-tile-categories">
          {app.categories.map((category, index) => (
            <span key={category}>
              {index ? <span aria-hidden="true"> · </span> : null}
              {t(`APP_CATEGORY_${category.toUpperCase()}`)}
            </span>
          ))}
        </span>
      </div>
      <div className="orbis-store-tile-copy">
        <div className="orbis-store-tile-title">
          <h3 id={`${id}-name`} title={app.name}>
            <Skeleton loading={isLoading}>
              <WrapWords text={app.name} />
            </Skeleton>
          </h3>
        </div>
        <p id={`${id}-description`} className="orbis-store-tile-description" title={app.short_desc}>
          <Skeleton loading={isLoading}>
            <WrapWords text={app.short_desc} />
          </Skeleton>
        </p>
        <div className="orbis-store-tile-footer">
          {app.deprecated || !app.available ? (
            <span id={`${id}-notice`} className="orbis-store-tile-notice">
              {app.deprecated ? 'Deprecated' : 'Unavailable'}
            </span>
          ) : isNew ? (
            <span className="orbis-store-tile-new">{t('APP_NEW')}</span>
          ) : (
            <span />
          )}
          <span className="orbis-store-tile-action" aria-hidden="true">
            Preview <IconChevronRight size={16} />
          </span>
        </div>
      </div>
    </Link>
  );
}
