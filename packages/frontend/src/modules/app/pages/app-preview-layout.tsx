import { PaneScrollProgress } from '@/components/pane-scroll-progress';
import { DelayedRouteLoading } from '@/desktop/route-loading';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { revealPageFocus, useDesktopWindows } from '@/desktop/window-viewport';
import { useWindowVisible, WindowVisibilityContext } from '@/desktop/window-visibility';
import { IconArrowLeft, IconX } from '@tabler/icons-react';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { useLocation, useNavigate, useOutlet } from 'react-router';
import { StorePreviewContext } from './store-preview-context';
import {
  appsPreviewDepth,
  appsReturnPath,
  nextAppsPreviewHistory,
  nextStorePreviewHistory,
  storePreviewDepth,
  storePreviewSuggestion,
  storeReturnPath,
  type AppPreviewHistory,
} from './store-preview-navigation';
import { animatePreviewTiles, capturePreviewTiles, previewPaneMotion, type PreviewSnapshot } from './preview-motion';
import './store-preview.css';
import { resolvePreviewCard } from './preview-card-anchor';

function alignCatalogueCard(catalogue: HTMLElement, card: HTMLElement, previousTop?: number) {
  const viewport = catalogue.getBoundingClientRect();
  const box = card.getBoundingClientRect();
  const top = box.top - viewport.top;
  const wanted = Math.max(8, Math.min(previousTop ?? top, viewport.height - box.height - 8));
  catalogue.scrollTop += top - wanted;
}

export function AppPreviewLayout({ source, selected, children }: { source: 'store' | 'installed'; selected: string | null; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const split = useDesktopWindows();
  const visible = useWindowVisible();
  const state = location.state as AppPreviewHistory | null;
  const installed = source === 'installed';
  const suggestion = installed ? null : storePreviewSuggestion(state, selected);
  const editing = installed && /\/edit(?:\/|$)/.test(location.pathname);
  const detailsPath = editing ? `${location.pathname.split('/edit')[0]}${location.search}` : null;
  const closePath = installed ? appsReturnPath(state, location.search) : storeReturnPath(state, location.search);
  const previewId = installed ? 'installed-app-preview' : 'store-app-preview';
  const catalogue = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const outlet = useOutlet();
  const currentOutlet = useRef(outlet);
  const [retained, setRetained] = useState<ReactNode>(null);
  const [panelView, setPanelView] = useState<{ title: string; content: ReactNode; path: string } | null>(null);
  const panelOpener = useRef<HTMLElement | null>(null);
  const returningToDetails = useRef(false);
  const onDetailsMount = useCallback((element: HTMLDivElement | null) => {
    if (!returningToDetails.current || !element || element.closest('[hidden],[inert]')) return;
    const trigger = element.querySelector<HTMLButtonElement>('button.more-button');
    if (trigger) {
      returningToDetails.current = false;
      trigger.focus();
    }
  }, []);
  const closePanel = useCallback(() => {
    setPanelView(null);
    requestAnimationFrame(() => {
      if (panelOpener.current?.isConnected && !panelOpener.current.closest('[inert],[hidden]')) panelOpener.current.focus({ preventScroll: true });
    });
  }, []);
  useLayoutEffect(() => {
    if (panelView && panelView.path !== location.pathname) setPanelView(null);
  }, [location.pathname, panelView]);
  useLayoutEffect(() => {
    if (panelView) pane.current?.querySelector<HTMLElement>('.app-settings-preview > h2')?.focus({ preventScroll: true });
  }, [panelView]);
  const snapshot = useRef<PreviewSnapshot>([]);
  const anchor = useRef<{ urn: string; top: number; element: HTMLElement } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const suggestionKind = installed ? undefined : (suggestion?.kind ?? null);
  const selection = useMemo(() => ({ urn: selected, suggestionKind }), [selected, suggestionKind]);
  const alignedSelection = useRef<typeof selection | null>(null);
  const paneBounds = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const tileMotion = useRef<Animation[]>([]);
  const onCardMount = useCallback(
    (card: HTMLAnchorElement | null) => {
      // Composed link refs can reattach on unrelated workspace renders.
      if (!split || !selection.urn || alignedSelection.current === selection || anchor.current || card?.dataset.storeApp !== selection.urn) return;
      if (selection.suggestionKind !== undefined && (card.dataset.storeSuggestion ?? null) !== selection.suggestionKind) return;
      const catalogue = card.closest<HTMLElement>('.store-catalogue-pane');
      if (!catalogue) return;
      alignCatalogueCard(catalogue, card);
      alignedSelection.current = selection;
    },
    [selection, split],
  );
  const capture = useCallback(
    (target?: Element | null) => {
      const clicked = target?.closest<HTMLElement>('[data-store-app]');
      if (clicked) opener.current = clicked;
      if (!split || !catalogue.current || !pane.current) return;
      const link = clicked ?? (selected ? resolvePreviewCard(catalogue.current, selected, opener.current, suggestionKind) : null);
      const urn = link?.dataset.storeApp;
      anchor.current =
        link && urn ? { urn, top: link.getBoundingClientRect().top - catalogue.current.getBoundingClientRect().top, element: link } : null;
      snapshot.current = capturePreviewTiles(catalogue.current);
      paneBounds.current = {
        left: pane.current.offsetLeft,
        top: pane.current.offsetTop,
        width: pane.current.offsetWidth,
        height: pane.current.offsetHeight,
      };
    },
    [selected, split, suggestionKind],
  );
  const previous = useRef<string | null>(null);
  const previousSuggestionKind = useRef(suggestionKind);
  const scroll = useRef(0);
  const motion = useRef<Animation | null>(null);

  const close = useCallback(() => {
    capture();
    const depth = installed ? appsPreviewDepth(state) : storePreviewDepth(state);
    const index = window.history.state?.idx;
    if (depth > 0 && typeof index === 'number' && index >= depth) void navigate(-depth);
    else void navigate(closePath, { replace: true, preventScrollReset: true });
  }, [capture, closePath, installed, navigate, state]);
  const nextHistory = () =>
    installed
      ? nextAppsPreviewHistory(state, location.search, Boolean(selected))
      : nextStorePreviewHistory(state, location.search, Boolean(selected), suggestion);

  useEffect(() => {
    const captureHistory = () => capture();
    window.addEventListener('popstate', captureHistory);
    return () => window.removeEventListener('popstate', captureHistory);
  }, [capture]);

  useLayoutEffect(() => {
    currentOutlet.current = outlet;
  });

  useLayoutEffect(() => {
    if (selected) setRetained(currentOutlet.current);
  }, [selected]);

  useEffect(
    () => () => {
      motion.current?.cancel();
      for (const animation of tileMotion.current) animation.cancel();
    },
    [],
  );

  useLayoutEffect(() => {
    if (split && catalogue.current) catalogue.current.scrollTop = scroll.current;
    const active = document.activeElement;
    if (active instanceof HTMLElement && pane.current?.contains(active)) {
      const frame = requestAnimationFrame(() => {
        if (active === document.activeElement && !active.closest('[hidden],[inert]')) revealPageFocus(active);
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [split]);

  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = selected;
    const lastSuggestionKind = previousSuggestionKind.current;
    const openerChanged = lastSuggestionKind !== suggestionKind;
    previousSuggestionKind.current = suggestionKind;
    if (last !== selected) returningToDetails.current = false;
    const movingPane =
      motion.current?.playState === 'running' && motion.current.effect instanceof KeyframeEffect && motion.current.effect.target === pane.current;
    const visual =
      movingPane && pane.current
        ? { opacity: getComputedStyle(pane.current).opacity, transform: getComputedStyle(pane.current).transform }
        : undefined;
    motion.current?.cancel();
    motion.current = null;
    for (const animation of tileMotion.current) animation.cancel();
    tileMotion.current = [];
    if (split && catalogue.current) {
      const reference = anchor.current;
      const urn = selected ?? reference?.urn;
      const target = urn
        ? resolvePreviewCard(catalogue.current, urn, reference?.element ?? opener.current, selected ? suggestionKind : lastSuggestionKind)
        : null;
      if (target && (!selected || reference || alignedSelection.current !== selection)) {
        alignCatalogueCard(catalogue.current, target, reference && reference.urn === urn ? reference.top : undefined);
        if (selected) alignedSelection.current = selection;
      }
    }
    anchor.current = null;
    if (split && snapshot.current.length && !prefersReducedMotion()) {
      const animations = animatePreviewTiles(snapshot.current);
      tileMotion.current = animations;
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        for (const animation of animations) animation.cancel();
        if (tileMotion.current === animations) tileMotion.current = [];
      });
    }
    snapshot.current = [];
    if (!selected) {
      if (split && last && pane.current && !prefersReducedMotion()) {
        const animation = previewPaneMotion(pane.current, false, visual);
        motion.current = animation;
        void animation.finished.then(
          () => setRetained(null),
          () => undefined,
        );
      } else setRetained(null);
      if (last && catalogue.current) {
        const target =
          resolvePreviewCard(catalogue.current, last, opener.current, lastSuggestionKind) ??
          catalogue.current.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), a[href], button:not([disabled])') ??
          document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"]');
        target?.focus({ preventScroll: true });
        if (target && catalogue.current.contains(target)) {
          const bounds = catalogue.current.getBoundingClientRect();
          const box = target.getBoundingClientRect();
          const above = box.top - bounds.top - 8;
          const below = box.bottom - bounds.bottom + 8;
          if (above < 0 || below > 0) {
            catalogue.current.scrollBy({ top: above < 0 ? above : below, behavior: 'instant' });
          }
        }
      }
      return;
    }
    const element = split && (!last || movingPane) ? pane.current : content.current;
    if (!element || prefersReducedMotion() || (last === selected && openerChanged && !movingPane)) return;
    const animation = previewPaneMotion(element, true, movingPane ? visual : undefined);
    motion.current = animation;
    void animation.finished.then(
      () => {
        animation.cancel();
        if (motion.current === animation) motion.current = null;
      },
      () => undefined,
    );
  }, [selected, selection, split, suggestionKind]);

  return (
    <StorePreviewContext.Provider
      value={{
        closePath,
        split,
        selectedUrn: selected,
        suggestion,
        onCardMount,
        onDetailsMount,
        previewId,
        close,
        nextHistory,
        closePanel,
        openPanel:
          installed && split
            ? (title, content) => {
                const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                const triggerId = active?.closest('[role="menu"]')?.getAttribute('aria-labelledby');
                panelOpener.current = triggerId ? document.getElementById(triggerId) : active;
                setPanelView({ title, content, path: location.pathname });
              }
            : undefined,
      }}
    >
      <div
        onClickCapture={(event) => {
          const target = (event.target as Element).closest('[data-store-app]');
          if (target) capture(target);
        }}
        className={`store-split-layout${split ? ' store-split-desktop' : ''}${installed ? ' installed-app-split' : ''}`}
        data-preview-open={selected ? 'true' : 'false'}
      >
        <div
          ref={catalogue}
          className="store-catalogue-pane"
          hidden={Boolean(selected && !split)}
          onScroll={() => {
            if (split && catalogue.current) scroll.current = catalogue.current.scrollTop;
          }}
        >
          <PaneScrollProgress label="App catalogue scroll position" enabled={split && visible} />
          <WindowVisibilityContext.Provider value={visible && (!selected || split)}>{children}</WindowVisibilityContext.Provider>
        </div>
        <aside
          ref={pane}
          id={previewId}
          className="store-app-preview"
          aria-label="App preview"
          hidden={!split && !selected}
          inert={!selected}
          aria-hidden={!selected || undefined}
          style={split && !selected && retained && paneBounds.current ? { position: 'absolute', ...paneBounds.current, zIndex: 2 } : undefined}
        >
          <div className="store-preview-surface" aria-hidden="true" />
          {selected || (split && retained) ? (
            <div ref={content} className="store-preview-content">
              <PaneScrollProgress label="App preview scroll position" enabled={split && visible && Boolean(selected)} />
              {split || editing || panelView ? (
                <button
                  type="button"
                  className={`store-preview-close${!split && editing ? ' store-preview-back' : ''}`}
                  aria-label={panelView || editing ? 'Back to app details' : 'Close app preview'}
                  onClick={
                    panelView
                      ? closePanel
                      : detailsPath
                        ? () => {
                            returningToDetails.current = true;
                            void navigate(detailsPath, { replace: true, preventScrollReset: true, state: location.state });
                          }
                        : close
                  }
                >
                  {!split && editing ? (
                    <>
                      <IconArrowLeft size={20} aria-hidden="true" />
                      <span>App details</span>
                    </>
                  ) : (
                    <IconX size={20} aria-hidden="true" />
                  )}
                </button>
              ) : null}
              <QueryErrorResetBoundary>
                {({ reset }) => (
                  <ErrorBoundary
                    resetKeys={[selected]}
                    onReset={reset}
                    fallbackRender={({ resetErrorBoundary }) => (
                      <div className="store-preview-error" role="alert">
                        <p>App details could not be loaded.</p>
                        <button type="button" onClick={resetErrorBoundary}>
                          Retry
                        </button>
                        {split ? null : (
                          <button type="button" onClick={close}>
                            Back to {installed ? 'Apps' : 'Store'}
                          </button>
                        )}
                      </div>
                    )}
                  >
                    <div
                      key={editing ? 'configuration' : 'details'}
                      className="store-preview-page"
                      hidden={Boolean(panelView)}
                      inert={Boolean(panelView)}
                    >
                      <Suspense fallback={<DelayedRouteLoading label="Loading app…" />}>{selected ? outlet : retained}</Suspense>
                    </div>
                    {panelView ? (
                      <section className="app-settings-preview store-preview-page">
                        <h2 tabIndex={-1}>{panelView.title}</h2>
                        {panelView.content}
                      </section>
                    ) : null}
                  </ErrorBoundary>
                )}
              </QueryErrorResetBoundary>
            </div>
          ) : null}
        </aside>
      </div>
    </StorePreviewContext.Provider>
  );
}
