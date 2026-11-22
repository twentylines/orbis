import { type } from 'arktype';
import { arkAppUrn } from '../types/app-urn.js';

const base = {
  appUrn: arkAppUrn.narrow((value) => /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(value)),
  sampledAt: type('string').narrow(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  ),
};

export const installRecoveryReviewSchema = type.or(
  type({
    ...base,
    state: "'held'",
    hold: type({
      requestId: 'string.uuid',
      phase: type.enumerated('provisional', 'pending', 'spent'),
      reservation: type.enumerated('unconfirmed', 'matches', 'missing', 'changed'),
    }).onUndeclaredKey('reject'),
  }).onUndeclaredKey('reject'),
  type({ ...base, state: type.enumerated('clear', 'busy', 'unverified'), hold: 'null' }).onUndeclaredKey('reject'),
);

export type InstallRecoveryReview = typeof installRecoveryReviewSchema.infer;
