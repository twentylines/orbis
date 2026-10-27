import { expect, test } from 'bun:test';
import { appFlyoutAnchor, placeAppWindowFlyout } from './app-window-flyout';

const frame = { left: 120, top: 80, width: 800, height: 600 };
const button = { left: 700, top: 92, width: 40, height: 40 };

test('pointer flyouts respect the exact activation x and y instead of the button edge', () => {
  const anchor = appFlyoutAnchor({ x: 708, y: 101 }, frame, button);
  expect(anchor).toEqual({ x: 588, y: 21 });
  const position = placeAppWindowFlyout(frame, anchor, { width: 240, height: 180 });
  expect(position.left + 120).toBe(anchor.x);
  expect(position.top).toBe(anchor.y + 8);
  expect(placeAppWindowFlyout(frame, { x: 560, y: 35 }, { width: 240, height: 180 }).top).toBe(43);
});

test('keyboard activation anchors to the button center and bottom without stale pointer coordinates', () => {
  const anchor = appFlyoutAnchor(null, frame, button);
  expect(anchor).toEqual({ x: 600, y: 52 });
  expect(placeAppWindowFlyout(frame, anchor, { width: 240, height: 180 })).toMatchObject({ left: 480, top: 60 });
});

test('help and layout sizes remain inside the actual frame with a twelve-pixel edge gap', () => {
  for (const size of [
    { width: 360, height: 290 },
    { width: 240, height: 250 },
  ]) {
    for (const x of [-100, 0, 12, 400, 799, 900]) {
      for (const y of [-100, 0, 30, 300, 599, 900]) {
        const next = placeAppWindowFlyout(frame, { x, y }, size);
        expect(next.left).toBeGreaterThanOrEqual(12);
        expect(next.top).toBeGreaterThanOrEqual(12);
        expect(next.left + size.width).toBeLessThanOrEqual(frame.width - 12);
        expect(next.top + Math.min(size.height, next.maxHeight)).toBeLessThanOrEqual(frame.height - 12);
      }
    }
  }
});

test('oversized and enlarged-text flyouts get bounded scrollable dimensions rather than escaping a small frame', () => {
  const next = placeAppWindowFlyout({ width: 320, height: 260 }, { x: 290, y: 40 }, { width: 480, height: 600 });
  expect(next).toEqual({ left: 12, top: 48, maxWidth: 296, maxHeight: 200 });
  const tiny = placeAppWindowFlyout({ width: 20, height: 16 }, { x: 19, y: 15 }, { width: 100, height: 100 });
  expect(tiny).toEqual({ left: 4, top: 12, maxWidth: 12, maxHeight: 0 });
});

test('a tall menu scrolls below the click instead of moving back over the toolbar', () => {
  const next = placeAppWindowFlyout({ width: 550, height: 340 }, { x: 250, y: 38 }, { width: 310, height: 430 });
  expect(next.top).toBe(46);
  expect(next.maxHeight).toBe(282);
  expect(next.top + next.maxHeight).toBe(328);
});

test('frame movement preserves a local click anchor while keyboard positioning follows its current button', () => {
  const pointer = appFlyoutAnchor({ x: 708, y: 101 }, frame, button);
  const moved = { ...frame, left: 300, top: 160 };
  const movedButton = { ...button, left: button.left + 180, top: button.top + 80 };
  expect(appFlyoutAnchor(null, moved, movedButton)).toEqual(appFlyoutAnchor(null, frame, button));
  expect(placeAppWindowFlyout(moved, pointer, { width: 240, height: 180 })).toEqual(
    placeAppWindowFlyout(frame, pointer, { width: 240, height: 180 }),
  );
});
