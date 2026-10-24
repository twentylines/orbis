import { isNewBareUsername } from '@runtipi/common/schemas/account-identifier';
import { type } from 'arktype';

const email = type('string.email');
export const accountIdentifierHint =
  'Use an email address or a username with 3–64 letters, numbers, dots, underscores or hyphens. Usernames must start and end with a letter or number; common system names are reserved.';
export const newAccountIdentifier = type('string')
  .narrow((value) => email.allows(value.trim()) || isNewBareUsername(value))
  .configure({ message: accountIdentifierHint });
