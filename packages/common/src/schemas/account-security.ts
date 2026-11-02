import { type } from 'arktype';

export const accountSecuritySchema = type({
  version: '1',
  revision: '0 <= number.integer <= 9007199254740991',
  requireCaptureAuthentication: 'boolean',
  'requireRestoreAuthentication?': 'boolean',
}).onUndeclaredKey('reject');
export type AccountSecurity = typeof accountSecuritySchema.infer;
export const accountSecurityUpdateSchema = type({
  expectedRevision: '0 <= number.integer <= 9007199254740991',
  requireCaptureAuthentication: 'boolean',
  'requireRestoreAuthentication?': 'boolean',
}).onUndeclaredKey('reject');
export const defaultAccountSecurity = (): AccountSecurity => ({
  version: 1,
  revision: 0,
  requireCaptureAuthentication: false,
  requireRestoreAuthentication: false,
});
