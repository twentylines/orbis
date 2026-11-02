import { describe, expect, it } from 'bun:test';
import {
  timeMachineRestoreActivateSchema,
  timeMachineRestoreGrantSchema,
  timeMachineRestoreReviewSchema,
  timeMachineRestorePasskeyOptionsSchema,
} from './time-machine-restore.js';

const identity = {
  pointId: '11111111-1111-4111-8111-111111111111',
  reviewId: '22222222-2222-4222-8222-222222222222',
  archiveSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  machineId: 'c'.repeat(64),
};
const ready = {
  ...identity,
  version: 1,
  status: 'ready',
  ready: true,
  expiresAt: 1000,
  blockers: [],
  progress: { stage: 'ready', completedBytes: 20, totalBytes: 20 },
};

describe('Time Machine restore response contracts', () => {
  it('bounds passkey options and requires user verification without accepting a caller origin', () => {
    const options = {
      version: 1,
      method: 'passkey',
      reviewId: identity.reviewId,
      challengeId: identity.pointId,
      expiresAt: 1000,
      requiresTotp: false,
      options: {
        challenge: 'trustedChallenge',
        rpId: 'orbis.example.test',
        timeout: 120000,
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: 'credential', transports: ['internal'] }],
      },
    };
    expect(timeMachineRestorePasskeyOptionsSchema.allows(options)).toBe(true);
    expect(timeMachineRestorePasskeyOptionsSchema.allows({ ...options, options: { ...options.options, userVerification: 'preferred' } })).toBe(false);
    expect(timeMachineRestorePasskeyOptionsSchema.allows({ ...options, options: { ...options.options, origin: 'https://other.example.test' } })).toBe(
      false,
    );
  });
  it('accepts a verified ready review and a genuinely indeterminate review', () => {
    expect(timeMachineRestoreReviewSchema.allows(ready)).toBe(true);
    expect(
      timeMachineRestoreReviewSchema.allows({
        ...ready,
        status: 'reviewing',
        ready: false,
        expiresAt: null,
        progress: { stage: 'images', completedBytes: 3, totalBytes: null },
      }),
    ).toBe(true);
  });
  it('rejects claimed readiness without expiry or with blockers', () => {
    for (const delta of [
      { expiresAt: null },
      { blockers: [{ code: 'image-state-unavailable', message: 'Image data is unavailable.' }] },
      { status: 'reviewing' },
      { progress: { stage: 'images', completedBytes: 20, totalBytes: 20 } },
    ])
      expect(timeMachineRestoreReviewSchema.allows({ ...ready, ...delta })).toBe(false);
  });
  it('distinguishes provisional eligibility from verified readiness', () => {
    const eligible = { ...ready, status: 'eligible', ready: false, progress: { stage: 'checking', completedBytes: 0, totalBytes: null } };
    expect(timeMachineRestoreReviewSchema.allows(eligible)).toBe(true);
    for (const delta of [
      { ready: true },
      { expiresAt: null },
      { progress: ready.progress },
      { blockers: [{ code: 'image-state-unavailable', message: 'Unavailable.' }] },
    ])
      expect(timeMachineRestoreReviewSchema.allows({ ...eligible, ...delta })).toBe(false);
  });
  it('requires a safe typed reason for a blocked or failed review', () => {
    const blocked = { ...ready, status: 'blocked', ready: false, expiresAt: null };
    expect(timeMachineRestoreReviewSchema.allows(blocked)).toBe(false);
    expect(
      timeMachineRestoreReviewSchema.allows({
        ...blocked,
        blockers: [{ code: 'controller-version-unsupported', message: 'This controller version needs a compatible restore worker.' }],
      }),
    ).toBe(true);
  });
  it('rejects excess progress, unknown fields and untrusted display strings', () => {
    expect(timeMachineRestoreReviewSchema.allows({ ...ready, progress: { stage: 'ready', completedBytes: 21, totalBytes: 20 } })).toBe(false);
    expect(timeMachineRestoreReviewSchema.allows({ ...ready, password: 'unexpected' })).toBe(false);
    expect(
      timeMachineRestoreReviewSchema.allows({
        ...ready,
        status: 'failed',
        ready: false,
        expiresAt: null,
        blockers: [{ code: 'invalid-request', message: '<script>' }],
      }),
    ).toBe(false);
  });
  it('binds grants and activation to exact identities without accepting credentials', () => {
    const grant = { ...identity, version: 1, grantId: '33333333-3333-4333-8333-333333333333', expiresAt: 1000 };
    expect(timeMachineRestoreGrantSchema.allows(grant)).toBe(true);
    const activate = { reviewId: identity.reviewId, grantId: grant.grantId, manifestSha256: identity.manifestSha256, confirmation: 'replace-server' };
    expect(timeMachineRestoreActivateSchema.allows(activate)).toBe(true);
    expect(timeMachineRestoreActivateSchema.allows({ ...activate, password: 'unexpected' })).toBe(false);
    expect(timeMachineRestoreActivateSchema.allows({ ...activate, confirmation: 'anything' })).toBe(false);
  });
});
