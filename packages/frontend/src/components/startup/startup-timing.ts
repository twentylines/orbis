export const startupCycle = 1400;
export const setupLandingDuration = 1200;
export const setupPreparationMinimum = 1600;
export const setupCircleDuration = 1700;
export function waitForStartupFormation(surface: HTMLElement | null, complete: () => void) {
  let active = true;
  const wait = () => {
    if (!active) return;
    const clusters = surface?.querySelectorAll?.('.orbis-startup-mark .orbis-logo-dot-layer, .orbis-startup-mark .orbis-logo-dot-group') ?? [];
    const animations = Array.from(clusters).flatMap((cluster) => cluster.getAnimations?.() ?? []);
    if (animations.length)
      void Promise.allSettled(animations.map((animation) => animation.finished)).then((results) => {
        if (!active) return;
        if (results.some((result) => result.status === 'rejected')) wait();
        else complete();
      });
    else complete();
  };
  wait();
  return () => {
    active = false;
  };
}
export function startupPhaseDelay(phase: 'circle' | 'finishing' | 'revealing', landing: boolean, reduced: boolean) {
  return reduced ? 0 : phase === 'circle' ? setupCircleDuration : phase === 'finishing' ? 200 : landing ? setupLandingDuration : 420;
}

export function startupCycleRemaining(elapsed: number) {
  const time = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return Math.max(0, Math.ceil(Math.max(1, time) / startupCycle) * startupCycle - time);
}
