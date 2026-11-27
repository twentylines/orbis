import { AppLogo } from '@/components/app-logo/app-logo';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { Button } from '@/components/ui/Button';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { useWindowVisible } from '@/desktop/window-visibility';
import type { AppInfoSimple } from '@/types/app.types';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { useStorePreview } from '../../pages/store-preview-context';
import { storePreviewLinkProps } from '../../pages/store-preview-navigation';
import './store-tile.css';
import { catalogueInstallAllowed } from '../../helpers/catalogue-compatibility';

export function StoreTile({
  app,
  isLoading,
  catalogueRow = false,
  quickInstall = false,
  installed = false,
  pending = false,
  installLoading = false,
  installDisabled = false,
  onInstall,
}: {
  app: AppInfoSimple;
  isLoading: boolean;
  catalogueRow?: boolean;
  quickInstall?: boolean;
  installed?: boolean;
  pending?: boolean;
  installLoading?: boolean;
  installDisabled?: boolean;
  onInstall?: (app: AppInfoSimple) => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const preview = useStorePreview();
  const visible = useWindowVisible();
  const id = useId();
  const age = Date.now() - app.created_at;
  const isNew = app.created_at > 0 && age >= 0 && age < 14 * 24 * 60 * 60 * 1000;
  const showInstall = quickInstall && Boolean(onInstall) && !installed && !pending && !isLoading && catalogueInstallAllowed(app);

  return (
    <div className="orbis-store-product">
      <Link
        ref={visible ? preview?.onCardMount : undefined}
        aria-labelledby={`${id}-name`}
        aria-describedby={`${id}-description${catalogueInstallAllowed(app) ? '' : ` ${id}-notice`}${installed || pending ? ` ${id}-state` : ''}`}
        className={`app-tile orbis-store-tile${catalogueRow ? ' orbis-store-tile-catalogue' : ''}`}
        {...storePreviewLinkProps(location, app.urn)}
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
            <h3 id={`${id}-name`}>
              <Skeleton loading={isLoading}>
                <WrapWords text={app.name} />
              </Skeleton>
            </h3>
          </div>
          <p id={`${id}-description`} className="orbis-store-tile-description">
            <Skeleton loading={isLoading}>
              <WrapWords text={app.short_desc} />
            </Skeleton>
          </p>
          <div className="orbis-store-tile-footer">
            {catalogueInstallAllowed(app) ? (
              isNew ? (
                <span className="orbis-store-tile-new">{t('APP_NEW')}</span>
              ) : (
                <span />
              )
            ) : (
              <span id={`${id}-notice`} className="orbis-store-tile-notice">
                {app.deprecated ? 'Deprecated' : app.compatibility?.supported === false ? 'Not supported yet' : 'Unavailable'}
              </span>
            )}
            {showInstall ? (
              <span className="orbis-store-install-slot" aria-hidden="true" />
            ) : (
              <span id={installed || pending ? `${id}-state` : undefined} className="orbis-store-tile-action">
                {installed ? 'Installed' : pending ? 'Pending' : 'Preview'}
              </span>
            )}
          </div>
        </div>
      </Link>
      {showInstall ? (
        <Button
          type="button"
          className="orbis-store-quick-install"
          aria-label={`Install ${app.name}`}
          loading={installLoading}
          disabled={installDisabled}
          onClick={() => onInstall?.(app)}
        >
          Install
        </Button>
      ) : null}
    </div>
  );
}
