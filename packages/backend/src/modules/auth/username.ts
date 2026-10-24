import validator from 'validator';
import { isNewBareUsername } from '@runtipi/common/schemas';

export function normalizeNewUsername(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (value.length > 254) return null;
  if (validator.isEmail(value)) return value;
  if (!isNewBareUsername(value)) return null;
  return value;
}
