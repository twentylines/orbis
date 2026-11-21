type Bounds = { left: number; right: number; top: number; bottom: number };
export type WorkspaceDropBox<T> = Bounds & { id: T };

/** Resolve the spaces around a stable layout, without moving its neighbours. */
export function workspaceDropTarget<T>(items: readonly T[], source: T, boxes: WorkspaceDropBox<T>[], x: number, y: number, swap = false) {
  if (!boxes.length || !items.includes(source)) return null;
  const left = Math.min(...boxes.map((box) => box.left));
  const right = Math.max(...boxes.map((box) => box.right));
  const top = Math.min(...boxes.map((box) => box.top));
  const bottom = Math.max(...boxes.map((box) => box.bottom));
  const inset = (size: number) => Math.min(48, Math.max(24, size / 2));
  const padX = inset(Math.min(...boxes.map((box) => box.right - box.left)));
  const padY = inset(Math.min(...boxes.map((box) => box.bottom - box.top)));
  if (x < left - padX || x > right + padX || y < top - padY || y > bottom + padY) return null;
  const origin = boxes.find((box) => box.id === source);
  if (origin && x >= origin.left && x <= origin.right && y >= origin.top && y <= origin.bottom) return null;
  const remaining = items.filter((id) => id !== source);
  const targets = boxes.filter((box) => box.id !== source && remaining.includes(box.id));
  if (!targets.length) return null;
  const result = (box: WorkspaceDropBox<T>, index: number) => (index === items.indexOf(source) ? null : { target: box.id, index });
  const distance = (box: Bounds) => Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
  const centerDistance = (box: Bounds) => Math.hypot(x - (box.left + box.right) / 2, y - (box.top + box.bottom) / 2);
  if (swap) {
    const nearest = [...targets].sort((a, b) => distance(a) - distance(b) || centerDistance(a) - centerDistance(b))[0];
    return nearest ? { target: nearest.id, index: items.indexOf(nearest.id) } : null;
  }
  const inside = targets.find((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
  if (inside) return result(inside, items.indexOf(inside.id));

  const rows: { top: number; bottom: number; boxes: WorkspaceDropBox<T>[] }[] = [];
  for (const box of boxes) {
    const row = rows.find(
      (row) => Math.min(row.bottom, box.bottom) - Math.max(row.top, box.top) > Math.min(row.bottom - row.top, box.bottom - box.top) / 2,
    );
    if (row) {
      row.top = Math.min(row.top, box.top);
      row.bottom = Math.max(row.bottom, box.bottom);
      row.boxes.push(box);
    } else rows.push({ top: box.top, bottom: box.bottom, boxes: [box] });
  }
  rows.sort((a, b) => a.top - b.top);
  for (let index = 1; index < rows.length; index++) {
    const before = rows[index - 1];
    const after = rows[index];
    if (!before || !after) continue;
    if (y >= before.bottom && y <= after.top) {
      const next = after.boxes.find((box) => box.id !== source);
      if (next) return result(next, remaining.indexOf(next.id));
      const previous = [...before.boxes].reverse().find((box) => box.id !== source);
      if (previous) return result(previous, remaining.indexOf(previous.id) + 1);
    }
  }
  const verticalDistance = (row: { top: number; bottom: number }) => Math.max(row.top - y, 0, y - row.bottom);
  const row = [...rows].sort((a, b) => verticalDistance(a) - verticalDistance(b))[0];
  if (!row) return null;
  const nearest = row.boxes.filter((box) => box.id !== source).sort((a, b) => distance(a) - distance(b) || centerDistance(a) - centerDistance(b))[0];
  if (!nearest) return null;
  const horizontal = row.boxes.length > 1;
  // Alongside a card/icon still means that item's position; empty row spaces
  // and the gutters between neighbours are insertion slots.
  if (horizontal && x >= nearest.left && x <= nearest.right) return result(nearest, items.indexOf(nearest.id));
  if (!horizontal && y >= nearest.top && y <= nearest.bottom) return result(nearest, items.indexOf(nearest.id));
  const first = row.boxes.at(0);
  const last = row.boxes.at(-1);
  const reversed = horizontal && first !== undefined && last !== undefined && first.left > last.left;
  const after = horizontal
    ? reversed
      ? x < (nearest.left + nearest.right) / 2
      : x >= (nearest.left + nearest.right) / 2
    : y >= (nearest.top + nearest.bottom) / 2;
  return result(nearest, remaining.indexOf(nearest.id) + Number(after));
}
