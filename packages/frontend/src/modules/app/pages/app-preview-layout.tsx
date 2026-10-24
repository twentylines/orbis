import { DelayedRouteLoading } from '@/desktop/route-loading';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useDesktopWindows } from '@/desktop/window-viewport';
import { useWindowVisible, WindowVisibilityContext } from '@/desktop/window-visibility';
import { IconX } from '@tabler/icons-react';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Suspense, useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Outlet, useLocation, useNavigate } from 'react-router';
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
  const content = useRef<HTMLDivElement>(null);
  const previous = useRef<string | null>(null);
  const scroll = useRef(0);
  const motion = useRef<Animation | null>(null);

  const close = useCallback(() => {
    const depth = installed ? appsPreviewDepth(state) : storePreviewDepth(state);
    const index = window.history.state?.idx;
    if (depth > 0 && typeof index === 'number' && index >= depth) void navigate(-depth);
    else void navigate(closePath, { replace: true, preventScrollReset: true });
  }, [closePath, installed, navigate, state]);
  const nextHistory = () =>
    installed
      ? nextAppsPreviewHistory(state, location.search, Boolean(selected))
      : nextStorePreviewHistory(state, location.search, Boolean(selected));

  useLayoutEffect(() => {
    if (split && catalogue.current) catalogue.current.scrollTop = scroll.current;
  }, [split]);

  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = selected;
    motion.current?.cancel();
    motion.current = null;
    if (!selected) {
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
    const element = content.current;
    if (!element || prefersReducedMotion()) return;
    const opening = !last;
    const animation = element.animate(
      [
        { opacity: 0, transform: `translateX(${split ? 18 : 12}px)` },
        { opacity: 1, transform: 'none' },
      ],
      { delay: split && opening ? 140 : 70, duration: 210, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards' },
    );
    motion.current = animation;
    return () => animation.cancel();
  }, [selected, split]);

  return (
    <StorePreviewContext.Provider value={{ closePath, split, selectedUrn: selected, previewId, close, nextHistory }}>
      <div
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
        <aside id={previewId} className="store-app-preview" aria-label="App preview" hidden={!split && !selected}>
          <div className="store-preview-surface" aria-hidden="true" />
          {selected ? (
            <div ref={content} className="store-preview-content">
              {split ? (
                <button type="button" className="store-preview-close" aria-label="Close app preview" onClick={close}>
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
                    <Suspense fallback={<DelayedRouteLoading label="Loading app…" />}>
                      <Outlet />
                    </Suspense>
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
