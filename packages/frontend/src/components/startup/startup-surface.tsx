import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import { useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { readCachedAppearance, type CachedAppearance } from '@/desktop/appearance-cache';
import { isLoggingOff } from '@/desktop/session-motion';
import { useResolvedColourMode } from '@/desktop/colour-mode';

export function StartupSurface({
  ref,
  appearance,
  loggingOff = false,
  signingIn = false,
  status,
  overlay = false,
  revealing = false,
  completing = false,
  initial = false,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  appearance?: CachedAppearance;
  loggingOff?: boolean;
  signingIn?: boolean;
  status?: { title: string; message: string };
  overlay?: boolean;
  revealing?: boolean;
  completing?: boolean;
  initial?: boolean;
  children?: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => surface.current as HTMLDivElement, []);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    let previous = -1;
    const align = () => {
      const gutter = Math.max(0, element.offsetWidth - element.clientWidth);
      if (gutter === previous) return;
      previous = gutter;
      element.style.setProperty('--orbis-startup-scrollbar', `${gutter}px`);
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
      ref={surface}
      className={`orbis-startup${current ? ' orbis-theme' : ''}${loggingOff ? ' orbis-logout-surface' : signingIn ? ' orbis-login-surface' : status ? ' orbis-update-surface' : ''}${overlay ? ' orbis-startup-overlay' : ''}`}
      data-session-state={loggingOff || resumingLogout ? 'logging-out' : signingIn ? 'signing-in' : status ? 'updating' : 'loading'}
      data-revealing={revealing || undefined}
      data-completing={completing || undefined}
      data-initial-startup={initial || undefined}
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
        <div className="orbis-startup-brand">
          <div className="orbis-startup-emblem">
            <div className="orbis-startup-orbits" aria-hidden="true">
              <svg className="orbis-startup-trails" viewBox="0 0 240 200" fill="none" aria-hidden="true" focusable="false">
                <path d="M24 141C-8 105 165 24 211 53C247 77 107 178 55 162" />
                <path d="M51 43C84 24 215 112 200 146C184 177 29 83 51 43Z" />
              </svg>
              <span />
              <span />
              <span />
            </div>
            <span className="orbis-startup-logo">
              <OrbisLogo size={88} />
            </span>
          </div>
          <span className="orbis-startup-name">Orbis</span>
        </div>
        <output>
          <span className="orbis-startup-message-loading">{status?.title ?? (signingIn ? 'Signing in…' : 'Loading workspace…')}</span>
          <span className="orbis-startup-message-logout">Logging off…</span>
        </output>
        <div
          className="orbis-startup-progress"
          role="progressbar"
          aria-label={status?.title ?? (loggingOff || resumingLogout ? 'Logging off' : signingIn ? 'Signing in' : 'Loading Orbis')}
          aria-valuetext={status?.message}
          aria-valuenow={completing ? 100 : undefined}
        >
          <span />
        </div>
        {status ? (
          <div className="orbis-startup-status">
            <p className="orbis-startup-detail">{status.message}</p>
            <div className="orbis-startup-actions">{children}</div>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
