import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { DesktopWindowBounds } from '@runtipi/common/schemas';
import { clampWindowBounds, type WindowArea } from './window-geometry';
import { initialAppBounds } from './app-opening';

type Placement = { bounds: DesktopWindowBounds; maximized: boolean };
type Gesture = { kind: 'move' | 'resize'; bounds: DesktopWindowBounds; pointer?: { id: number; x: number; y: number } };

export function useAppWindowGeometry(
  key: string | undefined,
  saved: DesktopWindowBounds | undefined,
  categories: string[] | undefined,
  save: (bounds: DesktopWindowBounds) => void,
) {
  const [area, setArea] = useState<WindowArea>({ x: 24, y: 110, width: 1000, height: 600 });
  const areaRef = useRef(area);
  const activeKey = useRef(key);
  const [placements, setPlacements] = useState<Record<string, Placement>>({});
  const [draft, setDraft] = useState<DesktopWindowBounds | null>(null);
  const [gestureKind, setGestureKind] = useState<Gesture['kind'] | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef<DesktopWindowBounds | null>(null);
  const pending = useRef(0);
  const state = (key && placements[key]) || { bounds: initialAppBounds(area, saved, categories), maximized: false };
  const bounds = draft ?? (state.maximized ? area : clampWindowBounds(state.bounds, area));
  const cancel = useCallback(() => {
    cancelAnimationFrame(pending.current);
    pending.current = 0;
    gesture.current = null;
    latest.current = null;
    setDraft(null);
    setGestureKind(null);
  }, []);
  useLayoutEffect(() => {
    const measure = () => {
      const bar = document.querySelector('.desktop-system-bar')?.getBoundingClientRect();
      const dock = document.querySelector('.desktop-dock')?.getBoundingClientRect();
      const x = Math.round(bar?.x ?? 24);
      const y = Math.round((bar?.bottom ?? 90) + 16);
      const next = { x, y, width: Math.max(1, innerWidth - x * 2), height: Math.max(1, Math.round((dock?.top ?? innerHeight - 100) - y - 16)) };
      const previous = areaRef.current;
      if (previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height) return;
      areaRef.current = next;
      cancel();
      setArea(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of document.querySelectorAll('.desktop-system-bar,.desktop-dock')) observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [cancel]);
  useLayoutEffect(() => {
    if (activeKey.current === key) return;
    activeKey.current = key;
    cancel();
  }, [key, cancel]);
  useEffect(() => () => cancelAnimationFrame(pending.current), []);
  const finish = (commit: boolean) => {
    if (commit && key && latest.current) {
      const next = latest.current;
      setPlacements((previous) => ({ ...previous, [key]: { bounds: next, maximized: false } }));
      save(next);
    }
    cancel();
  };
  const change = (next: DesktopWindowBounds) => {
    latest.current = clampWindowBounds(next, area);
    if (!pending.current)
      pending.current = requestAnimationFrame(() => {
        pending.current = 0;
        setDraft(latest.current);
      });
  };
  const begin = (kind: Gesture['kind']) => {
    gesture.current = { kind, bounds };
    latest.current = bounds;
    setGestureKind(kind);
  };
  const pointer = (kind: Gesture['kind']) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || (kind === 'move' && (event.target as HTMLElement).closest('button,a,input,select,[role=menuitem],[role=menu]')))
        return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      begin(kind);
      if (gesture.current) gesture.current.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const active = gesture.current;
      if (!active?.pointer || active.pointer.id !== event.pointerId) return;
      const dx = event.clientX - active.pointer.x;
      const dy = event.clientY - active.pointer.y;
      change(
        active.kind === 'move'
          ? { ...active.bounds, x: active.bounds.x + dx, y: active.bounds.y + dy }
          : {
              ...active.bounds,
              width: Math.min(area.x + area.width - active.bounds.x, active.bounds.width + dx),
              height: Math.min(area.y + area.height - active.bounds.y, active.bounds.height + dy),
            },
      );
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
    if (!active || active.pointer) return;
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finish(event.key === 'Enter');
      return;
    }
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 10;
    const dx = (direction[0] ?? 0) * step;
    const dy = (direction[1] ?? 0) * step;
    const before = latest.current ?? active.bounds;
    change(
      active.kind === 'move'
        ? { ...before, x: before.x + dx, y: before.y + dy }
        : {
            ...before,
            width: Math.min(area.x + area.width - before.x, before.width + dx),
            height: Math.min(area.y + area.height - before.y, before.height + dy),
          },
    );
  };
  const maximize = () => {
    if (!key) return;
    cancel();
    setPlacements((previous) => ({ ...previous, [key]: { bounds: state.bounds, maximized: !state.maximized } }));
  };
  return {
    bounds,
    maximize,
    maximized: state.maximized,
    gestureKind,
    keyboard,
    beginKeyboard: begin,
    finish,
    move: pointer('move'),
    resize: pointer('resize'),
  };
}
