import { LanguageSelector } from '@/components/language-selector/language-selector';
import { useUserContext } from '@/context/user-context';
import type { Locale } from '@/lib/i18n/locales';
import { getLogo } from '@/lib/theme/theme';
import { useDesktopPreferences } from '@/desktop/preferences';
import i18next from 'i18next';
import { IconMoon, IconSun } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import type { PropsWithChildren } from 'react';

export const AuthLayout = ({ children }: PropsWithChildren) => {
  const locale = i18next.language;

  const { allowAutoThemes } = useUserContext();
  const { preferences, update } = useDesktopPreferences();
  return (
    <div
      className="page page-center desktop-auth orbis-theme"
      data-desktop-preset={preferences.preset}
      data-desktop-mode={preferences.mode}
      data-desktop-wallpaper={preferences.wallpaper}
    >
      <div className="desktop-auth-toolbar">
        <Button
          size="icon"
          variant="outline"
          aria-label={`Switch to ${preferences.mode === 'dark' ? 'light' : 'dark'} mode`}
          onClick={() => update({ mode: preferences.mode === 'dark' ? 'light' : 'dark' })}
        >
          {preferences.mode === 'dark' ? <IconSun size={20} aria-hidden="true" /> : <IconMoon size={20} aria-hidden="true" />}
        </Button>
        <LanguageSelector locale={locale as Locale} />
      </div>
      <div className="container container-tight py-4">
        <div className="text-center mb-4 desktop-auth-identity">
          <img
            alt="Orbis logo"
            src={getLogo(allowAutoThemes)}
            height={64}
            width={64}
            style={{
              maxWidth: '100%',
              height: 'auto',
            }}
          />
          <p className="desktop-auth-product">Orbis</p>
          <h1>{preferences.serverName}</h1>
        </div>
        <div className="card card-md">
          <div className="card-body">{children}</div>
        </div>
        <p className="desktop-auth-credit">Orbis is built on Runtipi.</p>
      </div>
    </div>
  );
};
