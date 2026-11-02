import { ConflictException } from '@nestjs/common';
import { timeMachineLimits, type TimeMachineCapabilities, type TimeMachineIssue, type TimeMachineReason } from '@runtipi/common/schemas/time-machine';

const messages: Record<TimeMachineReason, string> = {
  'docker-images-not-retained': 'Docker image layers are not retained in this experimental capture.',
  'controller-version-not-pinned': 'Restoring the captured Orbis controller version is not available yet.',
  'app-exclusions-unsupported': 'App exclusions require a coherent database restore and are not available yet.',
  'activation-not-integrated': 'Time Machine activation is not available yet. Existing encrypted backup restore remains separate.',
  'action-bound-auth-unavailable': 'Fresh authentication bound to this restore point is not available yet.',
  'cluster-not-sealed': 'This is a local capture. Other cluster hosts have not been sealed together.',
  'os-snapshots-unsupported': 'Native operating system snapshots are not supported by this capture method.',
  'automatic-capture-unsupported': 'Automatic captures are not available yet. Keep scheduled and automatic triggers off.',
  'preview-not-captured': 'No saved Home appearance was present at capture time.',
  'preview-invalid': 'The historical Home projection could not be validated. Current appearance will not be substituted.',
  'custom-wallpaper-unavailable': 'The historical custom wallpaper is archived, but preview delivery is not available yet.',
  'historical-assets-unavailable': 'Point-bound historical wallpaper delivery is not available. Current photographs will not be substituted.',
  'screenshot-not-captured': 'This point contains a historical Home projection, not a captured screenshot.',
  'capture-interrupted': 'Capture was interrupted. Check the linked backup job for app recovery before retrying.',
  'capture-failed': 'Capture did not finish. Review storage, app state and the linked backup job before retrying.',
  'capture-recovery-required': 'The underlying backup needs app recovery before another capture can begin.',
  'experimental-acknowledgement-required': 'Acknowledge experimental capture limitations before making a restore point.',
  'capacity-exceeded': 'Retained restore points reached the storage limit. Remove an older point or free storage before retrying.',
  'storage-unavailable': 'Time Machine storage needs a permissions or integrity review.',
  'point-not-found': 'This restore point is not available.',
  'point-integrity-failed': 'The retained restore point did not pass its integrity checks.',
  'revision-conflict': 'Time Machine settings changed. Refresh before saving again.',
  'operation-busy': 'Finish the current capture or recovery before starting another operation.',
  'invalid-request': 'The Time Machine request is invalid.',
  'proxy-layout-migration-required':
    'The proxy needs an explicit storage layout migration before coherent capture. Existing HTTPS identity and server data were preserved.',
  'host-capture-support-required':
    'Update and verify the Orbis host service with controller configuration capture support before creating this restore point.',
};
export const timeMachineIssue = (code: TimeMachineReason): TimeMachineIssue => ({ code, message: messages[code] });
export const timeMachineConflict = (code: TimeMachineReason) => new ConflictException(timeMachineIssue(code));
export const timeMachineRestoreBlockers = (): TimeMachineIssue[] =>
  (['docker-images-not-retained', 'controller-version-not-pinned', 'activation-not-integrated'] as const).map(timeMachineIssue);
export const timeMachineCapabilities = (): TimeMachineCapabilities => ({
  version: 1,
  experimental: true,
  manualCapture: true,
  experimentalAcknowledgementRequired: true,
  automaticCapture: { scheduled: false, preUpdate: false, preRestart: false },
  osSnapshots: { supported: false, reason: timeMachineIssue('os-snapshots-unsupported') },
  dockerImages: { capture: true, restore: false },
  appExclusions: { capture: false, restore: false },
  cluster: { supported: false, requiresAllHostsSealed: true },
  restore: { supported: false, blockers: timeMachineRestoreBlockers() },
  exportSealedPoints: false,
  limits: timeMachineLimits,
});
