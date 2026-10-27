export type AppFlyoutPoint = { x: number; y: number };
export type AppFlyoutRect = { left: number; top: number; width: number; height: number };
export type AppFlyoutPosition = { left: number; top: number; maxWidth: number; maxHeight: number };

export function appFlyoutAnchor(pointer: AppFlyoutPoint | null, frame: AppFlyoutRect, button: AppFlyoutRect): AppFlyoutPoint {
  return {
    x: (pointer?.x ?? button.left + button.width / 2) - frame.left,
    y: (pointer?.y ?? button.top + button.height) - frame.top,
  };
}

export function placeAppWindowFlyout(
  frame: { width: number; height: number },
  anchor: AppFlyoutPoint,
  content: { width: number; height: number },
): AppFlyoutPosition {
  const gap = Math.min(12, Math.max(0, frame.width) / 4, Math.max(0, frame.height) / 4);
  const maxWidth = Math.max(0, frame.width - gap * 2);
  const top = Math.max(gap, Math.min(anchor.y + 8, frame.height - gap));
  const maxHeight = Math.max(0, frame.height - gap - top);
  const width = Math.min(maxWidth, Math.max(0, content.width));
  return {
    left: Math.max(gap, Math.min(anchor.x - width / 2, frame.width - gap - width)),
    top,
    maxWidth,
    maxHeight,
  };
}
