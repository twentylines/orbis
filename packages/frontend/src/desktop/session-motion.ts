import { currentSessionMorphExit } from '@/components/startup/session-morph';

const logoutStorageKey = 'orbis-session-exit';

export const sessionExitBootstrap = `(()=>{
  try {
    const saved=Number(sessionStorage.getItem(${JSON.stringify(logoutStorageKey)}));
    const elapsed=Date.now()-saved;
    if(saved>0&&elapsed>=0&&elapsed<15000)document.documentElement.dataset.orbisSessionState='logging-out';
  } catch {}
})();`;

export function rememberLogout(active: boolean) {
  if (typeof document !== 'undefined') {
    if (active) document.documentElement.dataset.orbisSessionState = 'logging-out';
    else delete document.documentElement.dataset.orbisSessionState;
  }
  try {
    if (active) sessionStorage.setItem(logoutStorageKey, String(Date.now()));
    else sessionStorage.removeItem(logoutStorageKey);
  } catch {
    return;
  }
}

export function isLoggingOff() {
  try {
    const saved = Number(sessionStorage.getItem(logoutStorageKey));
    const elapsed = Date.now() - saved;
    return saved > 0 && elapsed >= 0 && elapsed < 15000;
  } catch {
    return false;
  }
}

export function animateSessionExit(_desktop: HTMLElement | null, _reduced: boolean) {
  return currentSessionMorphExit();
}

export function animateAuthExit(_reduced: boolean) {
  return currentSessionMorphExit();
}

export function animateStartupExit(element: HTMLElement | null, reduced: boolean) {
  const animations: Animation[] = [];
  if (element && !reduced) {
    const content = element.querySelector<HTMLElement>('.orbis-startup-content');
    if (content)
      animations.push(
        content.animate(
          [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: 'translateY(-12px) scale(.97)' },
          ],
          { duration: 240, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' },
        ),
      );
    animations.push(element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }));
  }
  return {
    finished: Promise.allSettled(animations.map((animation) => animation.finished)),
    cancel: () => {
      for (const animation of animations) animation.cancel();
    },
  };
}
