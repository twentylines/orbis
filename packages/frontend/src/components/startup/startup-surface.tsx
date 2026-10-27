import { WallpaperLayer } from '@/desktop/wallpaper-layer';
import { resolveWallpaperKey } from '@/desktop/wallpaper-presets';
import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import { useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { readCachedAppearance, appearanceCacheEvent, type CachedAppearance } from '@/desktop/appearance-cache';
import { isLoggingOff } from '@/desktop/session-motion';
import { useResolvedColourMode } from '@/desktop/colour-mode';
import { createPortal } from 'react-dom';

const viewportGutterProperty = '--orbis-startup-viewport-gutter';
export const startupViewportBootstrap = `requestAnimationFrame(()=>document.documentElement.style.setProperty('${viewportGutterProperty}',Math.max(0,window.innerWidth-document.documentElement.clientWidth)+'px'));
`;

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
    let previous = '';
    const align = () => {
      const viewportGutter = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
      const gutter = Math.max(0, element.offsetWidth - element.clientWidth);
      const next = `${gutter}:${viewportGutter}`;
      if (next === previous) return;
      previous = next;
      element.style.setProperty('--orbis-startup-scrollbar', `${gutter}px`);
      element.style.setProperty(viewportGutterProperty, `${viewportGutter}px`);
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
    const changed = () => setCached(readCachedAppearance());
    window.addEventListener(appearanceCacheEvent, changed);
    return () => window.removeEventListener(appearanceCacheEvent, changed);
  }, []);
  const current = appearance ?? cached;
  const mode = useResolvedColourMode(current?.mode ?? 'light');
  const content = (
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
      data-desktop-wallpaper={current ? resolveWallpaperKey(current) : undefined}
    >
      {current ? <WallpaperLayer choice={current} /> : null}
      <div className="orbis-startup-scene" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="orbis-startup-content">
        <div className="orbis-startup-brand">
          <div className="orbis-startup-emblem">
            <div className="orbis-startup-orbits" aria-hidden="true">
              <svg className="orbis-startup-trails" viewBox="0 0 240 200" fill="none" aria-hidden="true" focusable="false">
                <ellipse cx="120" cy="100" rx="110" ry="36" transform="rotate(-32 120 100)" />
                <ellipse cx="120" cy="100" rx="90" ry="32" transform="rotate(36 120 100)" />
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
  return overlay && !initial && typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}
