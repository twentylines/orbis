export type BackupRemovalRect = { left: number; top: number; right: number; bottom: number };
export function placeBackupRemoval(anchor: BackupRemovalRect, content: { width: number; height: number }, boundary: BackupRemovalRect) {
  const inset = 8;
  const left = boundary.left + inset;
  const top = boundary.top + inset;
  const right = Math.max(left, boundary.right - inset);
  const bottom = Math.max(top, boundary.bottom - inset);
  const width = Math.min(Math.max(0, content.width), right - left);
  const below = Math.max(0, bottom - anchor.bottom - inset);
  const above = Math.max(0, anchor.top - inset - top);
  const side = below >= content.height || below >= above ? 'bottom' : 'top';
  const space = side === 'bottom' ? below : above;
  const maxHeight = space >= Math.min(140, bottom - top) ? space : bottom - top;
  const height = Math.min(content.height, maxHeight);
  return {
    left: Math.max(left, Math.min(anchor.right - width, right - width)),
    top: Math.max(top, Math.min(side === 'bottom' ? anchor.bottom + inset : anchor.top - inset - height, bottom - height)),
    width,
    maxHeight,
    side,
  };
}

export function restoreBackupRemovalFocus(candidates: readonly (HTMLElement | null | undefined)[]) {
  const target = candidates.find(
    (candidate) => candidate?.isConnected && !candidate.matches(':disabled,[aria-disabled="true"]') && candidate.getClientRects().length,
  );
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}
