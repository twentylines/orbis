import { IconReload } from '@tabler/icons-react';
import { Button } from '../ui/Button';
import { readCachedDesktopPreferences } from '@/desktop/preferences';
import type { PropsWithChildren } from 'react';

type ErrorPageProps = {
  onReset: () => void;
  error: Error;
};

export const FallbackSurface = ({ children }: PropsWithChildren) => {
  const preferences = readCachedDesktopPreferences();
  return (
    <div
      className="desktop desktop-fallback orbis-theme"
      data-desktop-mode={preferences.mode}
      data-desktop-preset={preferences.preset}
      data-desktop-wallpaper={preferences.wallpaper}
    >
      <div className="desktop-fallback-panel">{children}</div>
    </div>
  );
};

export const ErrorPage = ({ error, onReset }: ErrorPageProps) => {
  return (
    <FallbackSurface>
      <div className="empty">
        <h1 className="empty-title">Unable to load this page</h1>
        <p className="empty-subtitle text-secondary">
          Retry to load the page again. If it still fails, include the error below when reporting the problem.
        </p>
        <div className="empty-action">
          <Button intent="primary" onClick={onReset}>
            <IconReload className="me-2" />
            Retry
          </Button>
        </div>
        <pre className="mt-5" style={{ whiteSpace: 'normal' }}>
          {error.message}
          <br />
          Location: {location.pathname}
        </pre>
      </div>
    </FallbackSurface>
  );
};
