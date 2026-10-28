type Rect = { x: number; y: number; width: number; height: number };

export function selectionBounds(
  group: Rect,
  active: Rect,
  layout: { width: number; height: number; borderX: number; borderY: number; scrollX: number; scrollY: number },
) {
  if (group.width <= 0 || group.height <= 0 || active.width <= 0 || active.height <= 0 || layout.width <= 0 || layout.height <= 0) return null;
  const scaleX = group.width / layout.width;
  const scaleY = group.height / layout.height;
  return {
    x: (active.x - group.x) / scaleX - layout.borderX + layout.scrollX,
    y: (active.y - group.y) / scaleY - layout.borderY + layout.scrollY,
    width: active.width / scaleX,
    height: active.height / scaleY,
  };
}
