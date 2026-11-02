import type { TimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import { saveTimeMachinePreferences } from './time-machine-api';

export const timeMachinePreferencesQueryKey = (userId: string | number) => ['time-machine-preferences', userId] as const;

export function saveTimeMachineEnabled(preferences: TimeMachinePreferences, enabled: boolean, signal: AbortSignal) {
  const { version: _version, revision, ...values } = preferences;
  return saveTimeMachinePreferences({ ...values, expectedRevision: revision, enabled }, signal);
}
