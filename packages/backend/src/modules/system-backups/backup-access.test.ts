import { expect, it } from 'vitest';
import { backupCredentials } from './backup-access';

it('accepts an eight-character backup key without changing the operator credential', () => {
  expect(backupCredentials({ password: '12345678', passphrase: '12345678' }, true)).toMatchObject({
    password: '12345678',
    passphrase: '12345678',
  });
  expect(backupCredentials({ password: ' abcdefg', passphrase: ' abcdefg' }, true).passphrase).toBe(' abcdefg');
  for (const passphrase of ['1234567', '        ', 'x'.repeat(1025)])
    expect(() => backupCredentials({ password: 'password', passphrase }, true)).toThrow();
});
