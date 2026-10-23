import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import { useLayoutEffect, useState } from 'react';
import { readCachedAppearance, type CachedAppearance } from '@/desktop/appearance-cache';
import { isLoggingOff } from '@/desktop/session-motion';
import { useResolvedColourMode } from '@/desktop/colour-mode';

export function StartupSurface({
  appearance,
  loggingOff = false,
  signingIn = false,
}: {
  appearance?: CachedAppearance;
  loggingOff?: boolean;
  signingIn?: boolean;
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
      className={`orbis-startup${current ? ' orbis-theme' : ''}${loggingOff ? ' orbis-logout-surface' : signingIn ? ' orbis-login-surface' : ''}`}
      data-session-state={loggingOff || resumingLogout ? 'logging-out' : signingIn ? 'signing-in' : 'loading'}
      aria-live="polite"
      aria-busy="true"
      data-desktop-mode={current ? mode : undefined}
      data-desktop-preset={current?.preset}
      data-desktop-wallpaper={current?.wallpaper}
    >
      <div className="orbis-startup-content">
        <div className="orbis-startup-emblem">
          <OrbisLogo size={64} />
        </div>
        <span className="orbis-startup-name">Orbis</span>
        <output>
          <span className="orbis-startup-message-loading">{signingIn ? 'Signing in…' : 'Loading workspace…'}</span>
          <span className="orbis-startup-message-logout">Logging off…</span>
        </output>
      </div>
    </div>
  );
}
