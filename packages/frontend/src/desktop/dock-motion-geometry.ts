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

export function dockCircleSplitBridge(leftEdge: number, rightEdge: number, middle: number, radius: number) {
  const gap = rightEdge - leftEdge;
  const release = 10;
  if (gap < -radius / 3 || gap >= release) return '';
  // Move the attachment points toward the facing circle edges as the neck recedes.
  const separation = 1 - Math.max(0, gap) / release;
  const inset = (radius / 6) * separation ** 2;
  const end = Math.sqrt(radius ** 2 - (radius - inset) ** 2);
  const neck = end * 0.72 * separation;
  const left = leftEdge - inset;
  const right = rightEdge + inset;
  if (left >= right) return '';
  const center = (left + right) / 2;
  return `M${left},${middle - end}C${center},${middle - end} ${center},${middle - neck} ${center},${middle - neck}C${center},${middle - neck} ${center},${middle - end} ${right},${middle - end}V${middle + end}C${center},${middle + end} ${center},${middle + neck} ${center},${middle + neck}C${center},${middle + neck} ${center},${middle + end} ${left},${middle + end}Z`;
}
