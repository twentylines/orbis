import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { readCachedAppearance, type CachedAppearance } from '@/desktop/appearance-cache';
import { isLoggingOff } from '@/desktop/session-motion';
import { useResolvedColourMode } from '@/desktop/colour-mode';

export function StartupSurface({
  appearance,
  loggingOff = false,
  signingIn = false,
  status,
  overlay = false,
  revealing = false,
  children,
}: {
  appearance?: CachedAppearance;
  loggingOff?: boolean;
  signingIn?: boolean;
  status?: { title: string; message: string };
  overlay?: boolean;
  revealing?: boolean;
  children?: ReactNode;
}) {
  const [cached, setCached] = useState<CachedAppearance | null>(null);
  const [resumingLogout, setResumingLogout] = useState(false);
  useLayoutEffect(() => {
    setCached(readCachedAppearance());
    setResumingLogout(isLoggingOff());
  }, []);
  const current = appearance ?? cached;
  const mode = useResolvedColourMode(current?.mode ?? 'light');
  return (
    <div
      className={`orbis-startup${current ? ' orbis-theme' : ''}${loggingOff ? ' orbis-logout-surface' : signingIn ? ' orbis-login-surface' : status ? ' orbis-update-surface' : ''}${overlay ? ' orbis-startup-overlay' : ''}`}
      data-session-state={loggingOff || resumingLogout ? 'logging-out' : signingIn ? 'signing-in' : status ? 'updating' : 'loading'}
      data-revealing={revealing || undefined}
      aria-live="polite"
      aria-busy="true"
      data-desktop-mode={current ? mode : undefined}
      data-desktop-preset={current?.preset}
      data-desktop-wallpaper={current?.wallpaper}
    >
      <div className="orbis-startup-scene" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="orbis-startup-content">
        <div className="orbis-startup-emblem">
          <span className="orbis-startup-satellite" aria-hidden="true" />
          <OrbisLogo size={64} />
        </div>
        <span className="orbis-startup-name">Orbis</span>
        <output>
          <span className="orbis-startup-message-loading">{status?.title ?? (signingIn ? 'Signing in…' : 'Loading workspace…')}</span>
          <span className="orbis-startup-message-logout">Logging off…</span>
        </output>
        <div
          className="orbis-startup-progress"
          role="progressbar"
          aria-label={status?.title ?? (loggingOff || resumingLogout ? 'Logging off' : signingIn ? 'Signing in' : 'Loading Orbis')}
          aria-valuetext={status?.message}
        >
          <span />
        </div>
        {status ? <p className="orbis-startup-detail">{status.message}</p> : null}
        {children}
      </div>
    </div>
  );
}
