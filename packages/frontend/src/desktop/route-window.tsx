import {
  Suspense,
  lazy,
  useEffect,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type PropsWithChildren,
  type RefObject,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { DesktopWindowBounds, DesktopWindowId, DesktopWindowState } from '@runtipi/common/schemas';
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconArrowsMove,
  IconLayout,
  IconLayoutSidebar,
  IconLayoutSidebarRight,
  IconMinus,
  IconResize,
  IconWindow,
  IconX,
} from '@tabler/icons-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { useDesktopPreferences } from './preferences';
import { canSnapWindow, clampWindowBounds, defaultWindowBounds, placedWindowBounds, type WindowArea } from './window-geometry';
import { WindowVisibilityContext } from './window-visibility';
import './route-window.css';
import { isWindowMinimized, windowSearch } from './window-navigation';

const Dashboard = lazy(() => import('@/modules/dashboard/pages/dashboard'));
export type RouteWindowControls = { minimize: () => void };
const dockBounds = (id: DesktopWindowId) =>
  document.querySelector(`.desktop-dock-item[href^="/${id}"]`)?.getBoundingClientRect() ??
  document.querySelector('.desktop-dock')?.getBoundingClientRect();

type Gesture = {
  kind: 'move' | 'resize';
  bounds: DesktopWindowBounds;
  pointer: { id: number; x: number; y: number } | null;
};
type Props = PropsWithChildren<{
  id: DesktopWindowId;
  label: string;
  icon: React.ReactNode;
  controlsRef: RefObject<RouteWindowControls | null>;
}>;

export function RouteWindow({ id, label, icon, children, controlsRef }: Props) {
  const { preferences, updateWindow } = useDesktopPreferences();
  const location = useLocation();
  const navigate = useNavigate();
  const minimized = isWindowMinimized(location.search);
  const frame = useRef<HTMLDivElement>(null);
  const titlebar = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<WindowArea>({ x: 32, y: 112, width: 960, height: 640 });
  const [desktop, setDesktop] = useState(false);
  const [draft, setDraft] = useState<DesktopWindowState | null>(null);
  const [keyboardMode, setKeyboardMode] = useState<Gesture['kind'] | null>(null);
  const [hiding, setHiding] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const latestDraft = useRef<DesktopWindowState | null>(null);
  const pendingFrame = useRef<number | null>(null);
  const motion = useRef<Animation | null>(null);
  const wasMinimized = useRef(minimized);
  const saved = preferences.windows[id];
  const state: DesktopWindowState = draft ?? saved ?? { mode: 'focused', bounds: defaultWindowBounds(area) };
  const mode = desktop ? state.mode : 'focused';
  const positioned = mode !== 'focused';
  const rect = placedWindowBounds(mode, state.bounds, area);
  const cancelGesture = useCallback(() => {
    gesture.current = null;
    latestDraft.current = null;
    if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
    pendingFrame.current = null;
    setDraft(null);
    setKeyboardMode(null);
  }, []);

  useLayoutEffect(() => {
    const measure = () => {
      cancelGesture();
      const bar = document.querySelector<HTMLElement>('.desktop-system-bar');
      const dock = document.querySelector<HTMLElement>('.desktop-dock');
      const x = bar?.offsetLeft ?? 24;
      const y = Math.ceil((bar ? Number.parseFloat(getComputedStyle(bar).top) + bar.offsetHeight : 88) + 20);
      const dockTop = dock?.offsetHeight
        ? window.innerHeight - Number.parseFloat(getComputedStyle(dock).bottom) - dock.offsetHeight
        : window.innerHeight - 100;
      setDesktop(window.innerWidth >= 900 && window.innerHeight >= 540);
      setArea({
        x,
        y,
        width: Math.floor(window.innerWidth - x * 2),
        height: Math.max(200, Math.floor(dockTop - y - 20)),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [cancelGesture]);

  useEffect(
    () => () => {
      motion.current?.cancel();
      if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
    },
    [],
  );

  const changeDraft = (next: DesktopWindowState) => {
    latestDraft.current = next;
    if (pendingFrame.current !== null) return;
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = null;
      setDraft(latestDraft.current);
    });
  };
  const finishGesture = (commit: boolean) => {
    if (!gesture.current) return;
    if (commit && latestDraft.current) updateWindow(id, latestDraft.current);
    cancelGesture();
  };
  useEffect(() => {
    if (minimized) cancelGesture();
  }, [minimized, cancelGesture]);

  const place = (nextMode: DesktopWindowState['mode']) => {
    finishGesture(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
    updateWindow(id, {
      bounds: clampWindowBounds(state.bounds, area),
      mode: nextMode,
      ...(nextMode === 'maximized' ? { restoreMode: state.mode === 'maximized' ? (state.restoreMode ?? 'focused') : state.mode } : {}),
    });
  };
  const maximize = () => place(state.mode === 'maximized' ? (state.restoreMode ?? 'focused') : 'maximized');
  const restore = () => navigate({ pathname: location.pathname, search: windowSearch(location.search, false), hash: location.hash });
  const minimize = async () => {
    if (minimized || hiding || gesture.current) return;
    const element = frame.current;
    const target = dockBounds(id);
    motion.current?.cancel();
    if (element && target && typeof element.animate === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const from = element.getBoundingClientRect();
      setHiding(true);
      const animation = element.animate(
        [
          { transform: 'none', opacity: 1 },
          {
            transform: `translate(${target.x + target.width / 2 - from.x - from.width / 2}px, ${target.y + target.height / 2 - from.y - from.height / 2}px) scale(.12)`,
            opacity: 0,
          },
        ],
        { duration: 240, easing: 'cubic-bezier(.4, 0, .6, 1)' },
      );
      motion.current = animation;
      try {
        await animation.finished;
      } catch {
        setHiding(false);
        return;
      }
      if (motion.current !== animation) return;
      motion.current = null;
      setHiding(false);
    }
    navigate({ pathname: location.pathname, search: windowSearch(location.search, true), hash: location.hash });
  };
  useImperativeHandle(controlsRef, () => ({ minimize }));

  useLayoutEffect(() => {
    if (wasMinimized.current && !minimized && frame.current) {
      titlebar.current?.focus({ preventScroll: true });
      const from = dockBounds(id);
      const to = frame.current.getBoundingClientRect();
      if (from && typeof frame.current.animate === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        motion.current = frame.current.animate(
          [
            {
              transform: `translate(${from.x + from.width / 2 - to.x - to.width / 2}px, ${from.y + from.height / 2 - to.y - to.height / 2}px) scale(.12)`,
              opacity: 0,
            },
            { transform: 'none', opacity: 1 },
          ],
          { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' },
        );
      }
    }
    wasMinimized.current = minimized;
  }, [minimized, id]);

  const beginPointer = (event: PointerEvent<HTMLDivElement | HTMLButtonElement>, kind: Gesture['kind']) => {
    if (!desktop || event.button !== 0 || (kind === 'move' && (!positioned || (event.target as HTMLElement).closest('button, a, [role=menuitem]'))))
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = state.mode === 'floating' ? rect : defaultWindowBounds(area);
    const next = { ...state, mode: 'floating' as const, bounds };
    gesture.current = { kind, bounds, pointer: { id: event.pointerId, x: event.clientX, y: event.clientY } };
    latestDraft.current = next;
    setDraft(next);
    setKeyboardMode(null);
  };
  const movePointer = (event: PointerEvent) => {
    const active = gesture.current;
    if (!active?.pointer || active.pointer.id !== event.pointerId) return;
    const dx = event.clientX - active.pointer.x;
    const dy = event.clientY - active.pointer.y;
    const bounds =
      active.kind === 'move'
        ? { ...active.bounds, x: active.bounds.x + dx, y: active.bounds.y + dy }
        : {
            ...active.bounds,
            width: Math.min(area.x + area.width - active.bounds.x, active.bounds.width + dx),
            height: Math.min(area.y + area.height - active.bounds.y, active.bounds.height + dy),
          };
    changeDraft({ ...state, mode: 'floating', bounds: clampWindowBounds(bounds, area) });
  };
  const endPointer = (event: PointerEvent, commit: boolean) => {
    if (gesture.current?.pointer?.id !== event.pointerId) return;
    finishGesture(commit);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const beginKeyboard = (kind: Gesture['kind']) => {
    const bounds = state.mode === 'floating' ? rect : defaultWindowBounds(area);
    gesture.current = { kind, bounds, pointer: null };
    latestDraft.current = { ...state, mode: 'floating', bounds };
    setDraft(latestDraft.current);
    setKeyboardMode(kind);
    requestAnimationFrame(() => titlebar.current?.focus({ preventScroll: true }));
  };
  const adjustKeyboard = (event: KeyboardEvent) => {
    const active = gesture.current;
    if (!active || active.pointer) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const buttons = Array.from(titlebar.current?.querySelectorAll<HTMLButtonElement>('.desktop-window-controls button:not(:disabled)') ?? []);
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      const next = index < 0 ? 0 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finishGesture(event.key === 'Enter');
      return;
    }
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 10;
    const dx = (direction[0] ?? 0) * step;
    const dy = (direction[1] ?? 0) * step;
    const before = latestDraft.current?.bounds ?? active.bounds;
    const bounds =
      active.kind === 'move'
        ? { ...before, x: before.x + dx, y: before.y + dy }
        : {
            ...before,
            width: Math.min(area.x + area.width - before.x, before.width + dx),
            height: Math.min(area.y + area.height - before.y, before.height + dy),
          };
    changeDraft({ ...state, mode: 'floating', bounds: clampWindowBounds(bounds, area) });
  };

  return (
    <>
      {minimized ? (
        <div className="desktop-view desktop-view-home">
          <div className="desktop-window-resume">
            <span>{label} is minimized</span>
            <button type="button" onClick={restore}>
              <IconWindow size={18} aria-hidden="true" />
              Restore {label}
            </button>
          </div>
          <Suspense fallback={<output className="workspace-message">Opening workspace…</output>}>
            <Dashboard focusOnMount />
          </Suspense>
        </div>
      ) : null}
      <div
        ref={frame}
        className="desktop-view desktop-view-app desktop-route-window"
        data-window-mode={mode}
        data-window-positioned={positioned}
        data-window-minimized={minimized}
        hidden={minimized}
        inert={minimized || hiding}
        style={positioned ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : undefined}
      >
        <div
          ref={titlebar}
          role="toolbar"
          className="desktop-window-bar"
          tabIndex={-1}
          aria-label={`${label} window`}
          aria-describedby={keyboardMode ? 'window-keyboard-help' : undefined}
          onPointerDown={(event) => beginPointer(event, 'move')}
          onPointerMove={movePointer}
          onPointerUp={(event) => endPointer(event, true)}
          onPointerCancel={(event) => endPointer(event, false)}
          onLostPointerCapture={() => finishGesture(false)}
          onDoubleClick={(event) => {
            if (desktop && !(event.target as HTMLElement).closest('button, a')) maximize();
          }}
          onKeyDown={adjustKeyboard}
          onBlur={(event) => {
            if (keyboardMode && !event.currentTarget.contains(event.relatedTarget as Node | null)) finishGesture(true);
          }}
        >
          <span className="desktop-window-icon" aria-hidden="true">
            {icon}
          </span>
          <div className="desktop-window-label">
            <h1>{label}</h1>
            <span title={preferences.serverName}>{preferences.serverName}</span>
          </div>
          <div className="desktop-window-controls">
            {desktop ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="desktop-window-control" aria-label="Window layout" title="Window layout">
                    <IconLayout size={18} aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(event) => {
                    if (gesture.current) event.preventDefault();
                  }}
                >
                  <DropdownMenuLabel>Window layout</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => place('focused')}>
                    <IconWindow size={18} aria-hidden="true" />
                    Full page
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => place('floating')}>
                    <IconWindow size={18} aria-hidden="true" />
                    Floating window
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!canSnapWindow(area)} onSelect={() => place('left')}>
                    <IconLayoutSidebar size={18} aria-hidden="true" />
                    Snap left
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!canSnapWindow(area)} onSelect={() => place('right')}>
                    <IconLayoutSidebarRight size={18} aria-hidden="true" />
                    Snap right
                  </DropdownMenuItem>
                  {canSnapWindow(area) ? null : <p className="desktop-window-menu-hint">Snapping needs room for two 520px windows.</p>}
                  <DropdownMenuItem onSelect={() => beginKeyboard('move')}>
                    <IconArrowsMove size={18} aria-hidden="true" />
                    Move with keyboard
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => beginKeyboard('resize')}>
                    <IconResize size={18} aria-hidden="true" />
                    Resize with keyboard
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <button
              type="button"
              className="desktop-window-control"
              aria-label={`Minimize ${label}`}
              title="Minimize"
              disabled={hiding}
              onClick={() => void minimize()}
            >
              <IconMinus size={18} aria-hidden="true" />
            </button>
            {desktop ? (
              <button
                type="button"
                className="desktop-window-control"
                aria-label={mode === 'maximized' ? `Restore ${label} size` : `Maximize ${label}`}
                title={mode === 'maximized' ? 'Restore size' : 'Maximize'}
                onClick={maximize}
              >
                {mode === 'maximized' ? <IconArrowsMinimize size={18} aria-hidden="true" /> : <IconArrowsMaximize size={18} aria-hidden="true" />}
              </button>
            ) : null}
            <button
              type="button"
              className="desktop-window-control desktop-window-dismiss"
              aria-label={`Close ${label}`}
              title="Close and return to workspace"
              onClick={() => navigate('/dashboard')}
            >
              <IconX size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
        {keyboardMode ? (
          <output id="window-keyboard-help" className="desktop-window-keyboard-help">
            {keyboardMode === 'move' ? 'Move' : 'Resize'}: arrow keys · Shift for 1px · Enter to save · Esc to cancel
          </output>
        ) : null}
        <div className="desktop-window-content">
          <WindowVisibilityContext.Provider value={!minimized}>{children}</WindowVisibilityContext.Provider>
        </div>
        {desktop && mode === 'floating' ? (
          <button
            type="button"
            className="desktop-window-resize"
            aria-label={`Resize ${label}`}
            title="Drag to resize, or press Enter for keyboard controls"
            onPointerDown={(event) => beginPointer(event, 'resize')}
            onPointerMove={movePointer}
            onPointerUp={(event) => endPointer(event, true)}
            onPointerCancel={(event) => endPointer(event, false)}
            onLostPointerCapture={() => finishGesture(false)}
            onClick={(event) => {
              if (event.detail === 0) beginKeyboard('resize');
            }}
          >
            <IconResize size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </>
  );
}
