import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { StartupSurface } from './startup-surface';
import { startupCycleRemaining } from './startup-timing';
import { useThemeApplyStartup } from '@/modules/theme-packs/use-theme-apply-startup';
import { ThemeApplyCover } from '@/modules/theme-packs/theme-apply-cover';

const ReadyContext = createContext<(ready: boolean) => void>(() => undefined);
type SessionTransition = 'signing-in' | 'logging-out';
const SessionContext = createContext<{ begin: (transition?: SessionTransition) => void; finish: () => Promise<void> }>({
  begin: () => undefined,
  finish: async () => undefined,
});
export const useStartupSession = () => useContext(SessionContext);

export function useStartupReady(ready: boolean) {
  const setReady = useContext(ReadyContext);
  useLayoutEffect(() => setReady(ready), [ready, setReady]);
}

export function StartupBoundary({ children }: PropsWithChildren) {
  const [ready, setReady] = useState(false);
  const themeHandoff = useThemeApplyStartup();
  const [phase, setPhase] = useState<'loading' | 'finishing' | 'revealing' | 'complete'>('loading');
  const surface = useRef<HTMLDivElement>(null);
  const [sessionTransition, setSessionTransition] = useState<SessionTransition | null>(null);
  const [sessionPending, setSessionPending] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const finished = useRef<Array<() => void>>([]);
  const begin = useCallback((transition: SessionTransition = 'signing-in') => {
    setSessionTransition(transition);
    setSessionPending(true);
    setPhase('loading');
  }, []);
  const finish = useCallback(() => {
    setSessionPending(false);
    if (phaseRef.current === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => finished.current.push(resolve));
  }, []);
  const session = useMemo(() => ({ begin, finish }), [begin, finish]);

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
      for (const resolve of finished.current.splice(0)) resolve();
    }
  }, [phase, themeHandoff.complete]);

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
            signingIn={sessionTransition === 'signing-in'}
            loggingOff={sessionTransition === 'logging-out'}
            status={themeHandoff.active && !themeHandoff.pending ? { title: 'Loading theme…', message: 'Preparing your workspace.' } : undefined}
            completing={phase !== 'loading'}
            revealing={phase === 'revealing'}
          />
        )}
      </ReadyContext.Provider>
    </SessionContext.Provider>
  );
}
