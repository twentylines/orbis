import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconArrowsMove,
  IconExternalLink,
  IconLayoutColumns,
  IconMinus,
  IconResize,
  IconSettings,
  IconX,
} from '@tabler/icons-react';
import { lazy, memo, Suspense, useId, useLayoutEffect, useRef, useState } from 'react';
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
import { useAppEmbedding, useBlockedAppEmbeds } from './app-embedding';
import { useDesktopPreferences } from './preferences';
import { appEmbeddingWarning } from './app-opening';

const WindowSettings = lazy(() => import('./app-window-settings'));
const edges: ResizeEdge[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const edgeNames = { n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left', nw: 'top left' };
const rectStyle = (box: DesktopWindowBounds) => ({ left: box.x, top: box.y, width: box.width, height: box.height });

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
  onPlace,
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
  onPlace: (mode: AppWindowMode) => void;
  onFocus: () => void;
  onMinimize: () => void;
  onMinimized: () => void;
  onClose: () => void;
  onRemoved: () => void;
  onTab: () => void;
  onSave: (bounds: DesktopWindowBounds) => void;
}) {
  const { request, status, mode } = item;
  const blockedEmbeds = useBlockedAppEmbeds();
  const blocked = blockedEmbeds[request.urn]?.url === request.launchUrl;
  const titleId = useId();
  const helpId = useId();
  const panel = useRef<HTMLDialogElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsClose = useRef<HTMLButtonElement>(null);
  const placementFrom = useRef<DOMRect | null>(null);
  const flightAnimation = useRef<Animation | null>(null);
  const departure = useRef<{ box: DOMRect; opacity: number } | null>(null);
  const [settings, setSettings] = useState(false);
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
  });
  const hidden = !desktop || status === 'minimized';
  const busy = status === 'minimizing' || status === 'closing';
  const flightReady = status !== 'minimizing' || trayReady;
  const motion = useRef({
    origin,
    trayTarget,
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
    if (settings) settingsClose.current?.focus({ preventScroll: true });
  }, [settings, hidden]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || hidden || !flightReady) return;
    if (status === 'visible' && !motion.current.automatic)
      (motion.current.settings ? settingsClose.current : settingsButton.current)?.focus({ preventScroll: true });
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
        ? [
            { transform: start ? transformTo(start.box) : 'none', opacity: start?.opacity ?? 1 },
            { transform: transformTo(end), opacity: 0.2 },
          ]
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
            { transform: transform(start), opacity },
            { transform: transform(end), opacity: status === 'minimizing' ? 0.2 : status === 'closing' ? 0 : 1 },
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
    settingsButton.current?.focus({ preventScroll: true });
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
              ref={settingsButton}
              className="app-launcher-close"
              size="icon"
              aria-label="App settings"
              title="App settings"
              aria-expanded={settings}
              onClick={() => setSettings((value) => !value)}
            >
              <IconSettings size={18} aria-hidden="true" />
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button className="app-launcher-close" size="icon" aria-label="Window layout" title="Window layout">
                  <IconLayoutColumns size={19} aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="app-window-layout-menu"
                align="end"
                onCloseAutoFocus={(event) => {
                  if (keyboardWindow.current) {
                    event.preventDefault();
                    keyboardWindow.current = false;
                    bar.current?.focus({ preventScroll: true });
                  }
                }}
              >
                <DropdownMenuLabel>Window layout</DropdownMenuLabel>
                <DropdownMenuItem disabled={blocked || !canSplitAppWindows(area)} onSelect={() => place('left')}>
                  Snap left
                </DropdownMenuItem>
                <DropdownMenuItem disabled={blocked || !canSplitAppWindows(area)} onSelect={() => place('right')}>
                  Snap right
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => place('floating')}>Floating window</DropdownMenuItem>
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
            <AppFrame request={request} enabled={desktop && status === 'visible'} active={active} onTab={onTab} />
          </div>
          {settings ? (
            <section className="app-window-settings" aria-label={`${request.name} settings`}>
              <header>
                <h3>App settings</h3>
                <Button ref={settingsClose} size="icon" aria-label="Back to app" title="Back to app" onClick={closeSettings}>
                  <IconX size={19} aria-hidden="true" />
                </Button>
              </header>
              <Suspense fallback={<output>Loading app settings…</output>}>
                <WindowSettings request={request} onSaved={closeSettings} />
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
  onTab,
}: {
  request: WindowState['request'];
  enabled: boolean;
  active: boolean;
  onTab: () => void;
}) {
  const [loadObserved, setLoadObserved] = useState(false);
  const [tryWindow, setTryWindow] = useState(false);
  const [help, setHelp] = useState(false);
  const noticeHeading = useRef<HTMLHeadingElement>(null);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const noticeWasOpen = useRef(false);
  // A cross-origin iframe fires load for browser error pages too; it only stops automatic rechecks.
  const check = useAppEmbedding(request, enabled && !loadObserved);
  const knownBlocked = useBlockedAppEmbeds()[request.urn]?.url === request.launchUrl;
  const { preferences, update } = useDesktopPreferences();
  const warning = appEmbeddingWarning(check.data, knownBlocked);
  const showWarning = Boolean(warning?.blocked || help || (warning && !tryWindow && !loadObserved));
  const showFrame = !warning?.blocked && (!warning || tryWindow || loadObserved);
  const notice = warning ?? {
    blocked: false,
    title: 'App not loading?',
    description:
      'If the page is blank or refuses to connect, its browser security or connection may prevent it opening here. Try a browser tab. You can remember that choice for this app.',
  };
  useLayoutEffect(() => {
    if (!enabled || !active) return;
    if (showWarning) {
      noticeHeading.current?.focus({ preventScroll: true });
      noticeWasOpen.current = true;
    } else if (noticeWasOpen.current) {
      recoveryButton.current?.focus({ preventScroll: true });
      noticeWasOpen.current = false;
    }
  }, [enabled, active, showWarning]);
  if (check.isPending)
    return (
      <output className="app-window-compatibility">
        <span className="app-window-compatibility-content">Checking window compatibility…</span>
      </output>
    );
  return (
    <>
      {showFrame ? (
        <iframe
          className="app-window-frame"
          title={`${request.name} app`}
          src={request.launchUrl}
          hidden={!!showWarning}
          onLoad={() => setLoadObserved(true)}
          onError={() => setHelp(true)}
          referrerPolicy="no-referrer"
          allow="fullscreen; clipboard-read; clipboard-write; camera; microphone; geolocation; display-capture"
          sandbox="allow-forms allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals allow-presentation"
        />
      ) : null}
      {showWarning ? (
        <section className="app-window-compatibility" aria-label="App window compatibility">
          <div className="app-window-compatibility-content">
            <IconExternalLink size={30} aria-hidden="true" />
            <h3 ref={noticeHeading} tabIndex={-1}>
              {notice.title}
            </h3>
            <p>{notice.description}</p>
            <div className="app-window-compatibility-actions">
              {notice.blocked ? null : (
                <Button
                  onClick={() => {
                    setTryWindow(true);
                    setHelp(false);
                  }}
                >
                  {loadObserved ? 'Back to app' : 'Try window'}
                </Button>
              )}
              <Button onClick={onTab}>Open in new tab</Button>
              <Button
                intent="primary"
                onClick={() => {
                  update({
                    appLaunch: {
                      ...preferences.appLaunch,
                      apps: { ...preferences.appLaunch.apps, [request.urn]: { ...preferences.appLaunch.apps[request.urn], mode: 'tab' } },
                    },
                  });
                  onTab();
                }}
              >
                Always open in new tab
              </Button>
            </div>
            <Button variant="ghost" disabled={check.isFetching} onClick={() => void check.refetch()}>
              {check.isFetching ? 'Checking…' : 'Check again'}
            </Button>
          </div>
        </section>
      ) : (
        <footer className="app-window-recovery">
          <Button ref={recoveryButton} variant="ghost" onClick={() => setHelp(true)}>
            App not loading?
          </Button>
        </footer>
      )}
    </>
  );
});
