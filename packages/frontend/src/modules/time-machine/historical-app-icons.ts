import { useEffect, useRef, useState } from 'react';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { readHistoricalAppIcons as loadHistoricalAppIcons } from './historical-icon-reader';
export const readHistoricalAppIcons = loadHistoricalAppIcons;

export function useHistoricalAppIcons(point: TimeMachinePoint) {
  const current = useRef(point);
  current.current = point;
  const identity = point.metadata?.preview.available ? point.metadata.preview.appIcons?.identity : undefined;
  const binding = `${point.id}/${identity ?? ''}`;
  const [saved, setSaved] = useState<{ binding: string; urls: Record<string, string> } | null>(null);
  useEffect(() => {
    if (!identity) return;
    const abort = new AbortController();
    const urls: Record<string, string> = {};
    void readHistoricalAppIcons(current.current, abort.signal)
      .then((icons) => {
        if (abort.signal.aborted) return;
        for (const icon of icons) urls[icon.urn] = URL.createObjectURL(icon.blob);
        setSaved({ binding, urls });
      })
      .catch(() => undefined);
    return () => {
      abort.abort();
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    };
  }, [binding, identity]);
  return saved?.binding === binding ? saved.urls : {};
}
