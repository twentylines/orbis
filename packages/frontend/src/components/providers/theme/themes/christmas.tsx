import { useReducedMotion } from '@/desktop/motion-preferences';
import type { LetItGo } from 'let-it-go';
import { type PropsWithChildren, useEffect, useRef } from 'react';
import { useDesktopPreferences } from '@/desktop/preferences';
import './christmas.css';

export const ChristmasTheme = (props: PropsWithChildren) => {
  const root = useRef<HTMLDivElement>(null);
  const { preferences, resolvedMode } = useDesktopPreferences();
  const preset = preferences.preset;
  const reducedMotion = useReducedMotion();

  // biome-ignore lint/correctness/useExhaustiveDependencies: Palette changes update the computed canvas colour.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let disposed = false;
    let snow: LetItGo | undefined;
    const sync = () => {
      if (disposed) return;
      if (reducedMotion || document.hidden) {
        snow?.clear();
        snow = undefined;
        return;
      }
      if (snow) return;
      void import('let-it-go')
        .then(({ LetItGo: Snow }) => {
          if (disposed || reducedMotion || document.hidden || snow) return;
          snow = new Snow({
            root: element,
            number: 50,
            color: getComputedStyle(element).getPropertyValue('--desktop-ink').trim(),
            style: { pointerEvents: 'none' },
          });
        })
        .catch((error: unknown) => console.warn('Seasonal animation could not start', error));
    };
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', sync);
      snow?.clear();
    };
  }, [preset, resolvedMode, reducedMotion]);

  return (
    <>
      {props.children}
      <div className="orbis-seasonal-effect" aria-hidden="true">
        <div ref={root} />
      </div>
    </>
  );
};
