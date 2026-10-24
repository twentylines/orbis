import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import { useDesktopPreferences } from '@/desktop/preferences';
import { resolveWallpaperKey } from '@/desktop/wallpaper-presets';
import { DesktopWallpaper } from '@/desktop/wallpaper';
import { IconMoon, IconSun } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import { useLayoutEffect, useRef, type PropsWithChildren } from 'react';
import { prefersReducedMotion } from '@/desktop/motion-setting';

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

export const AuthLayout = ({ children, busy = false, setup = false }: PropsWithChildren<{ busy?: boolean; setup?: boolean }>) => {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let animation: Animation | undefined;
    const enter = () => {
      if (prefersReducedMotion()) return;
      animation = container.current?.animate(
        [
          { opacity: 0, transform: 'translateY(14px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 460, easing: 'cubic-bezier(.2, .7, .2, 1)' },
      );
    };
    if (document.querySelector('.orbis-startup-overlay')) window.addEventListener('orbis-startup-reveal', enter, { once: true });
    else enter();
    return () => {
      window.removeEventListener('orbis-startup-reveal', enter);
      animation?.cancel();
    };
  }, []);

  const { preferences, resolvedMode, update } = useDesktopPreferences();
  return (
    <div
      className={`page page-center desktop-auth orbis-theme${setup ? ' desktop-auth-setup' : ''}`}
      data-desktop-preset={preferences.preset}
      data-desktop-mode={resolvedMode}
      data-desktop-wallpaper={resolveWallpaperKey(preferences)}
      onFocusCapture={(event) => revealAuthFocus(event.target)}
    >
      <DesktopWallpaper />
      <div className="desktop-auth-toolbar">
        <Button
          size="icon"
          variant="outline"
          disabled={busy}
          aria-label={`Switch to ${resolvedMode === 'dark' ? 'light' : 'dark'} mode`}
          onClick={() => update({ mode: resolvedMode === 'dark' ? 'light' : 'dark' })}
        >
          {resolvedMode === 'dark' ? <IconSun size={20} aria-hidden="true" /> : <IconMoon size={20} aria-hidden="true" />}
        </Button>
      </div>
      <div ref={container} className="container container-tight desktop-auth-container">
        <div className="card card-md">
          <header className="desktop-auth-identity">
            <div className="desktop-auth-brand">
              <OrbisLogo size={42} plain />
              <span className="desktop-auth-product">Orbis</span>
            </div>
            {!setup && <p className="desktop-auth-server">{preferences.serverName}</p>}
          </header>
          <div className="card-body">{children}</div>
        </div>
      </div>
    </div>
  );
};
