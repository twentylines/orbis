import { useUserContext } from '@/context/user-context';
import { useUIStore } from '@/stores/ui-store';
import Cookies from 'js-cookie';
import type React from 'react';
import { useEffect } from 'react';

type Props = {
  children: React.ReactNode;
  initialTheme?: string;
};

export const ThemeProvider = (props: Props) => {
  const { children, initialTheme } = props;
  const { themeBase, themeColor } = useUserContext();

  const theme = useUIStore((state) => state.theme);
  const setDarkMode = useUIStore((state) => state.setDarkMode);

  useEffect(() => {
    if (themeBase) {
      document.body.dataset.bsThemeBase = themeBase;
    }

    if (themeColor) {
      document.body.dataset.bsThemePrimary = themeColor;
    }

    let cachedTheme: string | undefined;
    try {
      cachedTheme = Cookies.get('theme');
    } catch {
      cachedTheme = undefined;
    }
    const resolved = theme ?? initialTheme ?? cachedTheme ?? 'light';
    document.body.dataset.bsTheme = resolved;
    if (!theme) setDarkMode(resolved === 'dark');
    try {
      Cookies.set('theme', resolved, { path: '/', expires: 365 });
    } catch {
      // Theme rendering does not require cookie storage.
    }
  }, [initialTheme, setDarkMode, theme, themeBase, themeColor]);

  return children;
};
