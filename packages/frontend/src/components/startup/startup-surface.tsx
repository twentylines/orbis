import { WallpaperLayer } from '@/desktop/wallpaper-layer';
import { resolveWallpaperKey } from '@/desktop/wallpaper-presets';
import { StartupMark } from './startup-mark';
import { RecoveryProgressBar } from '@/components/recovery-progress/recovery-progress';
import { InterstellarBackdrop } from './interstellar-backdrop';
import { useSessionWallpaperInk } from './session-wallpaper-ink';
import { formationProgress } from './dot-formation';
import {
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { readCachedAppearance, appearanceCacheEvent, type CachedAppearance } from '@/desktop/appearance-cache';
import { readServerAppearance, serverAppearanceSnapshot, subscribeServerAppearance } from '@/desktop/restore-readiness';
import { isLoggingOff } from '@/desktop/session-motion';
import { createPortal } from 'react-dom';
import { useResolvedColourMode } from '@/desktop/colour-mode';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { contractSessionMorph, settleSessionMorphViewport, type SessionMorph } from './session-morph';
import { waitForStartupWallpaper } from './wallpaper-ready';
import { readResetStartupPhase, resetStartupBootstrap, resetStartupPhaseServerSnapshot, subscribeResetStartup } from './reset-startup';
import './startup-space.css';
import './session-morph.css';

const viewportGutterProperty = '--orbis-startup-viewport-gutter';

export const startupViewportBootstrap = `${resetStartupBootstrap};requestAnimationFrame(()=>document.documentElement.style.setProperty('${viewportGutterProperty}',Math.max(0,window.innerWidth-document.documentElement.clientWidth)+'px'));
`;

export function StartupSurface({
  ref,
  appearance,
  loggingOff = false,
  signingIn = false,
  label,
  status,
  overlay = false,
  revealing = false,
  completing = false,
  initial = false,
  freshAppearance = false,
  setupSpace = false,
  prepareWallpaper = false,
  setupHandoff = false,
  setupSigningIn = false,
  landing = false,
  morph = null,
  attention = false,
  expandingAuth = false,
  progress,
  firstBoot = false,
  formationOwner,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  appearance?: CachedAppearance;
  loggingOff?: boolean;
  signingIn?: boolean;
  label?: string;
  status?: { title: string; message: string };
  overlay?: boolean;
  revealing?: boolean;
  completing?: boolean;
  initial?: boolean;
  freshAppearance?: boolean;
  setupSpace?: boolean;
  prepareWallpaper?: boolean;
  setupHandoff?: boolean;
  setupSigningIn?: boolean;
  landing?: boolean;
  morph?: SessionMorph | null;
  attention?: boolean;
  expandingAuth?: boolean;
  progress?: number;
  firstBoot?: boolean;
  formationOwner?: object;
  children?: ReactNode;
}) {
  const resetPhase = useSyncExternalStore(subscribeResetStartup, readResetStartupPhase, resetStartupPhaseServerSnapshot);
  const resetting = resetPhase !== null;
  const titleId = useId();
  setupSpace = setupSpace || resetting;
  label ??= resetting ? 'Resetting preferences' : undefined;
  status ??=
    resetPhase === 'accepted'
      ? { title: 'Resetting preferences', message: 'Waiting for the server to respond.' }
      : resetPhase === 'handoff'
        ? { title: 'Starting Orbis', message: 'Your reset is complete. Preparing a fresh setup.' }
        : undefined;
  const surface = useRef<HTMLDivElement>(null);
  const galaxy = useRef<HTMLDivElement>(null);
  const [morphVisible, setMorphVisible] = useState(!morph);
  useLayoutEffect(() => setMorphVisible(!morph), [morph]);
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
    const content = element.querySelector('.orbis-startup-content');
    if (content) observer.observe(content);
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
  const serverAppearance = useSyncExternalStore(subscribeServerAppearance, readServerAppearance, serverAppearanceSnapshot);
  const fresh = freshAppearance || (typeof document !== 'undefined' && document.documentElement.dataset.orbisFreshAppearance === 'restore');
  // The card, circle and wallpaper are one captured scene. Keep its palette
  // with it until the ready destination is revealed by the same crossfade.
  const captured = signingIn ? morph?.appearance : undefined;
  const current = captured?.choice ?? appearance ?? (fresh || setupSpace || setupSigningIn ? (serverAppearance ?? cached) : cached);
  const mode = useResolvedColourMode(current?.mode ?? 'system');
  useSessionWallpaperInk(surface, Boolean(morph || signingIn || setupSigningIn || loggingOff || resumingLogout));
  useLayoutEffect(() => {
    if (!morph || !surface.current || !galaxy.current || morph.cancelled) return;
    const element = galaxy.current;
    setMorphVisible(true);
    let releaseBackdrop: () => void = () => undefined;
    const backdropReady = new Promise<void>((resolve) => {
      releaseBackdrop = resolve;
    });
    const stopWaiting = waitForStartupWallpaper(surface.current, releaseBackdrop);
    contractSessionMorph(morph, element, prefersReducedMotion() || document.documentElement.dataset.orbisEffects === 'low', backdropReady);
    return () => {
      stopWaiting();
      releaseBackdrop();
    };
  }, [morph]);
  useLayoutEffect(() => {
    if (!morph || expandingAuth) return;
    const resized = () => {
      if (galaxy.current) settleSessionMorphViewport(morph, galaxy.current);
    };
    window.addEventListener('resize', resized);
    window.visualViewport?.addEventListener('resize', resized);
    return () => {
      window.removeEventListener('resize', resized);
      window.visualViewport?.removeEventListener('resize', resized);
    };
  }, [morph, expandingAuth]);
  const needsDetail = attention || Boolean(children);
  const workspaceSpace =
    !morph && !firstBoot && !setupSpace && !setupHandoff && !loggingOff && !resumingLogout && !status && !needsDetail && progress === undefined;
  const scanning = !setupSigningIn && !morph && !loggingOff && !resumingLogout && !signingIn && !needsDetail && progress === undefined;
  const percentage = formationProgress(progress);
  const title = setupSigningIn
    ? 'Signing in'
    : ((resetPhase === 'handoff'
        ? 'Starting Orbis'
        : resetPhase === 'accepted' && !needsDetail
          ? 'Resetting preferences'
          : needsDetail
            ? (label ?? status?.title)
            : (status?.title ?? label)) ??
      (loggingOff || resumingLogout
        ? 'Logging off'
        : signingIn
          ? 'Signing in'
          : (status?.title ?? (setupSpace ? 'Preparing Orbis' : 'Loading your workspace'))));
  const message =
    status?.message ??
    (setupSpace
      ? 'Getting your choices ready for Home.'
      : loggingOff || resumingLogout
        ? 'Closing this session safely.'
        : 'Preparing your workspace and wallpaper.');
  const content = (
    <div
      ref={surface}
      className={`orbis-startup orbis-startup-redesigned orbis-startup-loading-space${morph ? ' orbis-startup-session' : ''}${current ? ' orbis-theme' : ''}${setupSpace || setupHandoff ? ' orbis-startup-setup-space' : ''}${loggingOff ? ' orbis-logout-surface' : signingIn ? ' orbis-login-surface' : ''}${overlay ? ' orbis-startup-overlay' : ''}`}
      data-session-state={loggingOff || resumingLogout ? 'logging-out' : signingIn || setupSigningIn ? 'signing-in' : status ? 'updating' : 'loading'}
      data-first-boot={firstBoot || undefined}
      data-workspace-space={workspaceSpace || undefined}
      data-centered-loading={!needsDetail || undefined}
      data-setup-handoff={setupHandoff || undefined}
      data-setup-sign-in={setupSigningIn || undefined}
      data-landing={landing || undefined}
      data-expanding-auth={expandingAuth || undefined}
      data-morph-ready={morphVisible || undefined}
      data-reset-ready={resetting || undefined}
      data-revealing={revealing || undefined}
      data-completing={completing || undefined}
      data-initial-startup={initial || undefined}
      style={
        morph
          ? ({
              ...captured?.colours,
              '--orbis-session-background': morph.background,
              '--orbis-session-shade': morph.shade,
              '--orbis-session-dim': morph.dim,
            } as CSSProperties)
          : fresh && !serverAppearance
            ? { backgroundImage: 'none' }
            : undefined
      }
      aria-live="polite"
      aria-busy="true"
      data-desktop-mode={current ? mode : undefined}
      data-desktop-preset={current?.preset}
      data-desktop-wallpaper={current ? resolveWallpaperKey(current) : undefined}
    >
      {morph?.backdrop ? (
        <div className="desktop-wallpaper-layer" data-wallpaper-state="ready" aria-hidden="true">
          <img src={morph.backdrop.src} alt="" decoding="async" style={{ ...morph.backdrop.style, opacity: 1 } as CSSProperties} />
          <div className="desktop-wallpaper-shade" />
          <div className="desktop-wallpaper-dim" />
        </div>
      ) : (!setupSpace || prepareWallpaper || landing || morph) && current ? (
        <WallpaperLayer choice={current} />
      ) : null}
      {morph ? null : <InterstellarBackdrop />}
      <div className="orbis-startup-content">
        <div
          ref={galaxy}
          className="orbis-session-galaxy"
          style={
            morph
              ? { position: 'fixed', left: morph.from.left, top: morph.from.top, width: morph.from.width, height: morph.from.height, opacity: 0 }
              : undefined
          }
          aria-hidden="true"
        >
          {resetting ? null : (
            <StartupMark
              ready={morphVisible}
              label={title}
              formationOwner={morph ?? formationOwner}
              formationPhase={setupSigningIn ? 'setup' : undefined}
              assemble={!morph && !resetting && !status && !needsDetail && progress === undefined}
              variant={morph || setupSigningIn ? 'session' : firstBoot ? 'setup' : 'workspace'}
            />
          )}
        </div>
        <div className="orbis-startup-copy">
          <h1 className="orbis-startup-title" id={titleId}>
            <span className="orbis-startup-message-loading">{title}</span>
            <span className="orbis-startup-message-reset">Resetting preferences</span>
            <span className="orbis-startup-message-handoff">Starting Orbis</span>
          </h1>
          {scanning || progress !== undefined ? (
            <div className={percentage === undefined ? 'orbis-startup-scan' : 'orbis-startup-progress-meter'}>
              <RecoveryProgressBar label={title} percentage={percentage} variant={percentage === undefined ? 'scan' : 'bar'} />
              {percentage !== undefined ? <span aria-hidden="true">{Math.floor(percentage)}%</span> : null}
            </div>
          ) : null}
          {needsDetail ? <p className="orbis-startup-detail">{message}</p> : null}
        </div>
        {children ? <div className="orbis-startup-actions">{children}</div> : null}
      </div>
    </div>
  );
  return overlay && !initial && typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}
