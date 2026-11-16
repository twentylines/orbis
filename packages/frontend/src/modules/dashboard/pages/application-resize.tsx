import { useCallback, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { IconArrowsVertical } from '@tabler/icons-react';
import { resizeWidget } from '@/desktop/workspace-layout';

type Drag = { widget: HTMLElement; control: HTMLButtonElement; pointerId: number; y: number; height: number; value: number; original: string };

export function ApplicationResize({ save }: { save: (height: number) => void }) {
  const helpId = useId();
  const drag = useRef<Drag | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const [height, setHeight] = useState<number | null>(null);
  const finish = useCallback((commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.control.hasPointerCapture(current.pointerId)) current.control.releasePointerCapture(current.pointerId);
    if (commit && current.value !== current.height) saveRef.current(current.value);
    else if (current.original) current.widget.style.setProperty('--workspace-widget-height', current.original);
    else current.widget.style.removeProperty('--workspace-widget-height');
  }, []);
  useLayoutEffect(() => {
    const cancel = () => finish(false);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      cancel();
    };
  }, [finish]);
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = Math.round((event.clientY - current.y) / 40) * 40;
    const next = delta === 0 ? current.height : resizeWidget({ columns: 4, height: current.height }, 0, delta, 1).height;
    if (next === current.value) return;
    current.value = next;
    current.widget.style.setProperty('--workspace-widget-height', `${next}px`);
    setHeight(next);
  };
  return (
    <>
      <button
        className="workspace-resize-handle workspace-app-resize"
        type="button"
        aria-label="Resize Applications"
        aria-describedby={helpId}
        title="Drag vertically to resize Applications"
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          const widget = event.currentTarget.closest<HTMLElement>('.workspace-widget');
          const panel = widget?.querySelector<HTMLElement>('.workspace-apps');
          if (!widget || !panel) return;
          const value = Math.round(panel.getBoundingClientRect().height);
          drag.current = {
            widget,
            control: event.currentTarget,
            pointerId: event.pointerId,
            y: event.clientY,
            height: value,
            value,
            original: widget.style.getPropertyValue('--workspace-widget-height'),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
          if (event.pointerId !== drag.current?.pointerId) return;
          move(event);
          finish(true);
        }}
        onPointerCancel={() => finish(false)}
        onLostPointerCapture={() => finish(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && drag.current) {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
            setHeight(null);
            return;
          }
          if (drag.current || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          const panel = event.currentTarget.closest('.workspace-widget')?.querySelector('.workspace-apps');
          if (!panel) return;
          event.preventDefault();
          event.stopPropagation();
          const current = Math.round(panel.getBoundingClientRect().height);
          const change = event.key === 'Home' ? -960 : event.key === 'End' ? 960 : event.key === 'ArrowUp' ? -40 : 40;
          const next = resizeWidget({ columns: 4, height: current }, 0, change, 1).height;
          setHeight(next);
          if (next !== current) saveRef.current(next);
        }}
      >
        <IconArrowsVertical size={20} aria-hidden="true" />
      </button>
      <span className="visually-hidden" id={helpId} aria-live="polite">
        Drag vertically, or use the up and down arrow keys. Home sets the minimum height; End sets the maximum.
        {height === null ? '' : ` Height ${height} pixels.`}
      </span>
    </>
  );
}
