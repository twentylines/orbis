import { expect, test } from 'bun:test';
import { setupShortcut } from './setup-shortcuts';

const key = (value: string, changes = {}) => ({
  key: value,
  defaultPrevented: false,
  repeat: false,
  isComposing: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...changes,
});

test('Enter outside controls advances and Escape goes back, including from a field', () => {
  expect(setupShortcut(key('Enter'), false, false)).toBe('next');
  expect(setupShortcut(key('Escape'), false, false)).toBe('back');
  expect(setupShortcut(key('Escape'), true, false)).toBe('back');
});
test('native controls retain Enter and unrelated keys do nothing', () => {
  expect(setupShortcut(key('Enter'), true, false)).toBeNull();
  expect(setupShortcut(key('ArrowRight'), false, false)).toBeNull();
});
test('busy operations and open overlays never advance or dismiss setup', () => {
  for (const value of ['Enter', 'Escape']) expect(setupShortcut(key(value), false, true)).toBeNull();
});
test('composition, held keys, consumed events and keyboard modifiers do not navigate', () => {
  for (const flag of ['defaultPrevented', 'repeat', 'isComposing', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    for (const value of ['Enter', 'Escape']) expect(setupShortcut(key(value, { [flag]: true }), false, false)).toBeNull();
  }
});
