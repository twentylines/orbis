const timing = { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' } as const;
const parts = '.orbis-whole-word, .app-logo, .docker-health, .app-tile-notice, .app-tab-indicator, .badge';
type Box = { x: number; y: number; width: number; height: number };
type Tile = { element: HTMLElement; box: Box; parts: { element: HTMLElement; box: Box }[] };
export type PreviewSnapshot = Tile[];

export function capturePreviewTiles(pane: HTMLElement): PreviewSnapshot {
  const viewport = pane.getBoundingClientRect();
  return Array.from(pane.querySelectorAll<HTMLElement>('[data-store-app]')).flatMap((link) => {
    const element = link.querySelector<HTMLElement>('.app-tile') ?? link;
    const box = element.getBoundingClientRect();
    if (box.bottom < viewport.top || box.top > viewport.bottom || !box.width || !box.height) return [];
    const candidates = Array.from(element.querySelectorAll<HTMLElement>(parts));
    return [
      {
        element,
        box,
        parts: candidates
          .filter((part) => !candidates.some((other) => other !== part && other.contains(part)))
          .map((part) => ({ element: part, box: part.getBoundingClientRect() })),
      },
    ];
  });
}

export function animatePreviewTiles(before: PreviewSnapshot): Animation[] {
  // Read the settled layout once; word transforms preserve glyph size as the card changes shape.
  const after = before
    .filter(({ element }) => element.isConnected)
    .map((tile) => ({
      ...tile,
      next: tile.element.getBoundingClientRect(),
      parts: tile.parts.filter(({ element }) => element.isConnected).map((part) => ({ ...part, next: part.element.getBoundingClientRect() })),
    }));
  return after.flatMap(({ element, box, next, parts: children }) => {
    if (!next.width || !next.height) return [];
    if (
      Math.abs(box.x - next.x) < 0.5 &&
      Math.abs(box.y - next.y) < 0.5 &&
      Math.abs(box.width - next.width) < 0.5 &&
      Math.abs(box.height - next.height) < 0.5
    )
      return [];
    const sx = box.width / next.width;
    const sy = box.height / next.height;
    const animations = [
      element.animate(
        [
          { transformOrigin: '0 0', transform: `translate(${box.x - next.x}px, ${box.y - next.y}px) scale(${sx}, ${sy})` },
          { transformOrigin: '0 0', transform: 'none' },
        ],
        timing,
      ),
    ];
    for (const child of children) {
      const steps = Math.max(Math.abs(sx - 1), Math.abs(sy - 1)) < 0.01 ? 2 : 25;
      const frames = Array.from({ length: steps }, (_, index) => {
        const progress = index / (steps - 1);
        const scaleX = sx + (1 - sx) * progress;
        const scaleY = sy + (1 - sy) * progress;
        const parentX = box.x + (next.x - box.x) * progress;
        const parentY = box.y + (next.y - box.y) * progress;
        const x = (child.box.x + (child.next.x - child.box.x) * progress - parentX) / scaleX - (child.next.x - next.x);
        const y = (child.box.y + (child.next.y - child.box.y) * progress - parentY) / scaleY - (child.next.y - next.y);
        return { offset: progress, transformOrigin: '0 0', transform: `translate(${x}px, ${y}px) scale(${1 / scaleX}, ${1 / scaleY})` };
      });
      animations.push(child.element.animate(frames, timing));
    }
    return animations;
  });
}

export function previewPaneMotion(element: HTMLElement, opening: boolean, from?: { opacity: string; transform: string }): Animation {
  return element.animate(
    opening
      ? [from ?? { opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }]
      : [from ?? { opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(24px)' }],
    timing,
  );
}
