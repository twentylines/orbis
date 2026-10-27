import { isNewBareUsername } from '@runtipi/common/schemas/account-identifier';
import { type } from 'arktype';

const email = type('string.email');
export const accountIdentifierHint =
  'Use an email address or a username with 3–64 letters, numbers, dots, underscores or hyphens. Usernames must start and end with a letter or number; common system names are reserved.';
export const newAccountIdentifier = type('string')
  .narrow((value) => email.allows(value.trim()) || isNewBareUsername(value))
  .configure({ message: accountIdentifierHint });

export const signInIdentifierMessage = 'Enter your username or email.';
export const signInPasswordMessage = 'Enter your password.';

// Sign-in must continue to accept existing identifiers, including reserved or
// legacy values that are no longer accepted for new accounts.
export const signInAccountIdentifier = type('string')
  .narrow((value) => value.trim().length > 0)
  .configure({ message: signInIdentifierMessage });

export const signInPassword = type('string')
  .narrow((value) => value.length > 0)
  .configure({ message: signInPasswordMessage });
