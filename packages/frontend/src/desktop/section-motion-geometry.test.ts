/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { sectionSurfaceFrames, visibleSectionBounds } from './section-motion-geometry';

describe('live section surface geometry', () => {
  test('a long Monitor page starts shrinking from its visible height', () => {
    const previous = visibleSectionBounds({ left: 24, top: 112, width: 1392, height: 9563 }, 1100);
    const next = visibleSectionBounds({ left: 24, top: 112, width: 1392, height: 480 }, 1100);
    expect(sectionSurfaceFrames(previous, next)).toEqual([
      { width: '1392px', height: '988px', transform: 'translate(0px, 0px)' },
      { width: '1392px', height: '480px', transform: 'none' },
    ]);
  });

  test('short content preserves its actual height', () => {
    expect(visibleSectionBounds({ left: 16, top: 100, width: 288, height: 200 }, 640).height).toBe(200);
  });

  test('a section scrolled above the viewport never uses more than the viewport', () => {
    expect(visibleSectionBounds({ left: 16, top: -120, width: 288, height: 1200 }, 640)).toEqual({ left: 16, top: 0, width: 288, height: 640 });
  });

  test('an interrupted surface moves from its current geometry without scaling text', () => {
    expect(sectionSurfaceFrames({ left: 20, top: 112, width: 1300, height: 620 }, { left: 40, top: 112, width: 1260, height: 480 })[0]).toEqual({
      width: '1300px',
      height: '620px',
      transform: 'translate(-20px, 0px)',
    });
  });
});
