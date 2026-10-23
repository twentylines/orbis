/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { copyText } from './clipboard';

function page({ copied = true, commandThrows = false, appendThrows = false, focusThrows = false, connected = true } = {}) {
  const events: string[] = [];
  const children = new Set<unknown>();
  const originalRange = { cloneRange: () => savedRange };
  const savedRange = {};
  const selection = {
    rangeCount: 1,
    getRangeAt: () => originalRange,
    removeAllRanges: () => events.push('restore-document-selection'),
    addRange: (range: unknown) => {
      expect(range).toBe(savedRange);
      events.push('restore-range');
    },
  };
  const opener = {
    isConnected: connected,
    selectionStart: 2,
    selectionEnd: 5,
    selectionDirection: 'backward',
    focus: (options: unknown) => {
      expect(options).toEqual({ preventScroll: true });
      events.push('restore-focus');
      if (focusThrows) throw new Error('Focus blocked');
    },
    setSelectionRange: (start: number, end: number, direction: string) => {
      expect([start, end, direction]).toEqual([2, 5, 'backward']);
      events.push('restore-input-selection');
    },
  };
  const field = {
    value: '',
    readOnly: false,
    tabIndex: 0,
    style: { cssText: '' },
    focus: () => events.push('temporary-focus'),
    select: () => events.push('select'),
    setSelectionRange: (start: number, end: number) => {
      expect(start).toBe(0);
      expect(end).toBe(field.value.length);
      events.push('select-range');
    },
    remove: () => {
      children.delete(field);
      events.push('remove');
    },
  };
  const doc = {
    activeElement: opener,
    getSelection: () => selection,
    body: {
      appendChild: (node: unknown) => {
        if (appendThrows) throw new Error('DOM blocked');
        children.add(node);
        events.push('append');
      },
    },
    createElement: (tag: string) => {
      expect(tag).toBe('textarea');
      return field;
    },
    execCommand: (command: string) => {
      expect(command).toBe('copy');
      events.push('copy');
      if (commandThrows) throw new Error('Copy denied');
      return copied;
    },
  };
  return { document: doc as unknown as Document, events, children, field };
}
describe('copy without requiring a secure-context Clipboard API', () => {
  test('native Clipboard API succeeds without temporary focus or DOM changes', async () => {
    const fixture = page();
    let writes = 0;
    expect(
      await copyText('sample text', {
        document: fixture.document,
        clipboard: {
          writeText: async (text) => {
            expect(text).toBe('sample text');
            writes++;
          },
        },
      }),
    ).toBe(true);
    expect(writes).toBe(1);
    expect(fixture.events).toEqual([]);
  });
  test('missing API copies synchronously inside the initiating user gesture and restores focus and selections', async () => {
    const fixture = page();
    const result = copyText('sample text', { document: fixture.document, clipboard: null });
    expect(fixture.events).toContain('copy');
    expect(await result).toBe(true);
    expect(fixture.field.readOnly).toBe(true);
    expect(fixture.field.tabIndex).toBe(-1);
    expect(fixture.events).toEqual([
      'append',
      'temporary-focus',
      'select',
      'select-range',
      'copy',
      'remove',
      'restore-focus',
      'restore-document-selection',
      'restore-range',
      'restore-input-selection',
    ]);
    expect(fixture.children.size).toBe(0);
  });
  test('denied native permission can use the legacy fallback', async () => {
    const fixture = page();
    expect(
      await copyText('sample text', {
        document: fixture.document,
        clipboard: {
          writeText: async () => {
            throw new Error('Not allowed');
          },
        },
      }),
    ).toBe(true);
    expect(fixture.events).toContain('copy');
    expect(fixture.children.size).toBe(0);
  });
  test.each([{ copied: false }, { commandThrows: true }, { appendThrows: true }])(
    'blocked fallback returns false and cleans up: %p',
    async (options) => {
      const fixture = page(options);
      expect(await copyText('sample text', { document: fixture.document, clipboard: null })).toBe(false);
      expect(fixture.children.size).toBe(0);
      expect(fixture.events).toContain('restore-focus');
      expect(fixture.events).toContain('restore-input-selection');
    },
  );
  test('missing clipboard and copy command produce a manual-copy result instead of an exception', async () => {
    expect(await copyText('sample text', { document: { body: {} } as Document, clipboard: null })).toBe(false);
    expect(await copyText('sample text', { document: null, clipboard: null })).toBe(false);
  });
  test('cleanup tolerates a removed opener or a failed focus restoration', async () => {
    for (const options of [{ connected: false }, { focusThrows: true }]) {
      const fixture = page(options);
      expect(await copyText('sample text', { document: fixture.document, clipboard: null })).toBe(true);
      expect(fixture.children.size).toBe(0);
      expect(fixture.events).toContain('restore-range');
    }
  });
  test('a blocked clipboard getter still permits the fallback', async () => {
    const fixture = page();
    expect(
      await copyText('sample text', {
        document: fixture.document,
        get clipboard(): Clipboard {
          throw new Error('Clipboard blocked');
        },
      }),
    ).toBe(true);
    expect(fixture.children.size).toBe(0);
  });
});
