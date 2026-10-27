export function dockFlightTargetLeft({
  center,
  mainWidth,
  leftSpace,
  trayWidth,
  gap,
  offset,
}: {
  center: number;
  mainWidth: number;
  leftSpace: number;
  trayWidth: number;
  gap: number;
  offset: number;
}) {
  return center - (leftSpace + mainWidth + gap + trayWidth) / 2 + leftSpace + mainWidth + gap + offset;
}
export const canJoinDockPills = (gap: number, moving: boolean) => moving && Number.isFinite(gap) && gap >= -16 && gap < 11.5;
