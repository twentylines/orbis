import { expect, it } from 'vitest';
import type { ControllerCaptureAuthorityReceipt } from '../host-updates/host-controller-capture-authority';
import { captureHasControllerVersion, versionMatchesControllerAuthority } from './time-machine-controller-version';
import type { CapturedRuntimeInput } from './time-machine-runtime-payload';

function authority(tag: unknown): ControllerCaptureAuthorityReceipt {
  return { metadata: { publication: { tag } } } as unknown as ControllerCaptureAuthorityReceipt;
}
it('requires the exact valid version from the verified controller authority', () => {
  expect(versionMatchesControllerAuthority('v0.5.0-beta.3', authority('v0.5.0-beta.3'))).toBe(true);
  expect(versionMatchesControllerAuthority('v0.5.0-beta.4', authority('v0.5.0-beta.3'))).toBe(false);
  expect(versionMatchesControllerAuthority('invalid', authority('invalid'))).toBe(false);
  expect(versionMatchesControllerAuthority('v0.5.0-beta.3', authority(null))).toBe(false);
  expect(versionMatchesControllerAuthority('v0.5.0-beta.3', undefined)).toBe(false);
});

it('does not promote a matching label without the authenticated capture proof and coherence binding', () => {
  const forged = {
    controllerAuthority: authority('v0.5.0-beta.3'),
    coherence: { controllerAuthoritySha256: '0'.repeat(64) },
  } as unknown as CapturedRuntimeInput;
  expect(captureHasControllerVersion('v0.5.0-beta.3', forged)).toBe(false);
});
