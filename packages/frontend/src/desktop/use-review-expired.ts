import { useEffect, useReducer } from 'react';

export function useReviewExpired(deadline: number | undefined) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (deadline === undefined || !Number.isFinite(deadline)) return;
    let timer: number | undefined;
    const schedule = () => {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        timer = window.setTimeout(
          () => {
            refresh();
            schedule();
          },
          Math.min(remaining + 1, 2_147_483_647),
        );
      }
    };
    const recheck = () => {
      window.clearTimeout(timer);
      refresh();
      schedule();
    };
    schedule();
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [deadline]);
  return deadline !== undefined && (!Number.isFinite(deadline) || deadline <= Date.now());
}
