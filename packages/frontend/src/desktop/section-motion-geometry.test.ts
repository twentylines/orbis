/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { sectionDirection, visibleSectionBounds } from './section-motion-geometry';

describe('live section surface geometry', () => {
  test('caps long pages while retaining the height of short pages', () => {
    const previous = visibleSectionBounds({ left: 24, top: 112, width: 1392, height: 9563 }, 1100);
    const next = visibleSectionBounds({ left: 24, top: 112, width: 1392, height: 480 }, 1100);
    expect(previous.height).toBe(988);
    expect(next.height).toBe(480);
  });

  test('short content preserves its actual height', () => {
    expect(visibleSectionBounds({ left: 16, top: 100, width: 288, height: 200 }, 640).height).toBe(200);
  });

  test('a section scrolled above the viewport never uses more than the viewport', () => {
    expect(visibleSectionBounds({ left: 16, top: -120, width: 288, height: 1200 }, 640)).toEqual({ left: 16, top: 0, width: 288, height: 640 });
  });
});

describe('history section direction', () => {
  test('Back follows history even when the target section appears later in the dock', () => {
    expect(sectionDirection(0, 5, 'POP', 4, 3)).toBe(-1);
  });
  test('Forward follows history even when the target section appears earlier in the dock', () => {
    expect(sectionDirection(5, 0, 'POP', 3, 4)).toBe(1);
  });
  test('normal navigation follows section order', () => {
    expect(sectionDirection(5, 0, 'PUSH', 3, 4)).toBe(-1);
  });
  test('caps the visible area of a tall page', () => {
    const target = visibleSectionBounds({ left: 24, top: 112, width: 900, height: 9600 }, 1100);
    expect(target.height).toBe(988);
  });
});
