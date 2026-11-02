export function reloadDestination({
  navigationType,
  pathname,
  authenticated,
  restorationIdle,
  authHandoff = false,
}: {
  navigationType: string | undefined;
  pathname: string;
  authenticated: boolean;
  restorationIdle: boolean;
  authHandoff?: boolean;
}) {
  if (navigationType !== 'reload' || !authenticated || !restorationIdle || authHandoff || pathname === '/dashboard') return null;
  return /^\/(monitor|updates|tasks|time-machine|settings|apps|app-store)(\/|$)/.test(pathname) ? '/dashboard' : null;
}
