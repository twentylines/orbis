import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconArrowsMove,
  IconExternalLink,
  IconLayoutColumns,
  IconLayoutSidebar,
  IconLayoutSidebarRight,
  IconMinus,
  IconResize,
  IconSettings,
  IconWindow,
  IconHelp,
  IconX,
} from '@tabler/icons-react';
import { lazy, memo, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import type { DesktopWindowBounds } from '@runtipi/common/schemas';
import { useAppWindowGeometry } from './app-window-geometry';
import { canSplitAppWindows, splitAppBounds, type AppWindowMode, type ResizeEdge } from './app-window-layout';
import type { AppWindow as WindowState } from './app-window-state';
import type { WindowArea } from './window-geometry';
import { prefersReducedMotion } from './motion-setting';
import { dockMotionDuration, sectionMotionTiming } from './section-motion-geometry';
import { useAppEmbedding } from './app-embedding';
import { useDesktopPreferences } from './preferences';
import { appEmbeddingBoundary, appEmbeddingWarning, type AppEmbeddingCheck } from './app-opening';
import { useWindowVisible } from './window-visibility';
import { appFlyoutAnchor, placeAppWindowFlyout, type AppFlyoutPoint, type AppFlyoutPosition } from './app-window-flyout';
import { appMinimizeCrossfade } from './app-window-transition';

const WindowSettings = lazy(() => import('./app-window-settings'));
const edges: ResizeEdge[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const edgeNames = { n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left', nw: 'top left' };
const rectStyle = (box: DesktopWindowBounds) => ({ left: box.x, top: box.y, width: box.width, height: box.height });

function useWindowFlyout(open: boolean, frame: HTMLElement | null, button: HTMLElement | null, anchor: AppFlyoutPoint | null) {
  const [content, attach] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<(AppFlyoutPosition & { alignOffset: number; sideOffset: number }) | null>(null);
  useLayoutEffect(() => {
    if (!open || !content || !frame || !button) return;
    const measure = () => {
      const bounds = frame.getBoundingClientRect();
      const trigger = button.getBoundingClientRect();
      const origin = anchor ?? appFlyoutAnchor(null, bounds, trigger);
      const next = placeAppWindowFlyout(bounds, origin, { width: content.offsetWidth, height: content.offsetHeight });
      const value = { ...next, alignOffset: bounds.left + next.left - trigger.left, sideOffset: bounds.top + next.top - trigger.bottom };
      setPosition((previous) => (JSON.stringify(previous) === JSON.stringify(value) ? previous : value));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(content);
    observer.observe(button);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [open, content, frame, button, anchor]);
  return { attach, position };
}

export function AppWindow({
  item,
  area,
  ratio,
  active,
  desktop,
  serverName,
  saved,
  origin,
  originOpacity,
  trayReady,
  trayTarget,
  trayElement,
  onPlace,
  onDetachChange,
  onFocus,
  onMinimize,
  onMinimized,
  onClose,
  onRemoved,
  onTab,
  onSave,
}: {
  item: WindowState;
  area: WindowArea;
  ratio: number;
  active: boolean;
  desktop: boolean;
  serverName: string;
  saved?: DesktopWindowBounds;
  origin?: DOMRect;
  originOpacity?: number;
  trayReady: boolean;
  trayTarget: () => DOMRect | undefined;
  trayElement: () => HTMLElement | undefined;
  onPlace: (mode: AppWindowMode) => void;
  onDetachChange: (detached: boolean) => void;
  onFocus: () => void;
  onMinimize: () => void;
  onMinimized: () => void;
  onClose: () => void;
  onRemoved: () => void;
  onTab: () => void;
  onSave: (bounds: DesktopWindowBounds) => void;
}) {
  const { request, status, mode } = item;
  const boundary = appEmbeddingBoundary(request.launchUrl, window.location.origin);
  const blocked = Boolean(boundary);
  const titleId = useId();
  const helpId = useId();
  const panel = useRef<HTMLDialogElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const layoutButton = useRef<HTMLButtonElement>(null);
  const helpButton = useRef<HTMLButtonElement>(null);
  const settingsClose = useRef<HTMLButtonElement>(null);
  const settingsHeading = useRef<HTMLHeadingElement>(null);
  const placementFrom = useRef<DOMRect | null>(null);
  const flightAnimation = useRef<Animation | null>(null);
  const departure = useRef<{ box: DOMRect; opacity: number } | null>(null);
  const [settings, setSettings] = useState(false);
  const [settingsSaveTarget, setSettingsSaveTarget] = useState<HTMLDivElement | null>(null);
  const [help, setHelp] = useState(false);
  const [helpAnchor, setHelpAnchor] = useState<AppFlyoutPoint | null>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [layoutAnchor, setLayoutAnchor] = useState<AppFlyoutPoint | null>(null);
  const layoutFlyout = useWindowFlyout(layoutOpen, panel.current, layoutButton.current, layoutAnchor);
  const openingSplit = useRef(false);
  const keyboardWindow = useRef(false);
  const capturePlacement = (next: AppWindowMode) => {
    placementFrom.current = panel.current?.getBoundingClientRect() ?? null;
    onPlace(next);
  };
  const geometry = useAppWindowGeometry({
    area,
    mode,
    ratio,
    saved,
    categories: request.categories,
    canSnap: !blocked,
    save: onSave,
    place: capturePlacement,
    onDetachChange,
  });
  const hidden = !desktop || status === 'minimized';
  const busy = status === 'minimizing' || status === 'closing';
  const flightReady = status !== 'minimizing' || trayReady;
  const motion = useRef({
    origin,
    trayTarget,
    trayElement,
    onMinimized,
    onRemoved,
    settings,
    mode,
    status,
    automatic: item.automatic,
    originOpacity,
    bounds: geometry.bounds,
  });
  motion.current = {
    origin,
    trayTarget,
    trayElement,
    onMinimized,
    onRemoved,
    settings,
    mode,
    status,
    automatic: item.automatic,
    originOpacity,
    bounds: geometry.bounds,
  };

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || hidden) return;
    if (settings) settingsHeading.current?.focus({ preventScroll: true });
  }, [settings, hidden]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || hidden || !flightReady) return;
    if (status === 'visible' && !motion.current.automatic)
      (motion.current.settings ? settingsHeading.current : bar.current)?.focus({ preventScroll: true });
    const end = status === 'minimizing' ? motion.current.trayTarget() : undefined;
    if (prefersReducedMotion()) {
      if (status === 'minimizing') motion.current.onMinimized();
      if (status === 'closing') motion.current.onRemoved();
      return;
    }
    const from = motion.current.origin;
    const start = motion.current.automatic ? (from ? { box: from, opacity: motion.current.originOpacity ?? 1 } : null) : departure.current;
    const box = element.getBoundingClientRect();
    const transformTo = (target: DOMRect) =>
      `translate(${target.x - box.x}px, ${target.y - box.y}px) scale(${target.width / box.width}, ${target.height / box.height})`;
    const frames =
      status === 'minimizing' && end
        ? [{ transform: start ? transformTo(start.box) : 'none' }, { transform: transformTo(end) }]
        : status === 'closing'
          ? [
              { transform: start ? transformTo(start.box) : 'none', opacity: start?.opacity ?? 1 },
              { transform: 'translateY(12px) scale(.985)', opacity: 0 },
            ]
          : from
            ? [
                { transform: transformTo(from), opacity: motion.current.originOpacity ?? 0.35 },
                { transform: 'none', opacity: 1 },
              ]
            : [
                { transform: 'translateY(12px)', opacity: 0.75 },
                { transform: 'none', opacity: 1 },
              ];
    const duration =
      status === 'closing'
        ? 240
        : status === 'minimizing' || motion.current.automatic
          ? dockMotionDuration
          : motion.current.mode === 'floating'
            ? sectionMotionTiming.surface
            : 300;
    const deadline = performance.now() + duration;
    const options = {
      duration,
      easing: status === 'closing' ? 'cubic-bezier(.4,0,.8,1)' : 'cubic-bezier(.2,.76,.22,1)',
      fill: 'both' as const,
    };
    let animation = element.animate(frames, options);
    const fades: Animation[] = [];
    if (status === 'minimizing') {
      const crossfade = appMinimizeCrossfade(start?.opacity ?? 1);
      const timing = { duration, easing: 'linear', fill: 'both' as const };
      const windowFade = element.animate(crossfade.window, timing);
      windowFade.id = 'orbis-app-minimize-fade';
      fades.push(windowFade);
      const icon = motion.current.trayElement()?.querySelector<HTMLElement>('.app-logo');
      if (icon) {
        const iconFade = icon.animate(crossfade.icon, timing);
        iconFade.id = 'orbis-app-tray-reveal';
        fades.push(iconFade);
      }
      const started = document.timeline.currentTime;
      if (started !== null) for (const item of [animation, ...fades]) item.startTime = started;
    }
    const complete = () => {
      if (status === 'minimizing' && motion.current.status === 'minimizing') motion.current.onMinimized();
      else if (status === 'closing' && motion.current.status === 'closing') motion.current.onRemoved();
      else animation.cancel();
    };
    const track = () => {
      flightAnimation.current = animation;
      animation.id = `orbis-app-${status === 'visible' ? 'open' : status}`;
      void animation.finished.then(complete, () => undefined);
    };
    track();
    let resizeFrame = 0;
    const retarget = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (animation.playState !== 'running') return;
        const start = element.getBoundingClientRect();
        const opacity = getComputedStyle(element).opacity;
        const base = motion.current.bounds;
        const end =
          status === 'minimizing'
            ? motion.current.trayTarget()
            : new DOMRect(base.x, base.y + (status === 'closing' ? 12 : 0), base.width, base.height);
        if (!end) return;
        const transform = (rect: DOMRect) =>
          `translate(${rect.x - base.x}px, ${rect.y - base.y}px) scale(${rect.width / base.width}, ${rect.height / base.height})`;
        animation.cancel();
        animation = element.animate(
          [
            { transform: transform(start), ...(status === 'minimizing' ? {} : { opacity }) },
            { transform: transform(end), ...(status === 'minimizing' ? {} : { opacity: status === 'closing' ? 0 : 1 }) },
          ],
          { ...options, duration: Math.max(80, deadline - performance.now()) },
        );
        track();
      });
    };
    window.addEventListener('resize', retarget);
    return () => {
      window.removeEventListener('resize', retarget);
      cancelAnimationFrame(resizeFrame);
      animation.cancel();
      for (const fade of fades) fade.cancel();
    };
  }, [status, hidden, flightReady]);

  const lastPlacement = useRef({ mode, area, bounds: geometry.bounds });
  const placementAnimation = useRef<Animation | null>(null);
  useLayoutEffect(
    () => () => {
      placementAnimation.current?.cancel();
    },
    [],
  );
  useLayoutEffect(() => {
    const before = lastPlacement.current;
    const next = geometry.bounds;
    lastPlacement.current = { mode, area, bounds: next };
    if (before.area !== area || geometry.gestureKind || status !== 'visible') {
      placementAnimation.current?.cancel();
      return;
    }
    if (before.mode === mode || hidden || !panel.current || prefersReducedMotion()) return;
    const from = placementFrom.current ?? new DOMRect(before.bounds.x, before.bounds.y, before.bounds.width, before.bounds.height);
    placementFrom.current = null;
    flightAnimation.current?.cancel();
    placementAnimation.current?.cancel();
    placementAnimation.current = panel.current.animate(
      [
        {
          transform: `translate(${from.x - next.x}px, ${from.y - next.y}px) scale(${from.width / next.width}, ${from.height / next.height})`,
        },
        { transform: 'none' },
      ],
      { duration: 300, easing: 'cubic-bezier(.2,.76,.22,1)' },
    );
  }, [mode, area, hidden, geometry.bounds, geometry.gestureKind, status]);

  const closeSettings = () => {
    setSettings(false);
    bar.current?.focus({ preventScroll: true });
  };
  const closeHelp = () => {
    setHelp(false);
    bar.current?.focus({ preventScroll: true });
  };
  const openHelp = () => {
    setSettings(false);
    setLayoutOpen(false);
    setHelp(true);
  };
  const depart = (action: () => void) => {
    const element = panel.current;
    departure.current = element ? { box: element.getBoundingClientRect(), opacity: Number(getComputedStyle(element).opacity) } : null;
    action();
  };
  const place = (next: AppWindowMode) => {
    placementFrom.current = panel.current?.getBoundingClientRect() ?? null;
    if (next === 'floating') geometry.restoreFloating();
    geometry.cancel();
    onPlace(next);
  };
  const preview = geometry.preview === 'maximized' ? area : geometry.preview ? splitAppBounds(geometry.preview, area, ratio) : null;
  return (
    <>
      {preview ? <div className="app-snap-preview" style={rectStyle(preview)} aria-hidden="true" /> : null}
      <dialog
        ref={panel}
        open={!hidden}
        aria-labelledby={titleId}
        aria-describedby={helpId}
        hidden={hidden}
        inert={hidden || busy || undefined}
        className="orbis-app-launcher"
        data-app-window={request.urn}
        data-mode={mode}
        data-active={active}
        data-gesturing={geometry.gestureKind || undefined}
        data-minimizing={status === 'minimizing'}
        data-closing={status === 'closing'}
        style={{ ...rectStyle(geometry.bounds), zIndex: active ? 46 : 45 }}
        onPointerDownCapture={onFocus}
        onFocusCapture={onFocus}
        onKeyDown={(event) => {
          geometry.keyboard(event);
          if (event.defaultPrevented || event.key !== 'Escape' || !active) return;
          if ((event.target as Element).closest('[role="menu"],[role="listbox"],.react-tooltip')) return;
          event.stopPropagation();
          if (settings) closeSettings();
          else if (help) closeHelp();
          else depart(onClose);
        }}
      >
        <span id={helpId} className="visually-hidden">
          Drag the title bar to move or snap. Resize from any edge or corner. Apps that block embedding need a new tab.
        </span>
        <div
          role="toolbar"
          aria-label="App window controls"
          className="app-launcher-bar"
          ref={bar}
          tabIndex={-1}
          data-focus-surface="parent"
          {...geometry.move}
          onDoubleClick={(event) => {
            if (!(event.target as HTMLElement).closest('button,a,select')) place(mode === 'maximized' ? 'floating' : 'maximized');
          }}
        >
          <div className="app-launcher-heading">
            <AppLogo urn={request.urn} url={request.logoUrl} size={28} />
            <div>
              <h2 id={titleId} title={request.name}>
                {request.name}
              </h2>
              <span title={request.serverName || serverName}>{request.serverName || serverName}</span>
            </div>
          </div>
          <div className="app-launcher-controls">
            <Button
              ref={helpButton}
              className="app-launcher-close app-window-help-button"
              aria-label="Page not working?"
              title="Page not working?"
              aria-expanded={help}
              onClick={(event) => {
                if (help) closeHelp();
                else {
                  if (panel.current)
                    setHelpAnchor(
                      appFlyoutAnchor(
                        event.detail ? { x: event.clientX, y: event.clientY } : null,
                        panel.current.getBoundingClientRect(),
                        event.currentTarget.getBoundingClientRect(),
                      ),
                    );
                  openHelp();
                }
              }}
            >
              <IconHelp size={20} aria-hidden="true" />
              <span>Page not working?</span>
            </Button>
            <Button
              ref={settingsButton}
              className="app-launcher-close"
              size="icon"
              aria-label="App settings"
              title="App settings"
              aria-expanded={settings}
              onClick={() => {
                setHelp(false);
                setSettings((value) => !value);
              }}
            >
              <IconSettings size={18} aria-hidden="true" />
            </Button>
            <DropdownMenu
              modal={false}
              open={layoutOpen}
              onOpenChange={(open) => {
                setLayoutOpen(open);
                if (open) setHelp(false);
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  ref={layoutButton}
                  className="app-launcher-close"
                  size="icon"
                  aria-label="Window layout"
                  title="Window layout"
                  onPointerDownCapture={(event) => {
                    if (event.button === 0 && panel.current)
                      setLayoutAnchor(
                        appFlyoutAnchor(
                          { x: event.clientX, y: event.clientY },
                          panel.current.getBoundingClientRect(),
                          event.currentTarget.getBoundingClientRect(),
                        ),
                      );
                  }}
                  onKeyDownCapture={(event) => {
                    if (['Enter', ' ', 'ArrowDown'].includes(event.key)) setLayoutAnchor(null);
                  }}
                >
                  <IconLayoutColumns size={19} aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="app-window-layout-menu"
                ref={layoutFlyout.attach}
                side="bottom"
                align="start"
                alignOffset={layoutFlyout.position?.alignOffset ?? 0}
                sideOffset={layoutFlyout.position?.sideOffset ?? 8}
                avoidCollisions={false}
                style={{
                  maxWidth: layoutFlyout.position?.maxWidth,
                  maxHeight: layoutFlyout.position?.maxHeight,
                  visibility: layoutFlyout.position ? 'visible' : 'hidden',
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (keyboardWindow.current) {
                    keyboardWindow.current = false;
                    bar.current?.focus({ preventScroll: true });
                  } else if (openingSplit.current) {
                    openingSplit.current = false;
                    const target = document.querySelector<HTMLElement>('.app-split-picker:not([inert]) input') ?? bar.current;
                    target?.focus({ preventScroll: true });
                  } else bar.current?.focus({ preventScroll: true });
                }}
              >
                <DropdownMenuLabel>Window layout</DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={blocked || !canSplitAppWindows(area)}
                  onSelect={() => {
                    openingSplit.current = true;
                    place('left');
                  }}
                >
                  <IconLayoutSidebar size={18} aria-hidden="true" />
                  Snap left
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={blocked || !canSplitAppWindows(area)}
                  onSelect={() => {
                    openingSplit.current = true;
                    place('right');
                  }}
                >
                  <IconLayoutSidebarRight size={18} aria-hidden="true" />
                  Snap right
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => place('floating')}>
                  <IconWindow size={18} aria-hidden="true" />
                  Floating window
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    keyboardWindow.current = true;
                    geometry.beginKeyboard('move');
                  }}
                >
                  <IconArrowsMove size={18} aria-hidden="true" />
                  Move with keyboard
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    keyboardWindow.current = true;
                    geometry.beginKeyboard('resize');
                  }}
                >
                  <IconResize size={18} aria-hidden="true" />
                  Resize with keyboard
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              className="app-launcher-close"
              size="icon"
              aria-label="Open app in new tab"
              title="Open in new tab and close this window"
              onClick={onTab}
            >
              <IconExternalLink size={19} aria-hidden="true" />
            </Button>
            <Button
              className="app-launcher-close"
              size="icon"
              aria-label={mode === 'maximized' ? 'Restore app window size' : 'Maximize app window'}
              onClick={() => place(mode === 'maximized' ? 'floating' : 'maximized')}
            >
              {mode === 'maximized' ? <IconArrowsMinimize size={19} aria-hidden="true" /> : <IconArrowsMaximize size={19} aria-hidden="true" />}
            </Button>
            <Button className="app-launcher-close" size="icon" aria-label="Minimize app window" onClick={() => depart(onMinimize)}>
              <IconMinus size={19} aria-hidden="true" />
            </Button>
            <Button className="app-launcher-close" size="icon" aria-label="Close app window" onClick={() => depart(onClose)}>
              <IconX size={19} aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="app-launcher-body">
          <div className="app-window-document" inert={settings || geometry.gestureKind !== null || undefined} aria-hidden={settings || undefined}>
            {!active && !settings && !boundary && status === 'visible' ? (
              <button
                type="button"
                className="app-window-activate"
                aria-label={`Activate ${request.name} window`}
                onPointerDown={(event) => event.preventDefault()}
                onFocus={() => bar.current?.focus({ preventScroll: true })}
                onClick={onFocus}
              />
            ) : null}
            <AppFrame
              request={request}
              enabled={desktop && status === 'visible'}
              active={active}
              boundary={boundary}
              help={help}
              helpAnchor={helpAnchor}
              flyoutFrame={panel.current}
              helpTrigger={helpButton.current}
              onHelpClose={closeHelp}
              onTab={onTab}
            />
          </div>
          {settings ? (
            <section className="app-window-settings" aria-label={`${request.name} settings`}>
              <header>
                <h3 ref={settingsHeading} tabIndex={-1} data-focus-surface="parent">
                  App settings
                </h3>
                <div ref={setSettingsSaveTarget} className="app-window-settings-save-target" />
                <Button ref={settingsClose} size="icon" aria-label="Back to app" title="Back to app" onClick={closeSettings}>
                  <IconX size={19} aria-hidden="true" />
                </Button>
              </header>
              <Suspense fallback={<output>Loading app settings…</output>}>
                <WindowSettings request={request} onSaved={closeSettings} saveTarget={settingsSaveTarget} />
              </Suspense>
            </section>
          ) : null}
        </div>
        {geometry.gestureKind ? <output className="app-window-keyboard-help">Arrow keys adjust · Enter saves · Escape cancels</output> : null}
        {mode === 'floating'
          ? edges.map((edge) => (
              <button
                key={edge}
                type="button"
                className="app-window-resize"
                data-edge={edge}
                aria-label={`Resize app window from ${edgeNames[edge]}`}
                {...geometry.resize(edge)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !geometry.gestureKind) {
                    event.preventDefault();
                    geometry.beginKeyboard('resize', edge);
                  } else geometry.keyboard(event);
                }}
              />
            ))
          : null}
      </dialog>
    </>
  );
}

const AppFrame = memo(function AppFrame({
  request,
  enabled,
  active,
  boundary,
  help,
  helpAnchor,
  flyoutFrame,
  helpTrigger,
  onHelpClose,
  onTab,
}: {
  request: WindowState['request'];
  enabled: boolean;
  active: boolean;
  boundary?: AppEmbeddingCheck;
  help: boolean;
  helpAnchor: AppFlyoutPoint | null;
  flyoutFrame: HTMLElement | null;
  helpTrigger: HTMLElement | null;
  onHelpClose: () => void;
  onTab: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const loadKey = `${request.launchUrl}:${attempt}`;
  const [observedLoad, setObservedLoad] = useState<string>();
  const [slowLoad, setSlowLoad] = useState<string>();
  const [rememberTab, setRememberTab] = useState(false);
  const visible = useWindowVisible();
  const noticeHeading = useRef<HTMLHeadingElement>(null);
  // Load also fires for browser error pages; it only stops automatic rechecks.
  const awaitingLoad = observedLoad !== loadKey;
  const check = useAppEmbedding(request, enabled && visible && !boundary && (awaitingLoad || help));
  const { preferences, update } = useDesktopPreferences();
  const showWarning = Boolean(boundary || help);
  const helpFlyout = useWindowFlyout(showWarning && !boundary, flyoutFrame, helpTrigger, helpAnchor);
  const notice = appEmbeddingWarning(boundary ?? check.data) ?? {
    blocked: false,
    title: 'Connection options',
    description:
      check.data?.status === 'not-blocked-by-headers'
        ? 'The initial response permits embedding, but sign-in or later pages may still need a browser tab. Reload the app or open a tab.'
        : 'Some apps block embedded windows or need a browser tab for sign-in. Reload the app or open a tab.',
  };
  useLayoutEffect(() => {
    if (enabled && active && showWarning) noticeHeading.current?.focus({ preventScroll: true });
  }, [enabled, active, showWarning]);
  useEffect(() => {
    if (!enabled || !visible || boundary || !awaitingLoad) return;
    const timer = window.setTimeout(() => setSlowLoad(loadKey), 15_000);
    return () => window.clearTimeout(timer);
  }, [enabled, visible, boundary, awaitingLoad, loadKey]);
  const reload = () => {
    setAttempt((value) => value + 1);
  };
  const warning = showWarning ? (
    <section
      ref={boundary ? undefined : helpFlyout.attach}
      className={boundary ? 'app-window-compatibility' : 'app-window-recovery-panel'}
      style={
        boundary
          ? undefined
          : {
              left: helpFlyout.position?.left,
              top: helpFlyout.position?.top,
              maxWidth: helpFlyout.position?.maxWidth,
              maxHeight: helpFlyout.position?.maxHeight,
              visibility: helpFlyout.position ? 'visible' : 'hidden',
            }
      }
      role={boundary ? undefined : 'dialog'}
      aria-label="App window help"
      aria-busy={check.isFetching}
    >
      <div className={boundary ? 'app-window-compatibility-content' : 'app-window-recovery-content'}>
        {boundary ? <IconExternalLink size={30} aria-hidden="true" /> : null}
        <h3 ref={noticeHeading} tabIndex={-1}>
          {notice.title}
        </h3>
        {boundary ? null : (
          <Button className="app-window-recovery-close" size="icon" aria-label="Close page help" onClick={onHelpClose}>
            <IconX size={18} aria-hidden="true" />
          </Button>
        )}
        <p>{notice.description}</p>
        <label className="app-window-remember-tab">
          <input type="checkbox" checked={rememberTab} onChange={(event) => setRememberTab(event.target.checked)} />
          <span>Always open this app in a new tab</span>
        </label>
        <div className="app-window-compatibility-actions">
          {boundary ? null : <Button onClick={reload}>Reload app</Button>}
          <Button
            intent="primary"
            onClick={() => {
              if (rememberTab)
                update({
                  appLaunch: {
                    ...preferences.appLaunch,
                    apps: { ...preferences.appLaunch.apps, [request.urn]: { ...preferences.appLaunch.apps[request.urn], mode: 'tab' } },
                  },
                });
              onTab();
            }}
          >
            Open tab
          </Button>
        </div>
      </div>
    </section>
  ) : null;
  return (
    <>
      {!showWarning && awaitingLoad && slowLoad === loadKey ? (
        <output className="app-window-loading-note" aria-live="polite">
          Still opening this app…
        </output>
      ) : null}
      {boundary ? null : (
        <iframe
          key={loadKey}
          className="app-window-frame"
          title={`${request.name} app`}
          src={request.launchUrl}
          onLoad={() => setObservedLoad(loadKey)}
          referrerPolicy="no-referrer"
          allow="fullscreen; clipboard-read; clipboard-write; camera; microphone; geolocation; display-capture"
          sandbox="allow-forms allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals allow-presentation"
        />
      )}
      {warning && !boundary && flyoutFrame ? createPortal(warning, flyoutFrame) : warning}
    </>
  );
});
