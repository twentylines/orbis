import { describe, expect, it } from 'vitest';
import { isNewBareUsername, reservedUsernames } from '@runtipi/common/schemas';
import { normalizeNewUsername } from '../username';

describe('new account identifiers', () => {
  it.each(['Sai', 'sai.home', 'sai-home', 'sai_home', '123', 'a'.repeat(64)])('accepts supported bare username %s', (value) => {
    expect(normalizeNewUsername(value)).toBe(value.toLowerCase());
    expect(isNewBareUsername(value)).toBe(true);
  });
  it.each([...reservedUsernames, ' ADMIN ', 'ab', 'a'.repeat(65), '-sai', 'sai.', 'sai home', '<script>', '日本語'])(
    'rejects new reserved or invalid username %s',
    (value) => {
      expect(normalizeNewUsername(value)).toBeNull();
    },
  );
  it('retains email identifiers and normalizes them without applying bare-username reserved rules', () => {
    expect(normalizeNewUsername(' Admin@Example.Test ')).toBe('admin@example.test');
    expect(normalizeNewUsername('wrong@')).toBeNull();
  });
});
