import { useEffect, useRef, useState } from 'react';
import { APP_WINDOW_GAP, APP_WINDOW_MIN_WIDTH, splitAppBounds } from './app-window-layout';
import type { WindowArea } from './window-geometry';

export function AppSplitDivider({ area, ratio, onChange }: { area: WindowArea; ratio: number; onChange: (ratio: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<number | null>(null);
  const pending = useRef(0);
  const latest = useRef(ratio);
  const start = useRef(ratio);
  const left = splitAppBounds('left', area, ratio);
  const minimum = APP_WINDOW_MIN_WIDTH / (area.width - APP_WINDOW_GAP);
  const change = (value: number) => {
    latest.current = Math.max(minimum, Math.min(1 - minimum, value));
    if (!pending.current)
      pending.current = requestAnimationFrame(() => {
        pending.current = 0;
        onChange(latest.current);
      });
  };
  const finish = (commit: boolean) => {
    cancelAnimationFrame(pending.current);
    pending.current = 0;
    pointer.current = null;
    onChange(commit ? latest.current : start.current);
    setDragging(false);
  };
  useEffect(() => () => cancelAnimationFrame(pending.current), []);
  return (
    <>
      {dragging ? <div className="app-split-resizing-shield" aria-hidden="true" /> : null}
      {/* biome-ignore lint/a11y/useSemanticElements: This focusable separator adjusts two panes with pointer and arrow keys; a static hr cannot express its value. */}
      <div
        role="separator"
        aria-label="Resize split screen apps"
        aria-orientation="vertical"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.ceil(minimum * 100)}
        aria-valuemax={Math.floor((1 - minimum) * 100)}
        tabIndex={0}
        className="app-split-divider"
        style={{ left: left.x + left.width, top: area.y, width: APP_WINDOW_GAP, height: area.height }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.current = event.pointerId;
          start.current = ratio;
          latest.current = ratio;
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (pointer.current === event.pointerId) change((event.clientX - area.x - APP_WINDOW_GAP / 2) / (area.width - APP_WINDOW_GAP));
        }}
        onPointerUp={(event) => {
          if (pointer.current === event.pointerId) finish(true);
        }}
        onPointerCancel={() => finish(false)}
        onLostPointerCapture={() => {
          if (pointer.current !== null) finish(false);
        }}
        onDoubleClick={() => onChange(0.5)}
        onKeyDown={(event) => {
          const next =
            event.key === 'ArrowLeft'
              ? ratio - (event.shiftKey ? 0.005 : 0.02)
              : event.key === 'ArrowRight'
                ? ratio + (event.shiftKey ? 0.005 : 0.02)
                : event.key === 'Home'
                  ? minimum
                  : event.key === 'End'
                    ? 1 - minimum
                    : null;
          if (next !== null) {
            event.preventDefault();
            change(next);
          } else if (event.key === 'Escape' && dragging) {
            event.preventDefault();
            finish(false);
          }
        }}
      >
        <span />
      </div>
    </>
  );
}
