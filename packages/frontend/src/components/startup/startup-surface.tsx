import { useLayoutEffect, useState } from 'react';
import { readCachedAppearance, type CachedAppearance } from '@/desktop/appearance-cache';
import { isLoggingOff } from '@/desktop/session-motion';
import { useResolvedColourMode } from '@/desktop/colour-mode';

export function StartupSurface({ appearance, loggingOff = false }: { appearance?: CachedAppearance; loggingOff?: boolean }) {
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
      className={`orbis-startup${current ? ' orbis-theme' : ''}${loggingOff ? ' orbis-logout-surface' : ''}`}
      data-session-state={loggingOff || resumingLogout ? 'logging-out' : undefined}
      aria-live="polite"
      aria-busy="true"
      data-desktop-mode={current ? mode : undefined}
      data-desktop-preset={current?.preset}
      data-desktop-wallpaper={current?.wallpaper}
    >
      <div className="orbis-startup-content">
        <img src="/icons/orbis.svg" width={64} height={64} alt="" />
        <span className="orbis-startup-name">Orbis</span>
        <output>
          <span className="orbis-startup-message-loading">Loading workspace…</span>
          <span className="orbis-startup-message-logout">Logging off…</span>
        </output>
      </div>
    </div>
  );
}
