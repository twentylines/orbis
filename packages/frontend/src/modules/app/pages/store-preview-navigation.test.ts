/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { nextStorePreviewHistory, storePreviewDepth, storeReturnPath } from './store-preview-navigation';

describe('Store preview history', () => {
  test('a direct app link returns to its selected store without retaining detail tabs', () => {
    expect(storeReturnPath(null, '?store=official&tab=description')).toBe('/app-store?store=official');
  });
  test('a catalogue selection preserves the original list URL', () => {
    expect(nextStorePreviewHistory({ storeReturnPath: '/app-store?store=community' }, '?tab=description')).toEqual({
      storeReturnPath: '/app-store?store=community',
      storePreviewDepth: 1,
    });
  });
  test('selecting another app records how many entries close must go back', () => {
    const first = nextStorePreviewHistory(null, '?store=official');
    expect(nextStorePreviewHistory(first, '?store=official')).toEqual({ storeReturnPath: '/app-store?store=official', storePreviewDepth: 2 });
  });
  test.each(['https://example.invalid/', '//example.invalid/', '/apps', '/app-store/source/app'])(
    'never uses an unrelated saved close destination: %s',
    (path) => {
      expect(storeReturnPath({ storeReturnPath: path }, '')).toBe('/app-store');
    },
  );
  test('direct URLs never navigate backward into an unrelated page', () => {
    expect(storePreviewDepth(null)).toBe(0);
    expect(storePreviewDepth({ storePreviewDepth: -2 })).toBe(0);
    expect(storePreviewDepth({ storePreviewDepth: 1.5 })).toBe(0);
  });
  test('tabs and selections after a direct deep link keep the safe catalogue close destination', () => {
    const tab = nextStorePreviewHistory(null, '?store=official', true);
    expect(tab).toEqual({ storeReturnPath: '/app-store?store=official', storePreviewDepth: 0 });
    expect(nextStorePreviewHistory(tab, '?tab=info', true)).toEqual(tab);
  });
  test('an excessive history chain closes to the catalogue instead of an earlier preview', () => {
    expect(nextStorePreviewHistory({ storePreviewDepth: 50 }, '', true).storePreviewDepth).toBe(0);
  });
});
