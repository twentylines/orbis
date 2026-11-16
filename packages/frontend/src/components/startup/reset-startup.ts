const resetStartupKey = 'orbis-reset-startup-v1';
const resetStartupPhaseKey = 'orbis-reset-startup-phase-v1';
const resetStartupLifetime = 5 * 60 * 1000;
const resetStartupEvent = 'orbis-reset-startup-changed';

export function resetStartupPending(storage: Pick<Storage, 'getItem'>, now = Date.now()) {
  try {
    const raw = storage.getItem(resetStartupKey);
    if (!raw || raw.length > 16) return false;
    const started = Number(raw);
    return Number.isSafeInteger(started) && started > 0 && started <= now && now - started < resetStartupLifetime;
  } catch {
    return false;
  }
}

export type ResetStartupPhase = 'accepted' | 'handoff';
export function beginResetStartup(phase: ResetStartupPhase = 'handoff') {
  try {
    sessionStorage.setItem(resetStartupKey, String(Date.now()));
    sessionStorage.setItem(resetStartupPhaseKey, phase);
  } catch {
    // Keep the current document covered even when same-tab storage is unavailable.
  }
  document.documentElement.dataset.orbisResetStartup = 'true';
  document.documentElement.dataset.orbisResetPhase = phase;
  window.dispatchEvent(new Event(resetStartupEvent));
}

export function completeResetStartup() {
  try {
    sessionStorage.removeItem(resetStartupKey);
    sessionStorage.removeItem(resetStartupPhaseKey);
  } catch {
    // The visual marker never changes reset authority or its completion receipt.
  }
  delete document.documentElement.dataset.orbisResetStartup;
  delete document.documentElement.dataset.orbisResetPhase;
  window.dispatchEvent(new Event(resetStartupEvent));
}

export const readResetStartup = () => document.documentElement.dataset.orbisResetStartup === 'true';
export const readResetStartupPhase = () =>
  readResetStartup() ? (document.documentElement.dataset.orbisResetPhase === 'accepted' ? ('accepted' as const) : ('handoff' as const)) : null;
export const resetStartupPhaseServerSnapshot = () => null;
export const resetStartupServerSnapshot = () => false;
export function subscribeResetStartup(changed: () => void) {
  window.addEventListener(resetStartupEvent, changed);
  return () => window.removeEventListener(resetStartupEvent, changed);
}

export const resetStartupBootstrap = `try{const t=Number(sessionStorage.getItem('${resetStartupKey}'));if(Number.isSafeInteger(t)&&t>0&&t<=Date.now()&&Date.now()-t<${resetStartupLifetime}){document.documentElement.dataset.orbisResetStartup='true';document.documentElement.dataset.orbisResetPhase=sessionStorage.getItem('${resetStartupPhaseKey}')==='accepted'?'accepted':'handoff'}}catch{}`;
