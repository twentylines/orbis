import { IconAlertCircle, IconReload } from '@tabler/icons-react';
import { Button } from '../ui/Button';
import { readCachedDesktopPreferences } from '@/desktop/preferences';
import { useResolvedColourMode } from '@/desktop/colour-mode';
import type { PropsWithChildren } from 'react';
import { useStartupReady } from '../startup/startup-boundary';

type ErrorPageProps = {
  onReset: () => void;
  error: Error;
};

export function retryErrorPage(onReset: () => void, location: Pick<Location, 'reload'> = window.location) {
  try {
    onReset();
  } finally {
    location.reload();
  }
}

export function openErrorWorkspace(location: Pick<Location, 'assign'> = window.location) {
  location.assign('/dashboard');
}

export const FallbackSurface = ({ children }: PropsWithChildren) => {
  useStartupReady(true);
  const preferences = readCachedDesktopPreferences();
  const resolvedMode = useResolvedColourMode(preferences.mode);
  return (
    <div
      className="desktop desktop-fallback orbis-theme"
      data-desktop-mode={resolvedMode}
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
          <Button intent="primary" onClick={() => retryErrorPage(onReset)}>
            <IconReload size={18} aria-hidden="true" />
            Retry
          </Button>
          <a
            href="/dashboard"
            className="btn btn-outline-primary"
            onClick={(event) => {
              event.preventDefault();
              openErrorWorkspace();
            }}
          >
            Open workspace
          </a>
        </div>
        <section className="orbis-error-details" aria-label="Error details">
          <dl>
            <dt>Page</dt>
            <dd>{typeof window === 'undefined' ? '/' : window.location.pathname}</dd>
            <dt>Error</dt>
            <dd>{message || 'No error details were returned.'}</dd>
          </dl>
        </section>
      </section>
    </FallbackSurface>
  );
};
