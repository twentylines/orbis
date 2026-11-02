import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useOperationStartup } from './operation-startup';
import { StartupSurface } from './startup-surface';
import { startupCycleRemaining } from './startup-timing';
import { useThemeApplyStartup } from '@/modules/theme-packs/use-theme-apply-startup';
import { ThemeApplyCover } from '@/modules/theme-packs/theme-apply-cover';
import { showSetupSpace } from './sign-in-onboarding';

const ReadyContext = createContext<(ready: boolean) => void>(() => undefined);
type SessionTransition = 'signing-in' | 'logging-out' | 'preparing-orbis';
const SessionContext = createContext<{
  begin: (transition?: SessionTransition, firstSetup?: boolean) => void;
  finish: () => Promise<void>;
  setFirstSetup: (value: boolean) => void;
}>({
  begin: () => undefined,
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
  const [phase, setPhase] = useState<'loading' | 'finishing' | 'revealing' | 'complete'>('loading');
  const surface = useRef<HTMLDivElement>(null);
  const [sessionTransition, setSessionTransition] = useState<SessionTransition | null>(null);
  const transitionRef = useRef<SessionTransition | null>(null);
  transitionRef.current = sessionTransition;
  const [sessionPending, setSessionPending] = useState(false);
  const [firstSetup, setFirstSetup] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const finished = useRef<Array<() => void>>([]);
  const begin = useCallback((transition: SessionTransition = 'signing-in', firstSetup?: boolean) => {
    transitionRef.current = transition;
    if (firstSetup !== undefined) setFirstSetup(firstSetup);
    setSessionTransition(transition);
    setSessionPending(true);
    setPhase('loading');
  }, []);
  const finish = useCallback(() => {
    setSessionPending(false);
    if (phaseRef.current === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => finished.current.push(resolve));
  }, []);
  const reportFirstSetup = useCallback((value: boolean) => {
    if (transitionRef.current !== 'signing-in') setFirstSetup(value);
  }, []);
  const session = useMemo(() => ({ begin, finish, setFirstSetup: reportFirstSetup }), [begin, finish, reportFirstSetup]);

  useLayoutEffect(() => {
    if (!ready && phase === 'complete') setPhase('loading');
  }, [ready, phase]);

  useEffect(() => {
    if (!ready || sessionPending || themeHandoff.pending || phase !== 'loading') return;
    const progress = surface.current?.querySelector('.orbis-startup-progress > span');
    const cycle = progress
      ?.getAnimations()
      .find((animation) => animation instanceof CSSAnimation && animation.animationName === 'orbis-startup-flow');
    const elapsed = typeof cycle?.currentTime === 'number' ? cycle.currentTime : 0;
    const timer = window.setTimeout(() => setPhase('finishing'), prefersReducedMotion() ? 0 : startupCycleRemaining(elapsed));
    return () => window.clearTimeout(timer);
  }, [ready, sessionPending, phase, themeHandoff.pending]);

  useEffect(() => {
    if (phase !== 'finishing' && phase !== 'revealing') return;
    if (!ready) return;
    const timer = window.setTimeout(
      () => setPhase(phase === 'finishing' ? 'revealing' : 'complete'),
      prefersReducedMotion() ? 0 : phase === 'finishing' ? 200 : 420,
    );
    return () => window.clearTimeout(timer);
  }, [phase, ready]);

  useLayoutEffect(() => {
    if (phase === 'revealing') window.dispatchEvent(new Event('orbis-startup-reveal'));
    if (phase === 'complete') {
      setSessionTransition(null);
      themeHandoff.complete();
      operationBoot.complete();
      for (const resolve of finished.current.splice(0)) resolve();
    }
  }, [phase, themeHandoff.complete, operationBoot.complete]);

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
            setupSpace={showSetupSpace(firstSetup, sessionTransition, operationBoot.operation, themeHandoff.active)}
            signingIn={sessionTransition === 'signing-in'}
            loggingOff={sessionTransition === 'logging-out'}
            label={sessionTransition === 'preparing-orbis' ? 'Preparing Orbis' : undefined}
            status={themeHandoff.active && !themeHandoff.pending ? { title: 'Loading theme…', message: 'Preparing your workspace.' } : undefined}
            completing={phase !== 'loading'}
            revealing={phase === 'revealing'}
          />
        )}
      </ReadyContext.Provider>
    </SessionContext.Provider>
  );
}
