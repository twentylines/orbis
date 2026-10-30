import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { readThemeApplyHandoff, clearThemeApplyHandoff, type ThemeApplyHandoff } from './theme-apply-handoff';
import { themePacksRequest } from './theme-packs-api';
import { cacheThemePackSelection } from './use-theme-pack';
import { sameTheme, themeApplyAcknowledged } from './theme-apply-state';
import { decodeThemePackCache, themePackCacheKey } from './theme-pack-cache';

export function useThemeApplyStartup() {
  const [handoff, setHandoff] = useState<ThemeApplyHandoff | null>(null);
  const [status, setStatus] = useState<'idle' | 'checking' | 'verified' | 'error'>('idle');
  const verified = useRef(false);
  useLayoutEffect(() => {
    const value = readThemeApplyHandoff();
    if (value) {
      document.documentElement.setAttribute('data-orbis-theme-reload', 'checking');
      setHandoff(value);
      setStatus('checking');
    } else document.documentElement.removeAttribute('data-orbis-theme-reload');
  }, []);
  useLayoutEffect(() => {
    if (!handoff) return;
    const controller = new AbortController();
    let first = 0;
    let second = 0;
    verified.current = false;
    setStatus('checking');
    void themePacksRequest('', 'GET', undefined, controller.signal)
      .then((snapshot) => {
        if (controller.signal.aborted) return;
        if (!themeApplyAcknowledged(snapshot, { target: handoff.selected, kind: 'select' })) throw new Error('Theme selection changed.');
        cacheThemePackSelection(snapshot.state);
        const raw = localStorage.getItem(themePackCacheKey);
        if (snapshot.state.selected ? !sameTheme(decodeThemePackCache(raw), snapshot.state.selected) : raw !== null)
          throw new Error('Theme cache unavailable.');
        first = requestAnimationFrame(() => {
          second = requestAnimationFrame(() => {
            if (controller.signal.aborted) return;
            verified.current = true;
            setStatus('verified');
          });
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    return () => {
      controller.abort();
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [handoff]);
  useLayoutEffect(() => {
    if (status === 'verified') document.documentElement.removeAttribute('data-orbis-theme-reload');
  }, [status]);
  const cancel = useCallback(() => {
    verified.current = false;
    clearThemeApplyHandoff();
    setHandoff(null);
    setStatus('idle');
  }, []);
  const complete = useCallback(() => {
    if (verified.current) {
      verified.current = false;
      clearThemeApplyHandoff();
      setHandoff(null);
      setStatus('idle');
    }
  }, []);
  return {
    pending: status === 'checking' || status === 'error',
    active: handoff !== null,
    error: status === 'error',
    retry: () => setHandoff((value) => (value ? { ...value } : null)),
    cancel,
    complete,
  };
}
