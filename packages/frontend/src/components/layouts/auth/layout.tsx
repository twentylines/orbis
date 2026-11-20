import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import { useDesktopPreferences } from '@/desktop/preferences';
import { resolveWallpaperKey } from '@/desktop/wallpaper-presets';
import { DesktopWallpaper } from '@/desktop/wallpaper';
import { InterstellarBackdrop } from '@/components/startup/interstellar-backdrop';
import { RefractiveScene } from '@/components/startup/refractive-scene';
import { useReducedTransparency } from '@/desktop/motion-preferences';
import { useLayoutEffect, useRef, useSyncExternalStore, type PropsWithChildren, type ReactNode } from 'react';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { hasActiveSessionMorph, noSessionMorph, subscribeSessionMorph } from '@/components/startup/session-morph';
import './layout.css';

export function authLayoutScene(setup: boolean, scene?: ReactNode) {
  return scene ?? (setup ? <InterstellarBackdrop className="orbis-setup-space" /> : <DesktopWallpaper />);
}

function revealAuthFocus(target: EventTarget) {
  if (!(target instanceof HTMLElement)) return;
  requestAnimationFrame(() => {
    if (document.activeElement !== target || !target.matches(':focus-visible')) return;
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const bounds = target.getBoundingClientRect();
    const inset = 12;
    const bottom = window.innerHeight - inset;
    const delta = bounds.top < inset ? bounds.top - inset : bounds.bottom > bottom ? bounds.bottom - bottom : 0;
    // Stop an earlier native focus scroll before it moves this control out of view.
    window.scrollTo({ top: window.scrollY + delta, behavior: 'instant' });
  });
}

export const AuthLayout = ({
  children,
  busy = false,
  setup = false,
  scene,
  progress,
}: PropsWithChildren<{
  busy?: boolean;
  setup?: boolean;
  scene?: ReactNode;
  progress?: ReactNode;
}>) => {
  const container = useRef<HTMLDivElement>(null);
  const morphing = useSyncExternalStore(subscribeSessionMorph, hasActiveSessionMorph, noSessionMorph);
  const wasMorphing = useRef(morphing);
  useLayoutEffect(() => {
    const animations: Animation[] = [];
    const enter = () => {
      const content = container.current;
      if (!content?.animate || prefersReducedMotion() || document.documentElement.dataset.orbisEffects === 'low' || hasActiveSessionMorph()) return;
      const timing = { duration: 460, easing: 'cubic-bezier(.2, .7, .2, 1)' };
      animations.push(content.animate([{ transform: 'translateY(14px)' }, { transform: 'none' }], timing));
      // An opacity animation on the container makes it a backdrop root and
      // prevents the card from blurring the wallpaper behind the container.
      for (const child of content.children) animations.push(child.animate([{ opacity: 0 }, { opacity: 1 }], timing));
      const start = document.timeline.currentTime;
      for (const animation of animations) {
        animation.id = 'orbis-auth-enter';
        if (typeof start === 'number') animation.startTime = start;
      }
    };
    if (document.querySelector('.orbis-startup-overlay')) window.addEventListener('orbis-startup-reveal', enter, { once: true });
    else enter();
    return () => {
      window.removeEventListener('orbis-startup-reveal', enter);
      for (const animation of animations) animation.cancel();
    };
  }, []);
  useLayoutEffect(() => {
    window.dispatchEvent(new Event('orbis-auth-card-ready'));
  }, []);
  useLayoutEffect(() => {
    if (wasMorphing.current && !morphing && !setup)
      container.current
        ?.querySelector<HTMLInputElement>('input[autocomplete="username"], input:not([type="hidden"])')
        ?.focus({ preventScroll: true });
    wasMorphing.current = morphing;
  }, [morphing, setup]);

  const { preferences, resolvedMode } = useDesktopPreferences();
  const reducedTransparency = useReducedTransparency();
  const glass =
    setup &&
    !preferences.appearance.lowEffects &&
    preferences.appearance.glassBlur !== 0 &&
    !(resolvedMode === 'dark' && preferences.appearance.oledDark) &&
    (preferences.appearance.transparency === 'glass' || (preferences.appearance.transparency === 'system' && !reducedTransparency));
  return (
    <div
      className={`page page-center desktop-auth orbis-theme${setup ? ' desktop-auth-setup' : ''}`}
      data-desktop-preset={preferences.preset}
      data-desktop-mode={resolvedMode}
      data-desktop-wallpaper={resolveWallpaperKey(preferences)}
      data-auth-glass={glass || undefined}
      data-setup-saving={(setup && busy) || undefined}
      inert={!setup && morphing}
      onFocusCapture={(event) => revealAuthFocus(event.target)}
    >
      {authLayoutScene(setup, scene)}
      <div ref={container} className="container container-tight desktop-auth-container" inert={setup && busy}>
        {setup ? (
          <>
            <header className="desktop-auth-identity">
              <div className="desktop-auth-brand">
                <OrbisLogo size={36} plain />
                <span className="desktop-auth-product">Orbis</span>
              </div>
            </header>
            {progress}
          </>
        ) : null}
        <div className="card card-md">
          {glass && !setup ? <RefractiveScene /> : null}
          {setup ? null : (
            <header className="desktop-auth-identity">
              <div className="desktop-auth-brand">
                <OrbisLogo size={42} plain animated />
                <span className="desktop-auth-product">Orbis</span>
              </div>
              <p className="desktop-auth-server">{preferences.serverName}</p>
            </header>
          )}
          <div className="card-body">{children}</div>
        </div>
      </div>
    </div>
  );
};
