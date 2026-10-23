import { LanguageSelector } from '@/components/language-selector/language-selector';
import type { Locale } from '@/lib/i18n/locales';
import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import { useDesktopPreferences } from '@/desktop/preferences';
import { DesktopWallpaper } from '@/desktop/wallpaper';
import i18next from 'i18next';
import { IconMoon, IconSun } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import type { PropsWithChildren } from 'react';

function revealAuthFocus(target: EventTarget) {
  if (!(target instanceof HTMLElement)) return;
  requestAnimationFrame(() => {
    if (document.activeElement !== target) return;
    const bounds = target.getBoundingClientRect();
    const inset = 12;
    const bottom = window.innerHeight - inset;
    const delta = bounds.top < inset ? bounds.top - inset : bounds.bottom > bottom ? bounds.bottom - bottom : 0;
    if (delta) window.scrollBy({ top: delta, behavior: 'instant' });
  });
}

export const AuthLayout = ({ children, busy = false }: PropsWithChildren<{ busy?: boolean }>) => {
  const locale = i18next.language;

  const { preferences, resolvedMode, update } = useDesktopPreferences();
  return (
    <div
      className="page page-center desktop-auth orbis-theme"
      data-desktop-preset={preferences.preset}
      data-desktop-mode={resolvedMode}
      data-desktop-wallpaper={preferences.wallpaper}
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
        <LanguageSelector locale={locale as Locale} className="mb-0" />
      </div>
      <div className="container container-tight desktop-auth-container">
        <div className="text-center desktop-auth-identity">
          <OrbisLogo size={64} />
          <p className="desktop-auth-product">Orbis</p>
          <h1>{preferences.serverName}</h1>
        </div>
        <div className="card card-md">
          <div className="card-body">{children}</div>
        </div>
      </div>
    </div>
  );
};
