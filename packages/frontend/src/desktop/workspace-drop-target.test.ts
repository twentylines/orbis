import { expect, test } from 'bun:test';
import { workspaceDropTarget, type WorkspaceDropBox } from './workspace-drop-target';

const row = (ids: string[], top = 0, height = 50): WorkspaceDropBox<string>[] =>
  ids.map((id, index) => ({ id, left: index * 100, right: index * 100 + 60, top, bottom: top + height }));
function placed(items: string[], source: string, boxes: WorkspaceDropBox<string>[], x: number, y: number) {
  const target = workspaceDropTarget(items, source, boxes, x, y);
  if (!target) return items;
  const next = items.filter((id) => id !== source);
  next.splice(target.index, 0, source);
  return next;
}

test('a wide gutter inserts between the same neighbours from either direction', () => {
  const items = ['a', 'b', 'c', 'd'];
  for (const x of [164, 180, 196]) {
    expect(placed(items, 'a', row(items), x, 25)).toEqual(['b', 'a', 'c', 'd']);
    expect(placed(items, 'd', row(items), x, 25)).toEqual(['a', 'b', 'd', 'c']);
  }
});
test('nearby space above or below a toolbar icon accepts its position', () => {
  const items = ['a', 'b', 'c'];
  expect(placed(items, 'a', row(items), 130, -18)).toEqual(['b', 'a', 'c']);
  expect(placed(items, 'a', row(items), 130, 68)).toEqual(['b', 'a', 'c']);
});
test('outside the first and last icon selects the leading and trailing slots', () => {
  const items = ['a', 'b', 'c'];
  expect(placed(items, 'c', row(items), -22, 25)).toEqual(['c', 'a', 'b']);
  expect(placed(items, 'a', row(items), 282, 25)).toEqual(['b', 'c', 'a']);
});
test('returning to the source slot and leaving the group cancel placement', () => {
  const items = ['a', 'b', 'c'];
  const points: [number, number][] = [
    [30, 25],
    [-80, 25],
    [130, -80],
    [500, 25],
  ];
  for (const [x, y] of points) expect(workspaceDropTarget(items, 'a', row(items), x, y)).toBeNull();
});
test('the gap between wrapped rows inserts at the row boundary', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  const boxes = [...row(items.slice(0, 3)), ...row(items.slice(3), 90)];
  for (const x of [20, 130, 250]) expect(placed(items, 'a', boxes, x, 70)).toEqual(['b', 'c', 'a', 'd', 'e']);
});
test('empty trailing space in a partly filled row appends at the end', () => {
  const items = ['a', 'b', 'c', 'd'];
  const boxes = [...row(items.slice(0, 3)), ...row(items.slice(3), 90)];
  expect(placed(items, 'a', boxes, 240, 115)).toEqual(['b', 'c', 'd', 'a']);
});
test('single-column gutters and nearby side space work without aiming at a card', () => {
  const items = ['a', 'b', 'c'];
  const boxes = items.map((id, index) => ({ id, left: 20, right: 280, top: index * 100, bottom: index * 100 + 60 }));
  expect(placed(items, 'c', boxes, 150, 80)).toEqual(['a', 'c', 'b']);
  expect(placed(items, 'a', boxes, 8, 130)).toEqual(['b', 'a', 'c']);
});
test('right-to-left layouts preserve logical insertion order in their gaps', () => {
  const items = ['a', 'b', 'c', 'd'];
  const boxes = row(items).map((box) => ({ ...box, left: 360 - box.right, right: 360 - box.left }));
  expect(placed(items, 'd', boxes, 180, 25)).toEqual(['a', 'b', 'd', 'c']);
});
test('widget swaps use the nearby card while preserving the fixed layout strategy', () => {
  const items = ['a', 'b', 'c'];
  expect(workspaceDropTarget(items, 'a', row(items), 180, 25, true)?.target).toBe('b');
  expect(workspaceDropTarget(items, 'a', row(items), 30, 25, true)).toBeNull();
});
