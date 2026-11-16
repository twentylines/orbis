import { useCallback, useId, useLayoutEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';

export function reorderAt<T>(items: readonly T[], source: T, target: T, strategy: 'insert' | 'swap' = 'insert'): T[] {
  const from = items.indexOf(source);
  const to = items.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...items];
  const next = [...items];
  if (strategy === 'swap') {
    next[from] = target;
    next[to] = source;
    return next;
  }
  next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}

export function useWorkspaceSortable<T extends string>(
  items: T[],
  commit: (next: T[], moved: T) => void,
  enabled: boolean,
  strategy: 'insert' | 'swap' = 'insert',
) {
  const group = useId();
  const nodes = useRef(new Map<T, HTMLElement>());
  const callbacks = useRef({ items, commit, enabled, strategy });
  callbacks.current = { items, commit, enabled, strategy };
  const [draft, setDraft] = useState<T[] | null>(null);
  const order = draft ?? items;
  const orderRef = useRef(order);
  orderRef.current = order;
  const [picked, setPicked] = useState<T | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const focusAfterMove = useRef<T | null>(null);
  const [announcement, announce] = useState('');
  const [over, setOver] = useState<T | null>(null);
  const previous = useRef(new Map<T, DOMRect>());
  const animations = useRef(new Map<T, Animation>());
  const pointer = useRef<{
    id: T;
    pointerId: number;
    capture: HTMLElement;
    x: number;
    y: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    active: boolean;
    frame: number;
    over: T | null;
  } | null>(null);
  const capture = () => {
    previous.current = new Map(Array.from(nodes.current, ([id, node]) => [id, node.getBoundingClientRect()]));
  };
  const preview = (next: T[]) => {
    capture();
    orderRef.current = next;
    setDraft(next);
  };
  const clearPointer = useCallback(() => {
    const drag = pointer.current;
    if (drag) {
      cancelAnimationFrame(drag.frame);
      const node = nodes.current.get(drag.id);
      node?.style.removeProperty('translate');
      node?.style.removeProperty('pointer-events');
      if (drag.capture.hasPointerCapture(drag.pointerId)) drag.capture.releasePointerCapture(drag.pointerId);
    }
    pointer.current = null;
    setOver(null);
  }, []);
  const finish = useCallback(
    (save: boolean) => {
      const moved = pointer.current?.id ?? pickedRef.current;
      const next = orderRef.current;
      clearPointer();
      focusAfterMove.current = moved;
      if (save && moved && next.join('\0') !== callbacks.current.items.join('\0')) callbacks.current.commit(next, moved);
      setPicked(null);
      setDraft(null);
      if (moved) announce(save ? `Placed at position ${next.indexOf(moved) + 1} of ${next.length}.` : 'Move cancelled.');
    },
    [clearPointer],
  );
  useLayoutEffect(() => {
    if (!enabled) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const id of order) {
      const node = nodes.current.get(id);
      if (!node) continue;
      const before = previous.current.get(id);
      if (!before || pointer.current?.id === id || !node.animate || reduced) continue;
      animations.current.get(id)?.cancel();
      const after = node.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) + Math.abs(dy) > 1)
        animations.current.set(
          id,
          node.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' }),
        );
    }
    previous.current.clear();
    const focusId = pointer.current ? null : (picked ?? focusAfterMove.current);
    if (focusId) {
      const grip = nodes.current.get(focusId)?.querySelector<HTMLElement>(`[data-sortable-grip="${group}"]`);
      grip?.focus({ preventScroll: true });
      grip?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    focusAfterMove.current = null;
  }, [order, enabled, picked, group]);
  useLayoutEffect(() => {
    if (!enabled) {
      clearPointer();
      focusAfterMove.current = null;
      setDraft(null);
      setPicked(null);
    }
    const cancel = () => finish(false);
    if (enabled) window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      clearPointer();
      for (const animation of animations.current.values()) animation.cancel();
    };
  }, [enabled, clearPointer, finish]);
  const movePointer = () => {
    const drag = pointer.current;
    if (!drag?.active) return;
    const node = nodes.current.get(drag.id);
    if (!node) return;
    node.style.removeProperty('translate');
    const rect = node.getBoundingClientRect();
    node.style.translate = `${drag.x - rect.left - drag.offsetX}px ${drag.y - rect.top - drag.offsetY}px`;
    // Only the grip captures touch; the rest of each card keeps ordinary page scrolling.
    let target: T | null = null;
    for (const id of orderRef.current) {
      if (id === drag.id) continue;
      const rect = nodes.current.get(id)?.getBoundingClientRect();
      if (!rect) continue;
      const insetX = Math.min(24, (rect.right - rect.left) * 0.2);
      const insetY = Math.min(24, (rect.bottom - rect.top) * 0.2);
      if (drag.x > rect.left + insetX && drag.x < rect.right - insetX && drag.y > rect.top + insetY && drag.y < rect.bottom - insetY) {
        target = id;
        break;
      }
    }
    drag.over = target;
    setOver(target);
  };
  const tick = () => {
    const drag = pointer.current;
    if (!drag?.active) return;
    movePointer();
    const hitElement = document.elementFromPoint(drag.x, drag.y);
    let scroll = hitElement?.parentElement;
    while (scroll && !(scroll.scrollHeight > scroll.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroll).overflowY)))
      scroll = scroll.parentElement;
    const top = scroll?.getBoundingClientRect().top ?? 0;
    const bottom = scroll?.getBoundingClientRect().bottom ?? window.innerHeight;
    const step = drag.y < top + 48 ? -10 : drag.y > bottom - 48 ? 10 : 0;
    if (step) {
      if (scroll) scroll.scrollTop += step;
      else window.scrollBy(0, step);
    }
    drag.frame = requestAnimationFrame(tick);
  };
  const pointerHandlers = useRef({
    move: (_event: globalThis.PointerEvent): void => undefined,
    up: (_event: globalThis.PointerEvent): void => undefined,
    cancel: (_event: globalThis.PointerEvent): void => undefined,
  });
  pointerHandlers.current = {
    move: (event) => {
      const drag = pointer.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 10) {
        drag.active = true;
        nodes.current.get(drag.id)?.style.setProperty('pointer-events', 'none');
        setPicked(drag.id);
        drag.frame = requestAnimationFrame(tick);
      }
      if (drag.active) event.preventDefault();
    },
    up: (event) => {
      const drag = pointer.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (drag.active) {
        movePointer();
        if (drag.over) preview(reorderAt(callbacks.current.items, drag.id, drag.over, callbacks.current.strategy));
      }
      finish(true);
    },
    cancel: (event) => {
      if (pointer.current?.pointerId === event.pointerId) finish(false);
    },
  };
  useLayoutEffect(() => {
    if (!enabled) return;
    const move = (event: globalThis.PointerEvent) => pointerHandlers.current.move(event);
    const up = (event: globalThis.PointerEvent) => pointerHandlers.current.up(event);
    const cancel = (event: globalThis.PointerEvent) => pointerHandlers.current.cancel(event);
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
    };
  }, [enabled]);
  return {
    order,
    announcement,
    picked,
    itemProps: (id: T) => ({
      ref: (node: HTMLElement | null) => {
        if (node) nodes.current.set(id, node);
        else nodes.current.delete(id);
      },
      'data-sortable-group': enabled ? group : undefined,
      'data-sortable-id': id,
      'data-sorting': picked === id || pointer.current?.id === id ? true : undefined,
      'data-sortable-over': over === id || undefined,
    }),
    gripProps: (id: T, label: string) => ({
      'data-sortable-grip': group,
      'aria-label': `Move ${label}`,
      'aria-pressed': picked === id,
      'aria-describedby': 'workspace-move-help',
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (!enabled || event.button !== 0 || picked) return;
        const node = nodes.current.get(id);
        if (!node) return;
        for (const animation of animations.current.values()) animation.cancel();
        animations.current.clear();
        const rect = node.getBoundingClientRect();
        const capture = node.parentElement ?? event.currentTarget;
        capture.setPointerCapture(event.pointerId);
        pointer.current = {
          id,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
          pointerId: event.pointerId,
          capture,
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          frame: 0,
          over: null,
        };
      },
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (!enabled) return;
        if (event.key === 'Escape' && picked === id) {
          event.preventDefault();
          finish(false);
          return;
        }
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          if (picked === id) finish(true);
          else {
            setPicked(id);
            setDraft([...items]);
            announce(`${label} picked up. Use arrow keys to move, Enter to place, Escape to cancel.`);
          }
        }
        if (picked === id && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const current = orderRef.current;
          const index = current.indexOf(id);
          const nextIndex =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? current.length - 1
                : Math.max(0, Math.min(current.length - 1, index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1)));
          const target = current[nextIndex];
          if (target) {
            preview(reorderAt(current, id, target, strategy));
            announce(`${label}, position ${nextIndex + 1} of ${current.length}.`);
          }
        }
      },
    }),
  };
}
