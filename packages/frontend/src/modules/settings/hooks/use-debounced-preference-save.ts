import { useEffect, useRef, useState } from 'react';
import { useSettingsPreferenceActivity } from '../pages/settings-save';

export function useDebouncedPreferenceSave(
  draftKey: string | null,
  write: () => Promise<void>,
  { signal, ready = true, delay = 650, unsaved = false }: { signal?: AbortSignal; ready?: boolean; delay?: number; unsaved?: boolean } = {},
) {
  const current = useRef({ draftKey, write, signal });
  current.current = { draftKey, write, signal };
  const handled = useRef<{ key: string; signal?: AbortSignal } | null>(null);
  const running = useRef<{ signal?: AbortSignal } | null>(null);
  const [result, setResult] = useState<{ signal?: AbortSignal; key: string; pending: boolean; error?: string } | null>(null);
  const [retryRequest, setRetryRequest] = useState<{ key: string; signal?: AbortSignal } | null>(null);
  const active = result?.signal === signal ? result : null;
  const pending = active?.pending === true && !signal?.aborted;
  const error = active?.key === draftKey ? active.error : undefined;
  const saved = Boolean(active && !active.pending && !active.error && !draftKey && !signal?.aborted);

  useEffect(() => {
    if (draftKey === null) handled.current = null;
    if (!draftKey || !ready || pending || signal?.aborted || (handled.current?.key === draftKey && handled.current.signal === signal)) return;
    const start = () => {
      if (running.current && running.current.signal === signal) return;
      if (current.current.draftKey !== draftKey || current.current.signal !== signal || signal?.aborted) return;
      const attempt = { signal };
      handled.current = { key: draftKey, signal };
      setRetryRequest(null);
      running.current = attempt;
      setResult({ signal, key: draftKey, pending: true });
      const commit = current.current.write;
      void Promise.resolve()
        .then(() => {
          signal?.throwIfAborted();
          return commit();
        })
        .then(
          () => {
            if (running.current === attempt) running.current = null;
            if (current.current.signal === signal && !signal?.aborted) setResult({ signal, key: draftKey, pending: false });
          },
          (failure: unknown) => {
            if (running.current === attempt) running.current = null;
            if (current.current.signal !== signal || signal?.aborted) return;
            setResult({
              signal,
              key: draftKey,
              pending: false,
              error: failure instanceof Error ? failure.message : 'The change could not be saved.',
            });
          },
        );
    };
    if (delay === 0 || (retryRequest?.key === draftKey && retryRequest.signal === signal)) {
      start();
      return;
    }
    const timer = setTimeout(start, delay);
    return () => clearTimeout(timer);
  }, [draftKey, ready, delay, signal, pending, retryRequest]);

  const retry = () => {
    handled.current = null;
    if (draftKey) setRetryRequest({ key: draftKey, signal });
  };
  useSettingsPreferenceActivity(pending, saved, unsaved || draftKey !== null);
  return { pending, saved, error, retry };
}
