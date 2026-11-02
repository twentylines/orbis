import { expect, test } from 'bun:test';
import {
  defaultTimeMachinePreferences,
  timeMachineCaptureSchema,
  timeMachinePreferencesSchema,
  timeMachinePreferencesUpdateSchema,
  timeMachineMetadataSchema,
  timeMachineRuntimeSummarySchema,
} from './time-machine.js';

test('experimental manual capture is enabled while every automatic trigger is off', () => {
  const preferences = defaultTimeMachinePreferences();
  expect(preferences.enabled).toBe(true);
  expect(preferences.schedule.enabled).toBe(false);
  expect(preferences.beforeUpdate).toBe(false);
  expect(preferences.beforeRestart).toBe(false);
  expect(timeMachinePreferencesSchema.allows(preferences)).toBe(true);
  expect(timeMachinePreferencesSchema.allows({ ...preferences, beforeUpdate: true })).toBe(false);
  expect(timeMachinePreferencesSchema.allows({ ...preferences, schedule: { enabled: true, intervalHours: 24 } })).toBe(false);
});

test('capture accepts a bounded plain name without requiring an acknowledgement or executable fields', () => {
  expect(timeMachineCaptureSchema.allows({ label: 'Before changing storage' })).toBe(true);
  expect(timeMachineCaptureSchema.allows({ experimentalAcknowledged: true, label: 'Before changing storage' })).toBe(true);
  expect(timeMachineCaptureSchema.allows({ experimentalAcknowledged: false, label: '' })).toBe(false);
  for (const label of ['<script>run()</script>', 'a'.repeat(241), 'line\nbreak'])
    expect(timeMachineCaptureSchema.allows({ experimentalAcknowledged: true, label })).toBe(false);
  expect(timeMachineCaptureSchema.allows({ experimentalAcknowledged: true, label: '', code: 'run()' })).toBe(false);
});

test('preference requests have bounded unique app identities and explicit revision', () => {
  const { version: _version, revision, ...value } = defaultTimeMachinePreferences();
  const request = { ...value, expectedRevision: revision };
  expect(timeMachinePreferencesUpdateSchema.allows({ ...request, excludedApps: ['jellyfin:store'] })).toBe(true);
  for (const excludedApps of [['../../data'], ['app:store', 'app:store'], Array.from({ length: 513 }, (_, id) => `app${id}:store`)])
    expect(timeMachinePreferencesUpdateSchema.allows({ ...request, excludedApps })).toBe(false);
  expect(timeMachinePreferencesUpdateSchema.allows({ ...request, expectedRevision: -1 })).toBe(false);
});

test('legacy coverage cannot be presented as Docker-complete or activation-ready', () => {
  expect(timeMachineMetadataSchema.allows({ version: 1, restore: { ready: true, blockers: [] } })).toBe(false);
  expect(timeMachineMetadataSchema.allows({ version: 1, coverage: { dockerImages: true } })).toBe(false);
});

test('runtime summaries contain only bounded hash/count identities and reject private payloads', () => {
  const summary = {
    version: 1,
    cipherBytes: 128,
    cipherSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    imageCaptureSha256: 'c'.repeat(64),
    imageInventorySha256: 'd'.repeat(64),
    configurationSetSha256: 'e'.repeat(64),
    imageCount: 1,
    bindingCount: 3,
  };
  expect(timeMachineRuntimeSummarySchema.allows(summary)).toBe(true);
  for (const extra of [{ data: 'private' }, { files: [] }, { rootIdentity: {} }, { password: 'private' }])
    expect(timeMachineRuntimeSummarySchema.allows({ ...summary, ...extra })).toBe(false);
  expect(timeMachineRuntimeSummarySchema.allows({ ...summary, imageCount: 257 })).toBe(false);
  expect(timeMachineRuntimeSummarySchema.allows({ ...summary, cipherSha256: 'invalid' })).toBe(false);
});
