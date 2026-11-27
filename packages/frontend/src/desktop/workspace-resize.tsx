import { useRef } from 'react';
import { IconArrowsDiagonal2 } from '@tabler/icons-react';
import { resizeWidget, type WidgetSize } from './workspace-layout';

export function WorkspaceResizeHandle({
  name,
  size,
  advanced,
  change,
}: {
  name: string;
  size: WidgetSize;
  advanced: boolean;
  change: (size: WidgetSize) => void;
}) {
  const drag = useRef<{
    x: number;
    y: number;
    width: number;
    size: WidgetSize;
    next: WidgetSize;
    moved: boolean;
    node: HTMLElement;
    originalColumns: string;
    originalHeight: string;
  } | null>(null);
  const stop = (save: boolean) => {
    const current = drag.current;
    if (!current) return;
    current.node.style.setProperty('--workspace-widget-columns', current.originalColumns);
    current.node.style.setProperty('--workspace-widget-height', current.originalHeight);
    current.node.removeAttribute('data-resizing');
    drag.current = null;
    if (save && current.moved) change(current.next);
  };
  return (
    <button
      type="button"
      className="workspace-resize-handle"
      aria-label={`Resize ${name}, ${size.columns} columns${advanced ? `, ${size.height} pixels high` : ''}`}
      aria-describedby="workspace-resize-help"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const node = event.currentTarget.closest<HTMLElement>('.workspace-widget');
        if (!node) return;
        const height = node.querySelector<HTMLElement>('.workspace-widget-content')?.getBoundingClientRect().height;
        const startSize = advanced && node.dataset.customSize !== 'true' && height ? resizeWidget(size, 0, height - size.height, 1) : size;
        event.currentTarget.setPointerCapture(event.pointerId);
        node.dataset.resizing = 'true';
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          width: (node.parentElement?.clientWidth ?? 1000) / 4,
          size: startSize,
          next: startSize,
          moved: false,
          node,
          originalColumns: node.style.getPropertyValue('--workspace-widget-columns'),
          originalHeight: node.style.getPropertyValue('--workspace-widget-height'),
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 6) current.moved = true;
        if (!current.moved) return;
        event.preventDefault();
        const next = resizeWidget(current.size, event.clientX - current.x, advanced ? event.clientY - current.y : 0, current.width);
        if (!advanced) {
          next.columns = next.columns >= 3 ? 4 : 2;
          next.height = current.size.height;
        }
        current.next = next;
        current.node.style.setProperty('--workspace-widget-columns', String(next.columns));
        if (advanced) current.node.style.setProperty('--workspace-widget-height', `${next.height}px`);
      }}
      onPointerUp={() => stop(true)}
      onPointerCancel={() => stop(false)}
      onLostPointerCapture={() => stop(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          stop(false);
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Home') {
          change({ columns: 2, height: 320 });
          return;
        }
        if (!advanced && ['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const dx = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        const dy = event.key === 'ArrowUp' ? -40 : event.key === 'ArrowDown' ? 40 : 0;
        const node = event.currentTarget.closest<HTMLElement>('.workspace-widget');
        const height = node?.querySelector<HTMLElement>('.workspace-widget-content')?.getBoundingClientRect().height;
        const startSize = advanced && node?.dataset.customSize !== 'true' && height ? resizeWidget(size, 0, height - size.height, 1) : size;
        const next = resizeWidget(startSize, dx * (advanced ? 1 : 2), dy, 1);
        change(next);
      }}
    >
      <IconArrowsDiagonal2 size={18} aria-hidden="true" />
    </button>
  );
}
