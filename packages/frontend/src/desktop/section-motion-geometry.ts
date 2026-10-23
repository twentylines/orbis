export type SectionBounds = { left: number; top: number; width: number; height: number };

export const sectionMotionTiming = { surface: 580, cardEntry: 0, content: 580, historyEntry: 0 } as const;
export const sectionMotionEasing = 'cubic-bezier(.32, .08, .24, 1)';

export function visibleSectionBounds(bounds: SectionBounds, viewportHeight: number): SectionBounds {
  const top = Math.max(0, bounds.top);
  const available = Math.max(1, viewportHeight - top);
  return { ...bounds, top, height: Math.min(bounds.height, available) };
}

export function sectionSurfaceFrames(from: SectionBounds, to: SectionBounds) {
  return [{ height: `${from.height}px` }, { height: `${to.height}px` }];
}

export function sectionDirection(from: number, to: number, action: string, previousIndex?: number, nextIndex?: number) {
  if (action === 'POP' && Number.isFinite(previousIndex) && Number.isFinite(nextIndex) && previousIndex !== nextIndex) {
    return (nextIndex as number) > (previousIndex as number) ? 1 : -1;
  }
  return to >= from ? 1 : -1;
}
