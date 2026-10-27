import { expect, test } from 'bun:test';
import { characterEntry } from './use-character-motion';

test('password entry motion retains only masked characters', () => {
  const input = {
    type: 'password',
    selectionStart: 12,
    selectionEnd: 12,
    value: 'private-test-password',
  };
  const display = characterEntry(input, 'x');
  expect(display?.text).toBe('•'.repeat(input.value.length));
  expect(display?.character).toBe('•');
  expect(JSON.stringify(display)).not.toContain(input.value);
});

test('reconstructs the native text without duplicating inserted characters', () => {
  const display = characterEntry({ type: 'text', value: 'typing', selectionStart: 3, selectionEnd: 3 }, 'p');
  expect(display).toEqual({ before: 'ty', character: 'p', after: 'ing', text: 'typing' });
  expect(display && display.before + display.character + display.after).toBe('typing');
  expect(characterEntry({ type: 'text', value: 'typing', selectionStart: 1, selectionEnd: 4 })).toBeNull();
  expect(characterEntry({ type: 'text', value: 'a'.repeat(4097), selectionStart: 4097, selectionEnd: 4097 })).toBeNull();
});
