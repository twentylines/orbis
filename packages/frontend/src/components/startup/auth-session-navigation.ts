import { safeReturnTo } from '@/desktop/secure-access';
import { createBrowserId } from '@/lib/browser-id';

const authenticatedKey = 'orbis-session-authenticated-v1';
const sessionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const endDesktopSessionEvent = 'orbis-end-desktop-session';

export function authenticatedSessionId(storage: SessionStorage) {
  try {
    const value = storage.getItem(authenticatedKey);
    return value && sessionIdPattern.test(value) ? value : null;
  } catch {
    return null;
  }
}
export function currentAuthenticatedSessionId() {
  try {
    return authenticatedSessionId(window.sessionStorage);
  } catch {
    return null;
  }
}
export function rememberAuthenticatedSession(storage: SessionStorage, createId = createBrowserId) {
  try {
    if (!authenticatedSessionId(storage)) {
      const id = createId();
      if (sessionIdPattern.test(id)) storage.setItem(authenticatedKey, id);
    }
  } catch {
    /* Navigation falls back to Dashboard. */
  }
}
export function forgetAuthenticatedSession(storage: SessionStorage) {
  try {
    storage.removeItem(authenticatedKey);
  } catch {
    /* Navigation falls back to Dashboard. */
  }
}
export function signInDestination(returnTo: string | null, state: unknown, sessionId: string | null) {
  const target = safeReturnTo(returnTo);
  if (!target || !sessionId || !sessionIdPattern.test(sessionId) || !state || typeof state !== 'object') return '/dashboard';
  if (!('orbisSessionRecovery' in state) || !('orbisSessionId' in state)) return '/dashboard';
  return state.orbisSessionRecovery === target && state.orbisSessionId === sessionId ? target : '/dashboard';
}
