export type SectionBounds = { left: number; top: number; width: number; height: number };

export const sectionMotionTiming = { surface: 420, cardEntry: 160, content: 240, historyEntry: 120 } as const;

export function visibleSectionBounds(bounds: SectionBounds, viewportHeight: number): SectionBounds {
  const top = Math.max(0, bounds.top);
  const available = Math.max(1, viewportHeight - top);
  return { ...bounds, top, height: Math.min(bounds.height, available) };
}

export function sectionSurfaceFrames(from: SectionBounds, to: SectionBounds) {
  return [
    { width: `${from.width}px`, height: `${from.height}px`, transform: `translateX(${from.left - to.left}px)` },
    { width: `${to.width}px`, height: `${to.height}px`, transform: 'none' },
  ];
}

export function sectionDirection(from: number, to: number, action: string, previousIndex?: number, nextIndex?: number) {
  if (action === 'POP' && Number.isFinite(previousIndex) && Number.isFinite(nextIndex) && previousIndex !== nextIndex) {
    return (nextIndex as number) > (previousIndex as number) ? 1 : -1;
  }
  return to >= from ? 1 : -1;
}
