import { useLayoutEffect, useState } from 'react';
import { readCachedAppearance, type CachedAppearance } from '@/desktop/appearance-cache';
import { useResolvedColourMode } from '@/desktop/colour-mode';

export function StartupSurface({ appearance }: { appearance?: CachedAppearance }) {
  const [cached, setCached] = useState<CachedAppearance | null>(null);
  useLayoutEffect(() => setCached(readCachedAppearance()), []);
  const current = appearance ?? cached;
  const mode = useResolvedColourMode(current?.mode ?? 'light');
  return (
    <div
      className={`orbis-startup${current ? ' orbis-theme' : ''}`}
      data-desktop-mode={current ? mode : undefined}
      data-desktop-preset={current?.preset}
      data-desktop-wallpaper={current?.wallpaper}
    >
      <div className="orbis-startup-content">
        <img src="/icons/orbis.svg" width={64} height={64} alt="" />
        <span className="orbis-startup-name">Orbis</span>
        <output>Loading workspace…</output>
      </div>
    </div>
  );
}
