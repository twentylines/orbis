type Network = EventTarget & { saveData?: boolean; effectiveType?: string };

export function observeNavigationPreload(onReady: (ready: boolean) => void) {
  const connection = (navigator as Navigator & { connection?: Network }).connection;
  let active = true;
  let ready = false;
  let idle: number | null = null;
  let timer: number | null = null;
  const cancel = () => {
    if (idle !== null) window.cancelIdleCallback(idle);
    if (timer !== null) window.clearTimeout(timer);
    idle = timer = null;
  };
  const update = () => {
    if (!active) return;
    const allowed =
      navigator.onLine !== false &&
      document.visibilityState === 'visible' &&
      !connection?.saveData &&
      !['slow-2g', '2g'].includes(connection?.effectiveType ?? '');
    if (!allowed) {
      cancel();
      if (ready) onReady(false);
      ready = false;
      return;
    }
    if (ready || idle !== null || timer !== null) return;
    const finish = () => {
      idle = timer = null;
      if (!active) return;
      ready = true;
      onReady(true);
    };
    if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(finish, { timeout: 1500 });
    else timer = window.setTimeout(finish, 200);
  };
  document.addEventListener('visibilitychange', update);
  connection?.addEventListener('change', update);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
  return () => {
    active = false;
    cancel();
    document.removeEventListener('visibilitychange', update);
    connection?.removeEventListener('change', update);
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}
