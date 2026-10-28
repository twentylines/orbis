import { getInstalledAppsOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useWindowVisible } from '@/desktop/window-visibility';
import type { AppCategory, AppInfoSimple } from '@/types/app.types';
import { IconArrowRight, IconDeviceGamepad2, IconMovie } from '@tabler/icons-react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { StoreTile } from '../store-tile/store-tile';
import { nextStorePreviewHistory, type StorePreviewHistory } from '../../pages/store-preview-navigation';
import { useStorePreview } from '../../pages/store-preview-context';
import { mediaApps, mediaRecommendations, missingRecommendations, resolveCuratedApp, type MediaApp } from './store-curation';
import { StoreStackReview } from './store-stack-review';

const shelves: { category: AppCategory; title: string }[] = [
  { category: 'ai', title: 'AI on your server' },
  { category: 'development', title: 'Development environments' },
  { category: 'utilities', title: 'Server essentials' },
  { category: 'featured', title: 'Featured in your catalogue' },
];

export function StoreDiscover({ storeId, onBrowse }: { storeId?: string; onBrowse: (category?: AppCategory) => void }) {
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
  return (
    <div className="orbis-store-discover">
      {known ? (
        <>
          <div className="orbis-store-collections">
            {showMedia ? (
              <section className="orbis-store-collection orbis-store-collection-media">
                <div className="orbis-store-collection-logos" aria-hidden="true">
                  {player && !existingPlayer ? <AppLogo urn={player.urn} size={76} /> : <IconMovie size={56} stroke={1.5} />}
                  {companions.slice(0, 3).map((entry) => (
                    <AppLogo key={entry.id} urn={resolved[entry.id]?.urn} size={44} />
                  ))}
                </div>
                <h3>{existingPlayer ? 'Extend your media setup' : 'Build a media stack'}</h3>
                <p>
                  {existingPlayer
                    ? `${existingPlayer.name} is installed. Add only the library tools or download client you need.`
                    : `Choose ${resolved.jellyfin && resolved.plex ? 'Jellyfin or Plex' : player?.name}, with optional library tools and a download client. Review each installation separately.`}
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
                  Choose apps <IconArrowRight size={18} aria-hidden="true" />
                </Button>
              </section>
            ) : null}
            {showGaming ? (
              <section className="orbis-store-collection orbis-store-collection-gaming">
                <div className="orbis-store-collection-logos" aria-hidden="true">
                  <AppLogo urn={crafty.urn} size={76} />
                  <IconDeviceGamepad2 size={38} stroke={1.5} />
                </div>
                <h3>Game servers</h3>
                <p>Create and manage game servers with {crafty.name}. Check its required ports before installation.</p>
                <Link
                  ref={visible ? preview?.onCardMount : undefined}
                  className="orbis-store-collection-link"
                  data-store-app={visible ? crafty.urn : undefined}
                  aria-controls={preview?.split ? 'store-app-preview' : undefined}
                  aria-expanded={preview?.split ? preview.selectedUrn === crafty.urn : undefined}
                  to={`/app-store/${encodeURIComponent(crafty.urn.split(':')[1] ?? '')}/${encodeURIComponent(crafty.id)}${location.search}`}
                  state={nextStorePreviewHistory(
                    location.state as StorePreviewHistory | null,
                    location.search,
                    location.pathname.startsWith('/app-store/'),
                  )}
                  preventScrollReset
                >
                  View {crafty.name} <IconArrowRight size={18} aria-hidden="true" />
                </Link>
              </section>
            ) : null}
          </div>
          {media.some((query) => query.isError) || gaming.isError ? (
            <p className="orbis-store-discovery-note">Some setup suggestions could not be checked. All apps remains available below.</p>
          ) : null}
          {candidates.map((shelf) => (
            <StoreShelf key={`${storeId ?? 'all'}-${shelf.category}`} {...shelf} installed={current} storeId={storeId} onBrowse={onBrowse} />
          ))}
        </>
      ) : (
        <div className="orbis-store-message" role={installed.isError ? 'alert' : 'status'}>
          <p>
            {installed.isError
              ? 'Installed apps could not be checked. Browse all apps or retry to see relevant suggestions.'
              : 'Checking installed apps for relevant suggestions…'}
          </p>
          {installed.isError ? <Button onClick={() => void installed.refetch()}>Try again</Button> : null}
        </div>
      )}
      <Button className="orbis-store-browse-all" intent="secondary" onClick={() => onBrowse()}>
        Browse all apps <IconArrowRight size={18} aria-hidden="true" />
      </Button>
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
      <header className="orbis-store-result-heading">
        <h3>{title}</h3>
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
