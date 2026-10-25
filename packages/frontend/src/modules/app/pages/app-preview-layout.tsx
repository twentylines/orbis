import { DelayedRouteLoading } from '@/desktop/route-loading';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useDesktopWindows } from '@/desktop/window-viewport';
import { useWindowVisible, WindowVisibilityContext } from '@/desktop/window-visibility';
import { IconX } from '@tabler/icons-react';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { useLocation, useNavigate, useOutlet } from 'react-router';
import { StorePreviewContext } from './store-preview-context';
import {
  appsPreviewDepth,
  appsReturnPath,
  nextAppsPreviewHistory,
  nextStorePreviewHistory,
  storePreviewDepth,
  storeReturnPath,
  type AppPreviewHistory,
} from './store-preview-navigation';
import { animatePreviewTiles, capturePreviewTiles, previewPaneMotion, type PreviewSnapshot } from './preview-motion';
import './store-preview.css';

export function AppPreviewLayout({ source, selected, children }: { source: 'store' | 'installed'; selected: string | null; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const split = useDesktopWindows();
  const visible = useWindowVisible();
  const state = location.state as AppPreviewHistory | null;
  const installed = source === 'installed';
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
  const paneBounds = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const tileMotion = useRef<Animation[]>([]);
  const capture = useCallback(() => {
    if (!split || !catalogue.current || !pane.current) return;
    snapshot.current = capturePreviewTiles(catalogue.current);
    paneBounds.current = {
      left: pane.current.offsetLeft,
      top: pane.current.offsetTop,
      width: pane.current.offsetWidth,
      height: pane.current.offsetHeight,
    };
  }, [split]);
  const previous = useRef<string | null>(null);
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
      : nextStorePreviewHistory(state, location.search, Boolean(selected));

  useEffect(() => {
    window.addEventListener('popstate', capture);
    return () => window.removeEventListener('popstate', capture);
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
  }, [split]);

  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = selected;
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
          catalogue.current.querySelector<HTMLElement>(`[data-store-app="${CSS.escape(last)}"]`) ??
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
    if (!element || prefersReducedMotion()) return;
    const animation = previewPaneMotion(element, true, movingPane ? visual : undefined);
    motion.current = animation;
    void animation.finished.then(
      () => {
        animation.cancel();
        if (motion.current === animation) motion.current = null;
      },
      () => undefined,
    );
  }, [selected, split]);

  return (
    <StorePreviewContext.Provider
      value={{
        closePath,
        split,
        selectedUrn: selected,
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
          if ((event.target as Element).closest('[data-store-app]')) capture();
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
              {split || panelView ? (
                <button
                  type="button"
                  className="store-preview-close"
                  aria-label={panelView ? 'Back to app details' : 'Close app preview'}
                  onClick={panelView ? closePanel : close}
                >
                  <IconX size={20} aria-hidden="true" />
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
                    <div hidden={Boolean(panelView)} inert={Boolean(panelView)}>
                      <Suspense fallback={<DelayedRouteLoading label="Loading app…" />}>{selected ? outlet : retained}</Suspense>
                    </div>
                    {panelView ? (
                      <section className="app-settings-preview">
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
