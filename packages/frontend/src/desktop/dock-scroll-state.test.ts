import { describe, expect, it } from 'bun:test';
import {
  advanceDockFold,
  advanceDockScroll,
  dockScrollProgress,
  dockScrollRoute,
  dockSideWidth,
  foldDockBox,
  foldDockClip,
  initialDockScroll,
  sampleDockScroll,
} from './dock-scroll-state';

describe('scrolling navigation', () => {
  it('reports bounded progress for meaningful overflow only', () => {
    expect(dockScrollProgress(10, 47)).toBeNull();
    expect(dockScrollProgress(10, Number.POSITIVE_INFINITY)).toBeNull();
    expect(dockScrollProgress(24, 48)).toBe(0.5);
    expect(dockScrollProgress(-16, 200)).toBe(0);
    expect(dockScrollProgress(Number.NaN, 200)).toBe(0);
    expect(dockScrollProgress(215, 200)).toBe(1);
  });
  it('keeps navigation expanded on Home and preserves the mounted desktop Store section', () => {
    for (const route of ['/dashboard', '/dashboard/', '/dashboard?view=apps']) {
      expect(dockScrollRoute(route, true)).toBeNull();
      expect(dockScrollRoute(route, false)).toBeNull();
    }
    expect(dockScrollRoute('/app-store', true)).toBe('/app-store');
    expect(dockScrollRoute('/app-store/example/app?view=apps', true)).toBe('/app-store');
    expect(dockScrollRoute('/app-store/example/app?view=apps', false)).toBe('/app-store/example/app?view=apps');
  });
  it('requires actual scrollable extent and useful downward travel', () => {
    expect(advanceDockScroll(initialDockScroll(), 64, 47).collapsed).toBe(false);
    let state = advanceDockScroll(initialDockScroll(), 40, 500);
    expect(state.collapsed).toBe(false);
    state = advanceDockScroll(state, 63, 500);
    expect(state.collapsed).toBe(false);
    expect(advanceDockScroll(state, 65, 500).collapsed).toBe(true);
  });
  it('accumulates scrolling and ignores one-pixel noise in either direction', () => {
    let state = initialDockScroll(32);
    for (let top = 34; top <= 80; top += 2) state = advanceDockScroll(state, top, 500);
    expect(state.collapsed).toBe(true);
    for (const top of [79, 80, 79, 80]) state = advanceDockScroll(state, top, 500);
    expect(state.collapsed).toBe(true);
    for (const top of [77, 74, 71]) state = advanceDockScroll(state, top, 500);
    expect(state.collapsed).toBe(true);
    expect(advanceDockScroll(state, 68, 500).collapsed).toBe(false);
  });
  it('rejects direction chatter rather than accumulating both directions', () => {
    let state = initialDockScroll(100);
    for (const top of [120, 110, 130, 120, 140]) state = advanceDockScroll(state, top, 600);
    expect(state.collapsed).toBe(false);
    expect(advanceDockScroll(state, 170, 600).collapsed).toBe(true);
  });
  it('expands at the top, while interacting, or if the page stops scrolling', () => {
    const collapsed = advanceDockScroll(initialDockScroll(), 100, 500);
    expect(collapsed.collapsed).toBe(true);
    expect(advanceDockScroll(collapsed, 11, 500).collapsed).toBe(false);
    expect(advanceDockScroll(collapsed, 200, 500, true)).toEqual(initialDockScroll(200));
    expect(advanceDockScroll(collapsed, 20, 20).collapsed).toBe(false);
  });
  it('clamps elastic overscroll and non-finite measurements', () => {
    expect(advanceDockScroll(initialDockScroll(500), 520, 500).distance).toBe(0);
    expect(advanceDockScroll(initialDockScroll(), -100, 500)).toEqual(initialDockScroll());
    expect(advanceDockScroll(initialDockScroll(), Number.NaN, 500)).toEqual(initialDockScroll());
    expect(advanceDockScroll(initialDockScroll(), 100, Number.NaN).collapsed).toBe(false);
  });
});

describe('independent pane scrolling', () => {
  it('uses the first wheel travel when a short pane gains scrolling space', () => {
    const short = sampleDockScroll(undefined, 0, 0, false);
    expect(sampleDockScroll(short, 80, 140, false, false, 1).travel.collapsed).toBe(true);
    expect(sampleDockScroll(short, 80, 140, false).travel.collapsed).toBe(false);
  });
  it('keeps actual downward travel while a visible pane continues to grow', () => {
    let sample = sampleDockScroll(undefined, 0, 70, false);
    for (let top = 8; top <= 64; top += 8) {
      sample = sampleDockScroll(sample, top, 70 + top, false, false, 1);
    }
    expect(sample.travel.collapsed).toBe(true);
  });
  it('distinguishes an extent clamp from an actual upward wheel movement', () => {
    const detail = sampleDockScroll(undefined, 400, 800, true);
    expect(sampleDockScroll(detail, 200, 200, true, false, -1).travel.collapsed).toBe(true);
    expect(sampleDockScroll(detail, 180, 200, true, false, -1).travel.collapsed).toBe(false);
  });
  it('accumulates a slow descent while rejecting isolated single-pixel movement', () => {
    let sample = sampleDockScroll(undefined, 0, 500, false);
    for (let top = 1; top <= 63; top++) {
      sample = sampleDockScroll(sample, top, 500, false);
      expect(sample.travel.collapsed).toBe(false);
    }
    expect(sampleDockScroll(sample, 64, 500, false).travel.collapsed).toBe(true);
  });
  it('ignores upward scroll corrections during a descending wheel gesture', () => {
    let detail = sampleDockScroll(undefined, 280, 800, true);
    for (const top of [276, 272, 268, 261]) {
      detail = sampleDockScroll(detail, top, 800, true, false, 1);
      expect(detail.travel.collapsed).toBe(true);
    }
    expect(sampleDockScroll(detail, 240, 800, true, false, -1).travel.collapsed).toBe(false);
  });
  it('keeps the dock hidden while starting to scroll downward near the top of a second pane', () => {
    let detail = sampleDockScroll(undefined, 0, 800, true);
    for (const top of [4, 8, 12, 16]) {
      detail = sampleDockScroll(detail, top, 800, true);
      expect(detail.travel.collapsed).toBe(true);
    }
    expect(sampleDockScroll(detail, 8, 800, true).travel.collapsed).toBe(false);
  });
  it('keeps one dock visibility when a split detail pane reports its untouched top', () => {
    const catalogue = sampleDockScroll(sampleDockScroll(undefined, 0, 1500, false), 100, 1500, false);
    expect(catalogue.travel.collapsed).toBe(true);
    const detail = sampleDockScroll(sampleDockScroll(undefined, 0, 800, false), 0, 800, catalogue.travel.collapsed);
    expect(detail.travel.collapsed).toBe(true);
    expect(sampleDockScroll(undefined, 0, 0, detail.travel.collapsed).travel.collapsed).toBe(true);
  });
  it('resets resized pane travel without treating layout clamps as upward intent', () => {
    const detail = sampleDockScroll(undefined, 400, 800, true);
    const resized = sampleDockScroll(detail, 200, 200, true);
    expect(resized.travel.collapsed).toBe(true);
    expect(resized.travel.distance).toBe(0);
    expect(sampleDockScroll(resized, 180, 200, true).travel.collapsed).toBe(false);
  });
  it('ignores duplicate and one-pixel events across panes, but honors real upward movement', () => {
    let detail = sampleDockScroll(undefined, 40, 800, true);
    for (const top of [40, 39, 40, 39, 40]) detail = sampleDockScroll(detail, top, 800, true);
    expect(detail.travel.collapsed).toBe(true);
    expect(sampleDockScroll(detail, 24, 800, true).travel.collapsed).toBe(false);
  });
  it('hover, focus and explicit reveal still reset travel and open immediately', () => {
    const detail = sampleDockScroll(undefined, 400, 800, true);
    expect(sampleDockScroll(detail, 430, 800, true, true).travel).toEqual(initialDockScroll(430));
  });
});

describe('continuous dock surface geometry', () => {
  const box = { left: 0, top: 0, width: 640, height: 78, radius: 20 };
  const center = { left: 292, top: 22, width: 56, height: 56, radius: 28 };
  it('retains the original pill and contracts to one true circle at the bottom centre', () => {
    expect(foldDockBox(box, center, 0)).toEqual(box);
    expect(foldDockBox(box, center, 1)).toEqual(center);
  });
  it('retains continuous intermediate navigation shapes', () => {
    const half = foldDockBox(box, center, 0.5);
    expect(half).toEqual({ left: 146, top: 11, width: 348, height: 67, radius: 24 });
    expect(half.left + half.width / 2).toBe(320);
  });
  it('clips only local control ink to its corresponding continuous shape', () => {
    const folded = foldDockBox(box, center, 0.5);
    expect(foldDockClip(box, folded)).toBe('inset(11px 146px 0px 146px round 24px)');
  });
  it('keeps whole companion controls visible and bounds oversized scroll rails', () => {
    expect(dockSideWidth(0, 48, 6, 8, 400)).toBe(0);
    expect(dockSideWidth(4, 48, 6, 8, 300)).toBe(218);
    expect(dockSideWidth(9, 204, 12, 0, 690)).toBe(636);
    expect(dockSideWidth(4, 204, 12, 0, 100)).toBe(204);
  });
  it('uses a bounded smooth spring and retains velocity through interruption', () => {
    let motion = { value: 0, velocity: 0 };
    for (let frame = 0; frame < 6; frame++) motion = advanceDockFold(motion.value, motion.velocity, 1, 1 / 60);
    expect(motion.value).toBeGreaterThan(0.5);
    expect(motion.value).toBeLessThan(1);
    const reversed = advanceDockFold(motion.value, motion.velocity, 0, 0);
    expect(reversed).toEqual(motion);
    for (let frame = 0; frame < 60; frame++) {
      motion = advanceDockFold(motion.value, motion.velocity, 0, 1 / 60);
      expect(motion.value).toBeGreaterThanOrEqual(0);
      expect(motion.value).toBeLessThanOrEqual(1);
    }
    expect(motion).toEqual({ value: 0, velocity: 0 });
    expect(advanceDockFold(0.4, 2, 1, 0.016, true)).toEqual({ value: 1, velocity: 0 });
  });
});
