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

export function animateSessionExit(desktop: HTMLElement | null, reduced: boolean) {
  const animations: Animation[] = [];
  if (desktop && !reduced) {
    const parts = [
      { selector: '.desktop-system-bar', transform: 'translateY(-16px) scale(.985)', duration: 280 },
      { selector: '.desktop-main', transform: 'translateY(18px) scale(.985)', duration: 320 },
      { selector: '.desktop-dock', transform: 'translate(-50%, 25px) scale(.93)', duration: 360 },
    ];
    for (const part of parts) {
      const element = desktop.querySelector<HTMLElement>(part.selector);
      if (element && typeof element.animate === 'function') {
        animations.push(
          element.animate(
            [
              { opacity: 1, transform: getComputedStyle(element).transform },
              { opacity: 0, transform: part.transform },
            ],
            { duration: part.duration, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' },
          ),
        );
      }
    }
  }
  return {
    finished: Promise.allSettled(animations.map((animation) => animation.finished)),
    cancel: () => {
      for (const animation of animations) animation.cancel();
    },
  };
}

export function animateAuthExit(reduced: boolean) {
  const element = document.querySelector<HTMLElement>('.desktop-auth-container');
  const animation =
    element && !reduced
      ? element.animate(
          [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: 'translateY(18px) scale(.985)' },
          ],
          { duration: 320, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' },
        )
      : null;
  return { cancel: () => animation?.cancel() };
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
  return { finished: Promise.allSettled(animations.map((animation) => animation.finished)) };
}
