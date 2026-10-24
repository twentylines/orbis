import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { DesktopWindowBounds } from '@runtipi/common/schemas';
import type { WindowArea } from './window-geometry';
import { initialAppBounds, restoreAppBounds } from './app-opening';
import { appSnapTarget, clampAppBounds, resizeAppBounds, splitAppBounds, type AppWindowMode, type ResizeEdge } from './app-window-layout';

type Gesture = {
  kind: 'move' | 'resize';
  edge: ResizeEdge;
  bounds: DesktopWindowBounds;
  changed?: boolean;
  pointer?: { id: number; x: number; y: number };
};

export function useAppWindowGeometry({
  area,
  mode,
  ratio,
  saved,
  categories,
  canSnap = true,
  save,
  place,
}: {
  area: WindowArea;
  mode: AppWindowMode;
  ratio: number;
  saved?: DesktopWindowBounds;
  categories?: string[];
  canSnap?: boolean;
  save: (bounds: DesktopWindowBounds) => void;
  place: (mode: AppWindowMode) => void;
}) {
  const [floating, setFloating] = useState(() => initialAppBounds(area, saved, categories));
  const [draft, setDraft] = useState<DesktopWindowBounds | null>(null);
  const [gestureKind, setGestureKind] = useState<Gesture['kind'] | null>(null);
  const [preview, setPreview] = useState<Exclude<AppWindowMode, 'floating'> | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef<DesktopWindowBounds | null>(null);
  const target = useRef<Exclude<AppWindowMode, 'floating'> | null>(null);
  const pending = useRef(0);
  const placed = mode === 'floating' ? clampAppBounds(floating, area) : mode === 'maximized' ? area : splitAppBounds(mode, area, ratio);
  const bounds = draft ?? placed;
  const cancel = useCallback(() => {
    cancelAnimationFrame(pending.current);
    pending.current = 0;
    gesture.current = null;
    latest.current = null;
    target.current = null;
    setDraft(null);
    setGestureKind(null);
    setPreview(null);
  }, []);
  const constraint = useRef({ area, mode });
  useLayoutEffect(() => {
    if (constraint.current.area !== area || constraint.current.mode !== mode) cancel();
    constraint.current = { area, mode };
  }, [area, mode, cancel]);
  useEffect(() => () => cancelAnimationFrame(pending.current), []);
  const finish = (commit: boolean) => {
    if (commit && gesture.current?.changed && latest.current) {
      const next = latest.current;
      setFloating(next);
      save(next);
      place(target.current ?? 'floating');
    }
    cancel();
  };
  const change = (next: DesktopWindowBounds) => {
    if (gesture.current) gesture.current.changed = true;
    latest.current = clampAppBounds(next, area);
    if (!pending.current)
      pending.current = requestAnimationFrame(() => {
        pending.current = 0;
        setDraft(latest.current);
        setPreview(target.current);
      });
  };
  const begin = (kind: Gesture['kind'], edge: ResizeEdge = 'se') => {
    gesture.current = { kind, edge, bounds };
    latest.current = bounds;
    setGestureKind(kind);
  };
  const pointer = (kind: Gesture['kind'], edge: ResizeEdge = 'se') => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || (kind === 'move' && (event.target as HTMLElement).closest('button,a,input,select,[role=menuitem],[role=menu]')))
        return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      begin(kind, edge);
      if (gesture.current) {
        // Pull a snapped window beneath the pointer without jumping to its saved position.
        if (kind === 'move' && mode !== 'floating') {
          const restored = restoreAppBounds(area, floating, categories);
          const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.x) / bounds.width));
          gesture.current.bounds = clampAppBounds({ ...restored, x: event.clientX - restored.width * fraction, y: bounds.y }, area);
        }
        gesture.current.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      }
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const active = gesture.current;
      if (!active?.pointer || active.pointer.id !== event.pointerId) return;
      const dx = event.clientX - active.pointer.x;
      const dy = event.clientY - active.pointer.y;
      const next =
        active.kind === 'move'
          ? { ...active.bounds, x: active.bounds.x + dx, y: active.bounds.y + dy }
          : resizeAppBounds(active.bounds, active.edge, dx, dy, area);
      target.current = canSnap && active.kind === 'move' ? appSnapTarget(next, { x: dx, y: dy }, area) : null;
      change(next);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (gesture.current?.pointer?.id !== event.pointerId) return;
      finish(true);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: () => finish(false),
    onLostPointerCapture: () => {
      if (gesture.current?.pointer) finish(false);
    },
  });
  const keyboard = (event: KeyboardEvent) => {
    const active = gesture.current;
    if (!active) return;
    if (event.key === 'Escape' || (event.key === 'Enter' && !active.pointer)) {
      event.preventDefault();
      event.stopPropagation();
      finish(event.key === 'Enter');
      return;
    }
    if (active.pointer) return;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 10;
    const dx = (direction[0] ?? 0) * step;
    const dy = (direction[1] ?? 0) * step;
    const before = latest.current ?? active.bounds;
    change(active.kind === 'move' ? { ...before, x: before.x + dx, y: before.y + dy } : resizeAppBounds(before, active.edge, dx, dy, area));
  };
  return {
    bounds,
    preview,
    gestureKind,
    keyboard,
    beginKeyboard: begin,
    restoreFloating: () => {
      const next = restoreAppBounds(area, floating, categories);
      if (next.width !== floating.width || next.height !== floating.height || next.x !== floating.x || next.y !== floating.y) {
        setFloating(next);
        save(next);
      }
    },
    cancel,
    move: pointer('move'),
    resize: (edge: ResizeEdge) => pointer('resize', edge),
  };
}
