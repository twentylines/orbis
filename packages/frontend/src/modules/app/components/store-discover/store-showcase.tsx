import { AppLogo } from '@/components/app-logo/app-logo';
import { useWindowVisible } from '@/desktop/window-visibility';
import { iconForCategory } from '@/modules/app/helpers/table-helpers';
import type { AppCategory, AppInfoSimple } from '@/types/app.types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { useStorePreview } from '../../pages/store-preview-context';
import { storePreviewLinkProps } from '../../pages/store-preview-navigation';
import './store-showcase.css';
import { catalogueGallery, catalogueInstallAllowed } from '../../helpers/catalogue-compatibility';

const showcaseCategories: readonly AppCategory[] = ['media', 'data', 'photography', 'utilities', 'development', 'automation', 'security', 'music'];
const browseCategories = ['media', 'data', 'photography', 'utilities', 'development', 'automation'] as const;

// This is an editorial sample of the loaded catalogue, never a popularity ranking.
export function storeSpotlights(catalogue: readonly AppInfoSimple[], storeId?: string): AppInfoSimple[] {
  const available = catalogue.filter((app) => catalogueInstallAllowed(app) && (!storeId || app.urn.split(':')[1] === storeId));
  const selected: AppInfoSimple[] = [];
  const add = (app: AppInfoSimple | undefined) => {
    if (app && selected.length < 3 && !selected.some((item) => item.id === app.id)) selected.push(app);
  };
  add(available.find((app) => app.categories.includes('featured')));
  for (const category of showcaseCategories)
    add(available.find((app) => app.categories.includes(category) && !selected.some((item) => item.id === app.id)));
  for (const app of available) add(app);
  return selected;
}

function Spotlight({ app, primary, installed, pending }: { app: AppInfoSimple; primary: boolean; installed: boolean; pending: boolean }) {
  const { t } = useTranslation();
  const location = useLocation();
  const preview = useStorePreview();
  const visible = useWindowVisible();
  const id = useId();
  const galleryImage = primary ? catalogueGallery(app)[0] : undefined;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const showGallery = Boolean(galleryImage && failedImage !== galleryImage);
  const category = app.categories.find((category) => category !== 'featured');
  return (
    <Link
      ref={visible ? preview?.onCardMount : undefined}
      className={`orbis-store-spotlight${primary ? ' orbis-store-spotlight-primary' : ''}`}
      {...storePreviewLinkProps(location, app.urn, { kind: 'spotlight', urn: app.urn })}
      preventScrollReset
      data-store-app={visible ? app.urn : undefined}
      data-store-suggestion="spotlight"
      data-has-gallery={showGallery || undefined}
      aria-controls={preview?.split ? 'store-app-preview' : undefined}
      aria-expanded={preview?.split ? preview.selectedUrn === app.urn : undefined}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-description`}
    >
      <div className="orbis-store-spotlight-art" data-gallery={showGallery || undefined} aria-hidden="true">
        {showGallery ? (
          <img
            className="orbis-store-spotlight-screenshot"
            src={galleryImage}
            alt=""
            width={640}
            height={400}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailedImage(galleryImage ?? null)}
          />
        ) : (
          <div className="orbis-store-spotlight-orbit" />
        )}
        <AppLogo urn={app.urn} size={primary ? 144 : 88} />
      </div>
      <div className="orbis-store-spotlight-copy">
        <span className="orbis-store-spotlight-category">{category ? t(`APP_CATEGORY_${category.toUpperCase()}`) : 'App spotlight'}</span>
        <h3 id={`${id}-name`}>{app.name}</h3>
        <p id={`${id}-description`}>{app.short_desc}</p>
        <span className="orbis-store-spotlight-action">{pending ? 'Installation pending' : installed ? 'View installed app' : 'Explore app'}</span>
      </div>
    </Link>
  );
}

export function StoreShowcase({
  apps,
  storeId,
  installedApps,
  pendingApps,
  onBrowse,
}: {
  apps: readonly AppInfoSimple[];
  storeId?: string;
  installedApps: ReadonlySet<string>;
  pendingApps: ReadonlySet<string>;
  onBrowse: (category: AppCategory) => void;
}) {
  const { t } = useTranslation();
  const preview = useStorePreview();
  const splitPreview = Boolean(preview?.split && preview.selectedUrn);
  const onlySpotlightUrn = splitPreview && preview?.suggestion?.kind === 'spotlight' ? preview.suggestion.urn : undefined;
  if (splitPreview && !onlySpotlightUrn) return null;
  const spotlights = storeSpotlights(apps.slice(0, 24), storeId);
  const selected = onlySpotlightUrn && apps.find((app) => app.urn === onlySpotlightUrn && catalogueInstallAllowed(app));
  const shown = onlySpotlightUrn ? (selected ? [selected] : []) : spotlights;
  if (!shown.length) return null;
  return (
    <div className="orbis-store-showcase">
      <section className="orbis-store-spotlights" aria-label="Discover apps" data-spotlight-count={shown.length}>
        {shown.map((app) => (
          <Spotlight
            key={app.urn}
            app={app}
            primary={spotlights[0]?.urn === app.urn}
            installed={installedApps.has(app.urn)}
            pending={pendingApps.has(app.urn)}
          />
        ))}
      </section>
      {onlySpotlightUrn ? null : (
        <section className="orbis-store-explore" aria-label="Explore app categories">
          <div className="orbis-store-explore-heading">
            <h2>Find your next app</h2>
            <p>A little more possibility for your server.</p>
          </div>
          <div className="orbis-store-category-grid">
            {browseCategories.map((category) => {
              const CategoryIcon = iconForCategory.find((entry) => entry.id === category)?.icon;
              return (
                <button key={category} type="button" onClick={() => onBrowse(category)}>
                  {CategoryIcon ? <CategoryIcon size={22} aria-hidden="true" /> : null}
                  <span>{t(`APP_CATEGORY_${category.toUpperCase()}`)}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
