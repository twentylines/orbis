import { ConflictException } from '@nestjs/common';
import type { TimeMachineRestoreIssue } from '@runtipi/common/schemas/time-machine-restore';

const messages: Record<TimeMachineRestoreIssue['code'], string> = {
  'review-required': 'Review this exact restore point before confirming it.',
  'review-expired': 'This review expired. Review the point again before continuing.',
  'point-not-found': 'This restore point is not available.',
  'point-integrity-failed': 'The retained restore point did not pass its integrity checks.',
  'image-state-unavailable': 'This point does not retain complete Docker image state.',
  'controller-version-unsupported': 'The captured controller version cannot be restored safely yet.',
  'source-version-incompatible': 'The captured software or database version needs a compatible restore worker.',
  'excluded-apps-unsupported': 'Excluded apps need a coherent data and version merge before restore.',
  'storage-unavailable': 'The private review storage needs a permissions or integrity review.',
  'authorization-required': 'Verify your account for this exact restore.',
  'authorization-expired': 'Fresh verification expired. Verify this restore again.',
  'authorization-invalid': 'Fresh verification did not match this restore.',
  'passkey-unavailable': 'A passkey is not available on this address or account.',
  'operation-busy': 'Finish the current capture, review or recovery first.',
  'restore-preparation-failed': 'The retained backup could not be reviewed. No server data has been changed.',
  'restore-recovery-required': 'An app or server operation needs recovery before reviewing this point.',
  'invalid-request': 'The restore request is invalid.',
};
export const restoreIssue = (code: TimeMachineRestoreIssue['code']): TimeMachineRestoreIssue => ({ code, message: messages[code] });
export const restoreConflict = (code: TimeMachineRestoreIssue['code']) => new ConflictException(restoreIssue(code));
