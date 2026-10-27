import { useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type RefObject } from 'react';

export function preserveResourceRanking<T extends { id: string }>(items: T[], heldIds: string[] | null): T[] {
  if (!heldIds) return items;
  const rank = new Map(heldIds.map((id, index) => [id, index]));
  return [...items].sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}

export function useResourceRanking<T extends { id: string }>(items: T[], list: RefObject<HTMLElement | null>) {
  const [heldIds, setHeldIds] = useState<string[] | null>(null);
  const pointerInside = useRef(false);
  const focusInside = useRef(false);
  const hold = () => setHeldIds((previous) => previous ?? items.map((item) => item.id));
  const release = () => {
    if (!pointerInside.current && !focusInside.current) setHeldIds(null);
  };
  const leavePointer = () => {
    pointerInside.current = false;
    release();
  };
  useLayoutEffect(() => {
    if (!heldIds) return;
    const element = list.current;
    if (focusInside.current && !element?.contains(document.activeElement)) focusInside.current = false;
    if (pointerInside.current && !element?.matches(':hover')) pointerInside.current = false;
    if (!pointerInside.current && !focusInside.current) setHeldIds(null);
  });

  return {
    items: preserveResourceRanking(items, heldIds),
    interaction: {
      onPointerEnter: () => {
        pointerInside.current = true;
        hold();
      },
      onPointerLeave: leavePointer,
      onPointerCancel: leavePointer,
      onPointerUp: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType !== 'mouse') leavePointer();
      },
      onFocusCapture: () => {
        focusInside.current = true;
        hold();
      },
      onBlurCapture: (event: FocusEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        focusInside.current = false;
        release();
      },
    },
  };
}
