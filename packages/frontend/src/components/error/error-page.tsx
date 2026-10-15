import { IconAlertCircle, IconReload } from '@tabler/icons-react';
import { Link } from 'react-router';
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
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  return (
    <FallbackSurface>
      <section className="orbis-error" aria-labelledby="orbis-error-title">
        <span className="orbis-error-icon" aria-hidden="true">
          <IconAlertCircle size={24} stroke={1.7} />
        </span>
        <div className="orbis-error-copy">
          <h1 id="orbis-error-title">Unable to load this page</h1>
          <p>Retry, or return to the workspace.</p>
        </div>
        <div className="orbis-error-actions">
          <Button intent="primary" onClick={onReset}>
            <IconReload size={18} aria-hidden="true" />
            Retry
          </Button>
          <Link to="/dashboard" className="btn btn-outline-primary">
            Open workspace
          </Link>
        </div>
        <details className="orbis-error-details">
          <summary>Details</summary>
          <dl>
            <dt>Page</dt>
            <dd>{typeof window === 'undefined' ? '/' : window.location.pathname}</dd>
            <dt>Error</dt>
            <dd>{message || 'No error details were returned.'}</dd>
          </dl>
        </details>
      </section>
    </FallbackSurface>
  );
};
