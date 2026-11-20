import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useOperationStartup } from './operation-startup';
import { StartupSurface } from './startup-surface';
import { waitForStartupWallpapers } from './wallpaper-ready';
import { waitForWorkspaceReady } from './workspace-ready';
import { startupPhaseDelay, waitForStartupFormation } from './startup-timing';
import { useThemeApplyStartup } from '@/modules/theme-packs/use-theme-apply-startup';
import { ThemeApplyCover } from '@/modules/theme-packs/theme-apply-cover';
import { showSetupSpace } from './sign-in-onboarding';
import { completeResetStartup } from './reset-startup';
import { rememberLogout } from '@/desktop/session-motion';
import { beginSessionMorph, expandSessionMorph, type SessionMorph } from './session-morph';

const ReadyContext = createContext<(ready: boolean) => void>(() => undefined);
type SessionTransition = 'signing-in' | 'logging-out' | 'preparing-orbis';
const SessionContext = createContext<{
  begin: (transition?: SessionTransition, firstSetup?: boolean, setupStage?: string) => void;
  setSetupStage: (stage: string) => void;
  finish: () => Promise<void>;
  setFirstSetup: (value: boolean) => void;
}>({
  begin: () => undefined,
  setSetupStage: () => undefined,
  finish: async () => undefined,
  setFirstSetup: () => undefined,
});
export const useStartupSession = () => useContext(SessionContext);

export function useStartupReady(ready: boolean) {
  const setReady = useContext(ReadyContext);
  useLayoutEffect(() => setReady(ready), [ready, setReady]);
}

export function StartupBoundary({ children }: PropsWithChildren) {
  const [ready, setReady] = useState(false);
  const themeHandoff = useThemeApplyStartup();
  const operationBoot = useOperationStartup();
  const [phase, setPhase] = useState<'loading' | 'circle' | 'finishing' | 'revealing' | 'complete'>('loading');
  const surface = useRef<HTMLDivElement>(null);
  const setupFormationOwner = useRef<object>({});
  const workspaceFormationOwner = useRef<object>(typeof document === 'undefined' ? {} : document);
  const [morph, setMorph] = useState<SessionMorph | null>(null);
  const morphRef = useRef<SessionMorph | null>(null);
  const [authDestination, setAuthDestination] = useState<HTMLElement | null>(null);
  const [homeLanding, setHomeLanding] = useState(false);
  const [authExpansion, setAuthExpansion] = useState(false);
  const expansionRun = useRef(0);
  const expansionController = useRef<AbortController | null>(null);
  const restoreAuth = useRef<(() => void) | null>(null);
  const [sessionTransition, setSessionTransition] = useState<SessionTransition | null>(null);
  const transitionRef = useRef<SessionTransition | null>(null);
  transitionRef.current = sessionTransition;
  const [sessionPending, setSessionPending] = useState(false);
  const [firstSetup, setFirstSetup] = useState(false);
  const [setupStage, setSetupStage] = useState('Preparing Orbis');
  const [workspaceSlow, setWorkspaceSlow] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const finished = useRef<Array<() => void>>([]);
  const begin = useCallback((transition: SessionTransition = 'signing-in', firstSetup?: boolean, stage?: string) => {
    expansionController.current?.abort();
    expansionController.current = null;
    restoreAuth.current?.();
    restoreAuth.current = null;
    const nextMorph = transition === 'preparing-orbis' ? null : beginSessionMorph(transition);
    morphRef.current = nextMorph;
    setMorph(nextMorph);
    setAuthExpansion(false);
    setWorkspaceSlow(false);
    expansionRun.current++;
    transitionRef.current = transition;
    if (transition === 'preparing-orbis') {
      setupFormationOwner.current = {};
      setSetupStage(stage ?? 'Preparing Orbis');
    }
    if (firstSetup !== undefined) setFirstSetup(firstSetup);
    setSessionTransition(transition);
    setSessionPending(true);
    setPhase('loading');
  }, []);
  const finish = useCallback(() => {
    setSessionPending(false);
    if (morphRef.current?.cancelled) {
      setPhase('complete');
      return Promise.resolve();
    }
    if (phaseRef.current === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => finished.current.push(resolve));
  }, []);
  const reportFirstSetup = useCallback((value: boolean) => {
    if (transitionRef.current !== 'signing-in' && transitionRef.current !== 'preparing-orbis') setFirstSetup(value);
  }, []);
  const session = useMemo(() => ({ begin, finish, setFirstSetup: reportFirstSetup, setSetupStage }), [begin, finish, reportFirstSetup]);

  useLayoutEffect(() => {
    if (!ready && phase === 'complete') setPhase('loading');
  }, [ready, phase]);
  useLayoutEffect(() => {
    const changed = () => setAuthDestination(document.querySelector<HTMLElement>('.desktop-auth:not(.desktop-auth-setup)'));
    window.addEventListener('orbis-auth-card-ready', changed);
    return () => {
      window.removeEventListener('orbis-auth-card-ready', changed);
      expansionRun.current++;
      expansionController.current?.abort();
      expansionController.current = null;
      restoreAuth.current?.();
      morphRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!ready || sessionPending || themeHandoff.pending || phase !== 'loading') return;
    const authTarget = authDestination?.isConnected ? authDestination : document.querySelector<HTMLElement>('.desktop-auth:not(.desktop-auth-setup)');
    const desktopTarget = document.querySelector<HTMLElement>('.desktop');
    const guestTarget = desktopTarget?.classList.contains('desktop-guest');
    if (
      morph &&
      !morph.cancelled &&
      (sessionTransition === 'logging-out' ? !authTarget && !guestTarget : !desktopTarget && !document.querySelector('.desktop-auth-setup'))
    )
      return;
    let timer: number | undefined;
    let stopFormation: (() => void) | undefined;
    const reveal = () => {
      setHomeLanding(sessionTransition === 'preparing-orbis' || Boolean(document.querySelector('.desktop-view-home, .desktop-guest')));
      if (sessionTransition === 'preparing-orbis') {
        setPhase('circle');
        return;
      }
      const shell = surface.current?.querySelector<HTMLElement>('.orbis-session-galaxy');
      if (morph && authTarget && shell && !morph.cancelled) {
        setAuthExpansion(true);
        setPhase('finishing');
        document.documentElement.dataset.orbisSessionMorph = 'expanding-auth';
        window.dispatchEvent(new Event('orbis-startup-reveal'));
        const run = ++expansionRun.current;
        const controller = new AbortController();
        expansionController.current = controller;
        void expandSessionMorph(
          shell,
          authTarget,
          prefersReducedMotion() || document.documentElement.dataset.orbisEffects === 'low',
          controller.signal,
        ).then((restore) => {
          if (run === expansionRun.current) {
            restoreAuth.current = restore ?? null;
            setPhase('complete');
          } else restore?.();
        });
        return;
      }
      timer = window.setTimeout(() => setPhase('finishing'), 0);
    };
    const finishLoading = () => {
      if (!morph && !prefersReducedMotion() && document.documentElement.dataset.orbisEffects !== 'low')
        stopFormation = waitForStartupFormation(surface.current, reveal);
      else reveal();
    };
    const targets = [surface.current, desktopTarget, authTarget].filter((target): target is HTMLElement => Boolean(target));
    let wallpapersReady = false;
    let workspaceReady = false;
    const finishWhenReady = () => {
      if (wallpapersReady && workspaceReady) finishLoading();
    };
    const stopWaiting = waitForStartupWallpapers(targets, () => {
      wallpapersReady = true;
      finishWhenReady();
    });
    const stopWorkspace = waitForWorkspaceReady(
      desktopTarget,
      () => {
        workspaceReady = true;
        finishWhenReady();
      },
      () => setWorkspaceSlow(true),
    );
    return () => {
      stopWaiting();
      stopWorkspace();
      stopFormation?.();
      window.clearTimeout(timer);
    };
  }, [ready, sessionPending, phase, themeHandoff.pending, morph, sessionTransition, authDestination]);

  useEffect(() => {
    if (phase !== 'circle' && phase !== 'finishing' && phase !== 'revealing') return;
    if (!ready) return;
    if (authExpansion) return;
    const timer = window.setTimeout(
      () => setPhase(phase === 'circle' ? 'finishing' : phase === 'finishing' ? 'revealing' : 'complete'),
      startupPhaseDelay(phase, homeLanding, prefersReducedMotion() || document.documentElement.dataset.orbisEffects === 'low'),
    );
    return () => window.clearTimeout(timer);
  }, [phase, ready, homeLanding, authExpansion]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (phase === 'revealing' && homeLanding && !prefersReducedMotion() && root.dataset.orbisEffects !== 'low')
      root.dataset.orbisStartupLanding = 'true';
    else delete root.dataset.orbisStartupLanding;
    if (phase === 'revealing') window.dispatchEvent(new Event('orbis-startup-reveal'));
  }, [phase, homeLanding]);
  useLayoutEffect(() => {
    if (phase === 'complete') {
      completeResetStartup();
      rememberLogout(false);
      restoreAuth.current?.();
      restoreAuth.current = null;
      morphRef.current?.cancel();
      morphRef.current = null;
      setMorph(null);
      setAuthExpansion(false);
      setSessionTransition(null);
      themeHandoff.complete();
      operationBoot.complete();
      for (const resolve of finished.current.splice(0)) resolve();
    }
  }, [phase, themeHandoff.complete, operationBoot.complete]);
  useLayoutEffect(
    () => () => {
      delete document.documentElement.dataset.orbisStartupLanding;
    },
    [],
  );

  return (
    <SessionContext.Provider value={session}>
      <ReadyContext.Provider value={setReady}>
        {children}
        {themeHandoff.pending ? (
          <ThemeApplyCover
            label="Loading your theme…"
            error={themeHandoff.error ? 'Your theme could not be confirmed. Retry or cancel to return to the workspace.' : undefined}
            onRetry={themeHandoff.retry}
            onCancel={themeHandoff.cancel}
          />
        ) : null}
        {phase === 'complete' ? null : (
          <StartupSurface
            ref={surface}
            overlay
            initial
            freshAppearance={operationBoot.operation === 'restore'}
            setupSpace={
              sessionTransition === 'preparing-orbis' || showSetupSpace(firstSetup, sessionTransition, operationBoot.operation, themeHandoff.active)
            }
            prepareWallpaper={sessionTransition === 'preparing-orbis'}
            landing={homeLanding}
            morph={morph}
            firstBoot={sessionTransition === 'preparing-orbis' && phase === 'loading'}
            setupSigningIn={sessionTransition === 'preparing-orbis' && phase !== 'loading'}
            formationOwner={sessionTransition === 'preparing-orbis' ? setupFormationOwner.current : workspaceFormationOwner.current}
            expandingAuth={authExpansion}
            signingIn={sessionTransition === 'signing-in'}
            loggingOff={sessionTransition === 'logging-out'}
            label={sessionTransition === 'preparing-orbis' ? setupStage : undefined}
            attention={workspaceSlow}
            status={
              workspaceSlow
                ? { title: 'Your workspace could not finish loading', message: 'Check the connection and try again.' }
                : themeHandoff.active && !themeHandoff.pending
                  ? { title: 'Loading theme…', message: 'Preparing your workspace.' }
                  : undefined
            }
            completing={phase !== 'loading'}
            revealing={phase === 'revealing'}
          >
            {workspaceSlow ? (
              <button type="button" className="orbis-startup-return" onClick={() => window.location.reload()}>
                Retry
              </button>
            ) : null}
          </StartupSurface>
        )}
      </ReadyContext.Provider>
    </SessionContext.Provider>
  );
}
