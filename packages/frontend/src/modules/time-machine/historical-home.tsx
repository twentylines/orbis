import { useEffect, useRef, useState } from 'react';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { historicalAssetPath } from './contracts';
import { readHistoricalWallpaper } from './time-machine-api';

export function useHistoricalWallpaper(point: TimeMachinePoint | undefined, visible: boolean, session: AbortSignal) {
  const path = point ? historicalAssetPath(point) : null;
  const current = useRef(point);
  current.current = point;
  const [attempt, setAttempt] = useState(0);
  const [asset, setAsset] = useState<{ path: string; url: string; session: AbortSignal; attempt: number } | null>(null);
  const [failure, setFailure] = useState<{ path: string; session: AbortSignal; attempt: number } | null>(null);
  useEffect(() => {
    const selected = current.current;
    if (!visible || !path || !selected || session.aborted) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([session, abort.signal]);
    let url: string | undefined;
    setFailure(null);
    void readHistoricalWallpaper(selected, signal)
      .then((blob) => {
        if (signal.aborted) return;
        url = URL.createObjectURL(blob);
        setAsset({ path, url, session, attempt });
      })
      .catch(() => {
        if (!signal.aborted) setFailure({ path, session, attempt });
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, session, visible, attempt]);
  const url = visible && asset?.path === path && asset.session === session && asset.attempt === attempt && !session.aborted ? asset.url : null;
  const failed = failure?.path === path && failure.session === session && failure.attempt === attempt;
  return { url, failed, loading: Boolean(visible && path && !url && !failed), retry: () => setAttempt((value) => value + 1) };
}
