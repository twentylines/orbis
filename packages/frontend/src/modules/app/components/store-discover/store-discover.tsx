import { getInstalledAppsOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useWindowVisible } from '@/desktop/window-visibility';
import type { AppCategory, AppInfoSimple } from '@/types/app.types';
import { IconArrowRight } from '@tabler/icons-react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { StoreTile } from '../store-tile/store-tile';
import { nextStorePreviewHistory, type StorePreviewHistory } from '../../pages/store-preview-navigation';
import { useStorePreview } from '../../pages/store-preview-context';
import { mediaApps, mediaRecommendations, missingRecommendations, resolveCuratedApp, type MediaApp } from './store-curation';
import { StoreStackReview } from './store-stack-review';

const shelves: { category: AppCategory; title: string }[] = [
  { category: 'ai', title: 'AI' },
  { category: 'development', title: 'Development' },
  { category: 'utilities', title: 'Utilities' },
  { category: 'featured', title: 'Featured' },
];

export function StoreDiscover({
  storeId,
  onBrowse,
  onCollections,
  presentation = 'page',
}: {
  storeId?: string;
  onBrowse: (category?: AppCategory) => void;
  onCollections?: () => void;
  presentation?: 'page' | 'editorial';
}) {
  const visible = useWindowVisible();
  const location = useLocation();
  const preview = useStorePreview();
  const [review, setReview] = useState<{
    resolved: Partial<Record<MediaApp, AppInfoSimple>>;
    existingPlayer?: string;
    existingClient?: string;
    installedIds: string[];
  } | null>(null);
  const installed = useQuery({
    ...getInstalledAppsOptions(),
    enabled: visible,
    refetchInterval: visible ? 15000 : false,
    refetchIntervalInBackground: false,
  });
  const current = installed.data?.installed.filter((entry) => entry.app.status !== 'missing').map((entry) => entry.info) ?? [];
  const known = installed.isSuccess && !installed.isPlaceholderData;
  const media = useQueries({
    queries: mediaApps.map((entry) => ({
      ...searchAppsOptions({ query: { search: entry.name, pageSize: 24, storeId } }),
      staleTime: 300000,
      enabled: known && visible,
    })),
  });
  const gaming = useQuery({
    ...searchAppsOptions({ query: { search: 'Crafty', pageSize: 24, storeId } }),
    staleTime: 300000,
    enabled: known && visible,
  });
  const catalogue: Partial<Record<MediaApp, AppInfoSimple>> = {};
  mediaApps.forEach((entry, index) => {
    const app = resolveCuratedApp(media[index]?.data?.data ?? [], [entry.id], storeId);
    if (app) catalogue[entry.id] = app;
  });
  const { resolved, existingPlayer, existingClient } = mediaRecommendations(catalogue, current);
  const player = resolved.jellyfin ?? resolved.plex;
  const companions = mediaApps.filter((entry) => entry.id !== 'jellyfin' && entry.id !== 'plex' && resolved[entry.id]);
  const showMedia = media.every((query) => query.isSuccess) && (existingPlayer ? companions.length > 0 : Boolean(player));
  const crafty = resolveCuratedApp(missingRecommendations(gaming.data?.data ?? [], current), ['crafty'], storeId);
  const showGaming = crafty && !current.some((app) => app.categories.includes('gaming'));
  const candidates = shelves.filter((shelf) => !current.some((app) => app.categories.includes(shelf.category))).slice(0, 2);
  const artwork = [existingPlayer ?? player, ...companions.map((entry) => resolved[entry.id])].filter((app): app is AppInfoSimple => Boolean(app));
  const checking = media.some((query) => query.isPending) || gaming.isPending;
  return (
    <div className="orbis-store-discover" data-presentation={presentation}>
      <header className="orbis-store-section-heading">
        <h2>Collections</h2>
        {presentation === 'editorial' && onCollections ? (
          <button type="button" onClick={onCollections}>
            See all <IconArrowRight size={16} aria-hidden="true" />
          </button>
        ) : null}
      </header>
      {known ? (
        <>
          <div className="orbis-store-collections">
            {showMedia ? (
              <section className="orbis-store-collection orbis-store-collection-media">
                <StoreCollectionArt apps={artwork} kind="media" />
                <div className="orbis-store-collection-content">
                  <h3>Media library</h3>
                  <p>
                    {existingPlayer
                      ? `${existingPlayer.name} is installed. Add missing library tools or a download client.`
                      : `${[resolved.jellyfin?.name, resolved.plex?.name].filter(Boolean).join(' or ')} and tools for your library.`}
                  </p>
                  <Button
                    className="orbis-store-collection-action"
                    onClick={() =>
                      setReview({
                        resolved: { ...resolved },
                        existingPlayer: existingPlayer?.name,
                        existingClient: existingClient?.name,
                        installedIds: current.map((app) => app.id),
                      })
                    }
                  >
                    Review setup <IconArrowRight size={18} aria-hidden="true" />
                  </Button>
                </div>
              </section>
            ) : null}
            {showGaming ? (
              <section className="orbis-store-collection orbis-store-collection-gaming">
                <StoreCollectionArt apps={[crafty]} kind="gaming" />
                <div className="orbis-store-collection-content">
                  <h3>Game servers</h3>
                  <p>{crafty.name} for managing your game servers.</p>
                  <Link
                    ref={visible ? preview?.onCardMount : undefined}
                    className="orbis-store-collection-link"
                    to={`/app-store/${encodeURIComponent(crafty.urn.split(':')[1] ?? '')}/${encodeURIComponent(crafty.id)}${location.search}`}
                    state={nextStorePreviewHistory(
                      location.state as StorePreviewHistory | null,
                      location.search,
                      location.pathname.startsWith('/app-store/'),
                    )}
                    preventScrollReset
                    data-store-app={visible ? crafty.urn : undefined}
                    aria-controls={preview?.split ? 'store-app-preview' : undefined}
                    aria-expanded={preview?.split ? preview.selectedUrn === crafty.urn : undefined}
                  >
                    Preview {crafty.name} <IconArrowRight size={18} aria-hidden="true" />
                  </Link>
                </div>
              </section>
            ) : null}
          </div>
          {media.some((query) => query.isError) || gaming.isError ? (
            <p className="orbis-store-discovery-note">Some collections could not be checked. App browsing is still available.</p>
          ) : null}
          {presentation === 'editorial' ? (
            !showMedia && !showGaming ? (
              <output className="orbis-store-discovery-note">{checking ? 'Loading collections…' : 'No setup suggestions in this catalogue.'}</output>
            ) : null
          ) : (
            candidates.map((shelf) => (
              <StoreShelf key={`${storeId ?? 'all'}-${shelf.category}`} {...shelf} installed={current} storeId={storeId} onBrowse={onBrowse} />
            ))
          )}
        </>
      ) : (
        <div className="orbis-store-message" role={installed.isError ? 'alert' : 'status'}>
          <p>{installed.isError ? 'Collections could not be checked against your installed apps.' : 'Checking installed apps…'}</p>
          {installed.isError ? <Button onClick={() => void installed.refetch()}>Try again</Button> : null}
        </div>
      )}
      {review ? (
        <StoreStackReview
          installedIds={review.installedIds}
          resolved={review.resolved}
          existingPlayer={review.existingPlayer}
          existingClient={review.existingClient}
          onClose={() => setReview(null)}
        />
      ) : null}
    </div>
  );
}

export function StoreCollectionArt({ apps, kind }: { apps: AppInfoSimple[]; kind: AppCategory }) {
  if (!apps.length) return null;
  return (
    <div className="orbis-store-collection-art" data-collection-kind={kind} aria-hidden="true">
      {apps.slice(0, 4).map((app, index) => (
        <span className="orbis-store-artwork-app" data-art-position={index} key={app.urn}>
          <AppLogo urn={app.urn} size={128} />
        </span>
      ))}
    </div>
  );
}

function StoreShelf({
  category,
  title,
  installed,
  storeId,
  onBrowse,
}: {
  category: AppCategory;
  title: string;
  installed: AppInfoSimple[];
  storeId?: string;
  onBrowse: (category?: AppCategory) => void;
}) {
  const visible = useWindowVisible();
  const query = useQuery({ ...searchAppsOptions({ query: { category, pageSize: 12, storeId } }), staleTime: 300000, enabled: visible });
  const apps = missingRecommendations(query.data?.data ?? [], installed).slice(0, 3);
  if (query.isSuccess && !apps.length) return null;
  return (
    <section className="orbis-store-shelf">
      <header className="orbis-store-section-heading">
        <h2>{title}</h2>
        <button type="button" onClick={() => onBrowse(category)}>
          See all <IconArrowRight size={16} aria-hidden="true" />
        </button>
      </header>
      {query.isError ? (
        <div className="orbis-store-message" role="alert">
          <p>This collection could not be loaded.</p>
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </div>
      ) : query.isPending ? (
        <p aria-live="polite">Loading apps…</p>
      ) : (
        <div className="orbis-store-grid">
          {apps.map((app) => (
            <StoreTile key={app.urn} app={app} isLoading={false} />
          ))}
        </div>
      )}
    </section>
  );
}
