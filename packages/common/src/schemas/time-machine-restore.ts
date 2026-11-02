import { type } from 'arktype';
import { timeMachineHashSchema, timeMachineIdSchema } from './time-machine.js';

const bytes = type('0 <= number.integer <= 9007199254740991');
const timestamp = type('0 < number.integer <= 9007199254740991');
const text = type('string > 0 & string <= 240').narrow((value) =>
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && !'<>'.includes(character)),
);

export const timeMachineRestoreIssueSchema = type({
  code: type.enumerated(
    'review-required',
    'review-expired',
    'point-not-found',
    'point-integrity-failed',
    'image-state-unavailable',
    'controller-version-unsupported',
    'source-version-incompatible',
    'excluded-apps-unsupported',
    'storage-unavailable',
    'authorization-required',
    'authorization-expired',
    'authorization-invalid',
    'passkey-unavailable',
    'operation-busy',
    'restore-preparation-failed',
    'restore-recovery-required',
    'invalid-request',
  ),
  message: text,
}).onUndeclaredKey('reject');
export type TimeMachineRestoreIssue = typeof timeMachineRestoreIssueSchema.infer;

const bindingDefinition = {
  pointId: timeMachineIdSchema,
  reviewId: timeMachineIdSchema,
  archiveSha256: timeMachineHashSchema,
  manifestSha256: timeMachineHashSchema,
  machineId: timeMachineHashSchema,
};
export const timeMachineRestoreBindingSchema = type(bindingDefinition).onUndeclaredKey('reject');
export type TimeMachineRestoreBinding = typeof timeMachineRestoreBindingSchema.infer;

export const timeMachineRestoreProgressSchema = type({
  stage: type.enumerated('opening', 'inspecting', 'database', 'images', 'checking', 'ready', 'failed'),
  completedBytes: bytes,
  totalBytes: bytes.or('null'),
})
  .onUndeclaredKey('reject')
  .narrow((value) => value.totalBytes === null || value.completedBytes <= value.totalBytes);

export const timeMachineRestoreReviewSchema = type({
  ...bindingDefinition,
  version: '1',
  status: type.enumerated('reviewing', 'eligible', 'ready', 'blocked', 'failed'),
  ready: 'boolean',
  expiresAt: timestamp.or('null'),
  blockers: timeMachineRestoreIssueSchema.array().atMostLength(16),
  progress: timeMachineRestoreProgressSchema,
})
  .onUndeclaredKey('reject')
  .narrow((value) =>
    value.status === 'ready'
      ? value.ready && value.expiresAt !== null && value.blockers.length === 0 && value.progress.stage === 'ready'
      : value.status === 'eligible'
        ? !value.ready && value.expiresAt !== null && value.blockers.length === 0 && value.progress.stage === 'checking'
        : !value.ready && value.expiresAt === null && (value.status === 'reviewing' || value.blockers.length > 0),
  );
export type TimeMachineRestoreReview = typeof timeMachineRestoreReviewSchema.infer;
export const timeMachineRestoreReviewResponseSchema = type({ version: '1', review: timeMachineRestoreReviewSchema.or('null') }).onUndeclaredKey(
  'reject',
);

export const timeMachineRestoreGrantSchema = type({
  ...bindingDefinition,
  version: '1',
  grantId: timeMachineIdSchema,
  expiresAt: timestamp,
}).onUndeclaredKey('reject');
export type TimeMachineRestoreGrant = typeof timeMachineRestoreGrantSchema.infer;

export const timeMachineRestoreActivateSchema = type({
  reviewId: timeMachineIdSchema,
  grantId: timeMachineIdSchema,
  manifestSha256: timeMachineHashSchema,
  confirmation: "'replace-server'",
}).onUndeclaredKey('reject');
export type TimeMachineRestoreActivate = typeof timeMachineRestoreActivateSchema.infer;

const base64 = type('string > 0 & string <= 2048').narrow((value) => /^[A-Za-z0-9_-]+$/.test(value));
const credentialTransports = type.enumerated('ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb');
export const timeMachineRestorePasskeyOptionsSchema = type({
  version: '1',
  method: "'passkey'",
  reviewId: timeMachineIdSchema,
  challengeId: timeMachineIdSchema,
  expiresAt: timestamp,
  requiresTotp: 'boolean',
  options: type({
    challenge: base64,
    rpId: type('string > 0 & string <= 253').narrow((value) => /^[a-z0-9][a-z0-9.-]*$/.test(value)),
    timeout: '0 < number.integer <= 120000',
    userVerification: "'required'",
    allowCredentials: type({ type: "'public-key'", id: base64, 'transports?': credentialTransports.array().atMostLength(8) })
      .onUndeclaredKey('reject')
      .array()
      .atLeastLength(1)
      .atMostLength(10),
  }).onUndeclaredKey('reject'),
}).onUndeclaredKey('reject');
export type TimeMachineRestorePasskeyOptions = typeof timeMachineRestorePasskeyOptionsSchema.infer;
