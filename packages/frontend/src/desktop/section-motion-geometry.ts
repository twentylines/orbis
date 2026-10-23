export type SectionBounds = { left: number; top: number; width: number; height: number };

export function visibleSectionBounds(bounds: SectionBounds, viewportHeight: number): SectionBounds {
  const top = Math.max(0, bounds.top);
  const available = Math.max(1, viewportHeight - top);
  return { ...bounds, top, height: Math.min(bounds.height, available) };
}

export function sectionSurfaceFrames(from: SectionBounds, to: SectionBounds) {
  return [
    { width: `${from.width}px`, height: `${from.height}px`, transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` },
    { width: `${to.width}px`, height: `${to.height}px`, transform: 'none' },
  ];
}
