import { getInstalledAppsOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { sectionMotionTiming } from '@/desktop/section-motion-geometry';
import { useWindowVisible } from '@/desktop/window-visibility';
import type { AppCategory, AppInfoSimple } from '@/types/app.types';
import { IconArrowRight, IconX } from '@tabler/icons-react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useIsPresent, type HTMLMotionProps } from 'framer-motion';
import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { nextStorePreviewHistory, type StorePreviewHistory } from '../../pages/store-preview-navigation';
import { useStorePreview } from '../../pages/store-preview-context';
import {
  installationState,
  isMediaPlayer,
  mediaApps,
  mediaRecommendations,
  mediaStackCoverage,
  resolveCuratedApp,
  type MediaApp,
} from './store-curation';
import { recommendationCategories, recommendStoreApps, type StoreRecommendationCategory } from './store-recommendations';
import { StoreStackReview } from './store-stack-review';
import './store-recommendations.css';

const RecommendationSurface = forwardRef<HTMLDivElement, HTMLMotionProps<'div'>>(function RecommendationSurface(props, ref) {
  const present = useIsPresent();
  return <motion.div {...props} ref={ref} inert={!present} aria-hidden={!present || undefined} />;
});

const RecommendationCard = forwardRef<HTMLElement, HTMLMotionProps<'section'>>(function RecommendationCard(props, ref) {
  const present = useIsPresent();
  return <motion.section {...props} ref={ref} inert={!present} aria-hidden={!present || undefined} />;
});

export function suggestionItemMotion(reduced: boolean, visible: boolean) {
  const duration = reduced || !visible ? 0 : sectionMotionTiming.content / 1000;
  const offset = duration ? 4 : 0;
  return {
    initial: { opacity: duration ? 0 : 1, y: offset },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: offset ? -offset : 0 },
    transition: { duration, ease: [0.32, 0.08, 0.24, 1] as const },
  };
}

export function suggestionSurfaceMotion(presentation: 'page' | 'editorial', reduced: boolean, visible: boolean, animateEntry = true) {
  const duration = reduced || !visible ? 0 : sectionMotionTiming.content / 1000;
  const editorial = presentation === 'editorial';
  return {
    layout: editorial ? ('position' as const) : undefined,
    initial: animateEntry ? (editorial ? { opacity: 0, y: 4 } : { opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0, y: 4 }) : false,
    animate: editorial ? { opacity: 1, y: 0 } : { opacity: 1, height: 'auto' as const, paddingTop: 12, paddingBottom: 12, y: 0 },
    exit: editorial ? { opacity: 0, y: -4 } : { opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0, y: -4 },
    transition: { duration, ease: [0.32, 0.08, 0.24, 1] as const },
  };
}

export function disableStoreRecommendations(update: (patch: { showStoreRecommendations: boolean }) => void) {
  update({ showStoreRecommendations: false });
}

const RecommendationRow = forwardRef<HTMLLIElement, HTMLMotionProps<'li'>>(function RecommendationRow(props, ref) {
  const present = useIsPresent();
  return <motion.li {...props} ref={ref} inert={!present} aria-hidden={!present || undefined} />;
});

export function StoreDiscover({
  storeId,
  onBrowse,
  enabled = true,
  hiddenCategories = [],
  onDisableSuggestions,
  onHideCategory,
  seed,
  presentation = 'page',
}: {
  storeId?: string;
  onBrowse: (category?: AppCategory) => void;
  onCollections?: () => void;
  enabled?: boolean;
  hiddenCategories?: readonly StoreRecommendationCategory[];
  onDisableSuggestions?: () => void;
  onHideCategory?: (category: StoreRecommendationCategory) => void;
  seed?: string;
  presentation?: 'page' | 'editorial';
}) {
  const visible = useWindowVisible();
  const location = useLocation();
  const params = useParams<{ appId: string }>();
  const preview = useStorePreview();
  const reduced = useReducedMotion();
  const reduceMotion = Boolean(reduced);
  const motionDuration = reduceMotion || !visible ? 0 : sectionMotionTiming.content / 1000;
  const [viewSeed, setViewSeed] = useState<string | null>(seed ?? null);
  useEffect(() => {
    if (viewSeed !== null) return;
    const value = globalThis.crypto?.getRandomValues(new Uint32Array(2)).join('-') ?? `${Date.now()}-${Math.random()}`;
    setViewSeed((current) => current ?? value);
  }, [viewSeed]);
  const root = useRef<HTMLDivElement>(null);
  const hasShownSurface = useRef(false);
  const [rotation, setRotation] = useState(0);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const [dismissed, setDismissed] = useState<StoreRecommendationCategory[]>([]);
  useEffect(() => {
    if (location.pathname === '/app-store' || location.pathname.startsWith('/app-store/')) return;
    setDismissed([]);
    setRotation((value) => value + 1);
  }, [location.pathname]);
  const hidden = new Set([...hiddenCategories, ...dismissed]);
  const active = enabled && visible && !params.appId && !preview?.selectedUrn;
  const [review, setReview] = useState<{
    resolved: Partial<Record<MediaApp, AppInfoSimple>>;
    existingPlayer?: string;
    existingClient?: string;
    installedIds: string[];
  } | null>(null);
  const installed = useQuery({
    ...getInstalledAppsOptions(),
    enabled: active,
    staleTime: 300000,
    refetchOnWindowFocus: false,
  });
  const occupied = installed.data?.installed.filter((entry) => entry.app.status !== 'missing') ?? [];
  const current = occupied.map((entry) => entry.info);
  const confirmed = occupied.filter((entry) => installationState(entry.app.status) === 'ready');
  const mediaIds = new Set(mediaApps.map((entry) => entry.id));
  const mediaBusy = occupied.some((entry) => mediaIds.has(entry.info.id as MediaApp) && installationState(entry.app.status) === 'busy');
  const known = installed.isSuccess && !installed.isPlaceholderData;
  const media = useQueries({
    queries: mediaApps.map((entry) => ({
      ...searchAppsOptions({ query: { search: entry.name, pageSize: 24, storeId } }),
      staleTime: 300000,
      enabled: known && active && !hidden.has('media'),
      refetchOnWindowFocus: false,
    })),
  });
  const categories = useQueries({
    queries: recommendationCategories.map(({ category }) => ({
      ...searchAppsOptions({ query: { category, pageSize: 60, storeId } }),
      staleTime: 300000,
      enabled: known && active && !hidden.has(category),
      refetchOnWindowFocus: false,
    })),
  });
  const catalogue: Partial<Record<MediaApp, AppInfoSimple>> = {};
  mediaApps.forEach((entry, index) => {
    const app = resolveCuratedApp(media[index]?.data?.data ?? [], [entry.id], storeId);
    if (app) catalogue[entry.id] = app;
  });
  const { resolved, existingPlayer, existingClient } = mediaRecommendations(
    catalogue,
    confirmed.map((entry) => entry.info),
  );
  const player = resolved.jellyfin ?? resolved.plex ?? resolved.emby;
  const companions = mediaApps.filter((entry) => !isMediaPlayer(entry.id) && resolved[entry.id]);
  const coverage = mediaStackCoverage(
    catalogue,
    occupied.map((entry) => ({ id: entry.info.id, status: entry.app.status })),
  );
  const showMedia =
    !hidden.has('media') &&
    !mediaBusy &&
    !coverage.majorityInstalled &&
    media.every((query) => query.isSuccess) &&
    (existingPlayer ? companions.length > 0 : Boolean(player));
  const ready =
    media.every((query) => hidden.has('media') || query.isSuccess || query.isError) &&
    categories.every((query, index) => hidden.has(recommendationCategories[index]?.category ?? 'media') || query.isSuccess || query.isError);
  const availablePlayers = existingPlayer
    ? [existingPlayer]
    : [resolved.jellyfin, resolved.plex, resolved.emby].filter((app): app is AppInfoSimple => Boolean(app));
  const artwork = [...availablePlayers, ...companions.map((entry) => resolved[entry.id])].filter((app): app is AppInfoSimple => Boolean(app));
  const suggestions = recommendStoreApps(
    categories.flatMap((query) => (query.isSuccess ? query.data.data : [])),
    current,
    viewSeed ?? '',
    storeId,
    rotation,
    [...hidden],
  );
  const slots = showMedia ? 1 : 2;
  const cards = suggestions.slice(0, slots);
  const showSurface = active && known && ready && viewSeed !== null && (showMedia || cards.length > 0);
  useEffect(() => {
    if (showSurface) hasShownSurface.current = true;
  }, [showSurface]);
  const focusAfterDismiss = (category: StoreRecommendationCategory) => {
    const focused = document.activeElement;
    if (
      !(focused instanceof HTMLElement) ||
      focused.closest<HTMLElement>('[data-recommendation-category]')?.dataset.recommendationCategory !== category
    )
      return;
    const target = [...(root.current?.querySelectorAll<HTMLElement>('[data-recommendation-primary]') ?? [])].find(
      (element) => element.closest<HTMLElement>('[data-recommendation-category]')?.dataset.recommendationCategory !== category,
    );
    const fallback = root.current?.closest('.orbis-store')?.querySelector<HTMLElement>('.orbis-store-search input');
    (target ?? fallback)?.focus({ preventScroll: true });
  };
  const dismiss = (category: StoreRecommendationCategory, permanent: boolean) => {
    focusAfterDismiss(category);
    if (permanent) onHideCategory?.(category);
    else setDismissed((previous) => (previous.includes(category) ? previous : [...previous, category]));
  };
  const disableSuggestions = () => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root.current?.contains(focused)) {
      root.current?.closest('.orbis-store')?.querySelector<HTMLElement>('.orbis-store-search input')?.focus({ preventScroll: true });
    }
    onDisableSuggestions?.();
  };
  const refreshSuggestions = () => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root.current?.querySelector('.orbis-store-collections')?.contains(focused)) {
      refreshButton.current?.focus({ preventScroll: true });
    }
    setRotation((value) => value + 1);
  };
  const tools = (category: StoreRecommendationCategory, title: string) => (
    <div className="orbis-store-recommendation-tools">
      {onHideCategory ? (
        <Button type="button" variant="ghost" onClick={() => dismiss(category, true)} aria-label={`Don't show ${title} suggestions again`}>
          Don't show again
        </Button>
      ) : (
        <span />
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => dismiss(category, false)}
        aria-label={`Dismiss ${title} suggestions for this visit`}
      >
        <IconX size={18} aria-hidden="true" />
      </Button>
    </div>
  );
  const card = (category: StoreRecommendationCategory, children: ReactNode) => (
    <RecommendationCard
      key={category}
      layout="position"
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: reduced || !visible ? 0 : -4 }}
      transition={{ duration: motionDuration, ease: [0.32, 0.08, 0.24, 1] }}
      className={`orbis-store-collection orbis-store-collection-${category}`}
      data-recommendation-category={category}
    >
      {children}
    </RecommendationCard>
  );
  return (
    <>
      <AnimatePresence initial={false} mode="popLayout">
        {showSurface ? (
          <RecommendationSurface
            key="recommendations"
            ref={root}
            {...suggestionSurfaceMotion(presentation, reduceMotion, visible, hasShownSurface.current)}
            className={`orbis-store-discover orbis-store-recommendations${presentation === 'editorial' ? ' orbis-store-editorial' : ''}`}
            role="complementary"
            aria-label="App recommendations"
            data-presentation={presentation}
          >
            <header className="orbis-store-section-heading">
              <h2>For your server</h2>
              <div className="orbis-store-recommendation-actions">
                {suggestions.length > slots || suggestions.some((suggestion) => suggestion.choiceCount > suggestion.apps.length) ? (
                  <Button ref={refreshButton} type="button" variant="ghost" onClick={refreshSuggestions}>
                    Refresh
                  </Button>
                ) : null}
                {onDisableSuggestions ? (
                  <Button type="button" variant="ghost" onClick={disableSuggestions}>
                    Do not show suggestions
                  </Button>
                ) : null}
              </div>
            </header>
            <motion.div layout className="orbis-store-collections" transition={{ duration: motionDuration, ease: [0.32, 0.08, 0.24, 1] }}>
              <AnimatePresence initial={false} mode="popLayout">
                {showMedia
                  ? card(
                      'media',
                      <>
                        <StoreCollectionArt apps={artwork} kind="media" reduced={reduceMotion} visible={visible} />
                        <div className="orbis-store-collection-content">
                          <h3>Media library</h3>
                          <p>
                            {existingPlayer
                              ? `${existingPlayer.name} is installed. Add missing library tools or a download client.`
                              : `${[resolved.jellyfin?.name, resolved.plex?.name, resolved.emby?.name].filter(Boolean).join(' or ')} and tools for your library.`}
                          </p>
                          <Button
                            type="button"
                            className="orbis-store-collection-action"
                            data-recommendation-primary
                            onClick={() =>
                              setReview({
                                resolved: { ...resolved },
                                existingPlayer: existingPlayer?.name,
                                existingClient: existingClient?.name,
                                installedIds: current.map((app) => app.id),
                              })
                            }
                          >
                            Continue <IconArrowRight size={18} aria-hidden="true" />
                          </Button>
                          {tools('media', 'Media library')}
                        </div>
                      </>,
                    )
                  : null}
                {cards.map(({ category, title, apps }) =>
                  card(
                    category,
                    <>
                      <StoreCollectionArt apps={apps} kind={category} reduced={reduceMotion} visible={visible} />
                      <div className="orbis-store-collection-content">
                        <h3>{title}</h3>
                        <ul className="orbis-store-recommendation-apps">
                          <AnimatePresence initial={false} mode="popLayout">
                            {apps.map((app) => (
                              <RecommendationRow
                                key={app.urn}
                                {...suggestionItemMotion(reduceMotion, visible)}
                                layout="position"
                                className="orbis-store-recommendation-app"
                                data-recommendation-key={app.urn}
                              >
                                <span>
                                  <strong>{app.name}</strong>
                                  {app.short_desc ? <span className="orbis-store-recommendation-description">{app.short_desc}</span> : null}
                                </span>
                                <Link
                                  ref={preview?.onCardMount}
                                  className="orbis-store-collection-link orbis-store-recommendation-preview"
                                  data-recommendation-primary
                                  aria-label={`Preview ${app.name}`}
                                  to={`/app-store/${encodeURIComponent(app.urn.split(':')[1] ?? '')}/${encodeURIComponent(app.id)}${location.search}`}
                                  state={nextStorePreviewHistory(
                                    location.state as StorePreviewHistory | null,
                                    location.search,
                                    location.pathname.startsWith('/app-store/'),
                                  )}
                                  preventScrollReset
                                  data-store-app={app.urn}
                                  aria-controls={preview?.split ? 'store-app-preview' : undefined}
                                  aria-expanded={preview?.split ? preview.selectedUrn === app.urn : undefined}
                                >
                                  Preview <IconArrowRight size={18} aria-hidden="true" />
                                </Link>
                              </RecommendationRow>
                            ))}
                          </AnimatePresence>
                        </ul>
                        <Button
                          type="button"
                          className="orbis-store-collection-action orbis-store-recommendation-browse"
                          data-recommendation-primary
                          onClick={() => onBrowse(category)}
                        >
                          Browse {title} <IconArrowRight size={18} aria-hidden="true" />
                        </Button>
                        {tools(category, title)}
                      </div>
                    </>,
                  ),
                )}
              </AnimatePresence>
            </motion.div>
          </RecommendationSurface>
        ) : null}
      </AnimatePresence>
      {review ? (
        <StoreStackReview
          installedIds={review.installedIds}
          resolved={review.resolved}
          existingPlayer={review.existingPlayer}
          existingClient={review.existingClient}
          onClose={() => setReview(null)}
        />
      ) : null}
    </>
  );
}

export function StoreCollectionArt({
  apps,
  kind,
  reduced = false,
  visible = true,
}: {
  apps: AppInfoSimple[];
  kind: AppCategory;
  reduced?: boolean;
  visible?: boolean;
}) {
  if (!apps.length) return null;
  return (
    <div
      className="orbis-store-collection-art"
      data-collection-kind={kind}
      data-art-count={Math.min(apps.length, 6)}
      data-stack-grid={kind === 'media' || apps.length > 1 ? '' : undefined}
      aria-hidden="true"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {apps.slice(0, 6).map((app, index) => (
          <motion.span {...suggestionItemMotion(reduced, visible)} className="orbis-store-artwork-motion" data-art-position={index} key={app.urn}>
            <span className="orbis-store-artwork-app" data-art-position={index}>
              <AppLogo urn={app.urn} size={128} />
            </span>
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}
