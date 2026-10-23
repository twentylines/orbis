import { DelayedRouteLoading } from '@/desktop/route-loading';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useDesktopWindows } from '@/desktop/window-viewport';
import { IconX } from '@tabler/icons-react';
import { Suspense, useCallback, useLayoutEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router';
import AppStorePage, { AppStorePageSuspense } from './app-store-page';
import { StorePreviewContext } from './store-preview-context';
import { storePreviewDepth, storeReturnPath, type StorePreviewHistory } from './store-preview-navigation';
import './store-preview.css';

export default function AppStoreLayout() {
  const { appId, storeId } = useParams<{ appId: string; storeId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const split = useDesktopWindows();
  const selected = appId && storeId ? `${appId}:${storeId}` : null;
  const state = location.state as StorePreviewHistory | null;
  const closePath = storeReturnPath(state, location.search);
  const catalogue = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previous = useRef<string | null>(null);
  const scroll = useRef(0);
  const motion = useRef<Animation[]>([]);

  const close = useCallback(() => {
    const depth = storePreviewDepth(state);
    const index = window.history.state?.idx;
    if (depth > 0 && typeof index === 'number' && index >= depth) void navigate(-depth);
    else void navigate(closePath, { replace: true, preventScrollReset: true });
  }, [closePath, navigate, state]);

  useLayoutEffect(() => {
    if (split && catalogue.current) catalogue.current.scrollTop = scroll.current;
  }, [split]);

  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = selected;
    for (const animation of motion.current) animation.cancel();
    motion.current = [];
    if (!selected) {
      if (last && catalogue.current) {
        const target = catalogue.current.querySelector<HTMLAnchorElement>(`[data-store-app="${CSS.escape(last)}"]`);
        target?.focus({ preventScroll: true });
      }
      return;
    }
    const element = content.current;
    if (!element || prefersReducedMotion()) return;
    const opening = !last;
    const entry = split && opening ? 160 : 80;
    const animation = element.animate(
      [
        { opacity: 0, transform: `translateX(${split ? 18 : 12}px)` },
        { opacity: 1, transform: 'none' },
      ],
      {
        delay: entry,
        duration: 240,
        easing: 'cubic-bezier(.22, 1, .36, 1)',
        fill: 'backwards',
      },
    );
    motion.current.push(animation);
    return () => {
      animation.cancel();
    };
  }, [selected, split]);

  return (
    <StorePreviewContext.Provider value={{ closePath, split, selectedUrn: selected, close }}>
      <div className={`store-split-layout${split ? ' store-split-desktop' : ''}`} data-preview-open={selected ? 'true' : 'false'}>
        <div
          ref={catalogue}
          className="store-catalogue-pane"
          hidden={Boolean(selected && !split)}
          onScroll={() => {
            if (split && catalogue.current) scroll.current = catalogue.current.scrollTop;
          }}
        >
          <Suspense fallback={<AppStorePageSuspense />}>
            <AppStorePage />
          </Suspense>
        </div>
        <aside ref={pane} id="store-app-preview" className="store-app-preview" aria-label="App preview" hidden={!split && !selected}>
          <div className="store-preview-surface" aria-hidden="true" />
          {selected ? (
            <div ref={content} className="store-preview-content">
              {split ? (
                <button ref={closeButton} type="button" className="store-preview-close" aria-label="Close app preview" onClick={close}>
                  <IconX size={20} aria-hidden="true" />
                </button>
              ) : null}
              <Suspense fallback={<DelayedRouteLoading label="Loading app…" />}>
                <Outlet />
              </Suspense>
            </div>
          ) : null}
        </aside>
      </div>
    </StorePreviewContext.Provider>
  );
}
