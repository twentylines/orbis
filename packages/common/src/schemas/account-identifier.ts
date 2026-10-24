export const reservedUsernames = [
  'admin',
  'administrator',
  'root',
  'system',
  'orbis',
  'runtipi',
  'support',
  'security',
  'operator',
  'moderator',
  'webmaster',
  'postmaster',
  'hostmaster',
  'abuse',
  'nobody',
  'anonymous',
  'guest',
  'null',
  'undefined',
] as const;
const reserved = new Set<string>(reservedUsernames);
export function isNewBareUsername(input: string) {
  const value = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(value) && !reserved.has(value);
}
