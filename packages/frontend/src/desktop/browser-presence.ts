import { useEffect } from 'react';
import { useWindowVisible } from './window-visibility';

export function useBrowserPresence(needed: boolean) {
  const visible = useWindowVisible();
  useEffect(() => {
    if (!visible || !needed) return;
    let request: AbortController | undefined;
    let stopped = false;
    let timer: number | undefined;
    const notify = async () => {
      if (stopped) return;
      request = new AbortController();
      try {
        const response = await fetch('/api/monitoring/presence', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]),
        });
        if (response.status === 401 || response.status === 403) {
          stopped = true;
          window.clearInterval(timer);
        }
      } catch {
        /* The authenticated SSE connection remains the primary presence signal. */
      }
    };
    void notify();
    timer = window.setInterval(() => void notify(), 30_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      request?.abort();
    };
  }, [visible, needed]);
}
