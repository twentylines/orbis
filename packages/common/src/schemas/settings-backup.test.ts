import { expect, test } from 'bun:test';
import {
  defaultSettingsBackupSelection,
  defaultTimeMachineCaptureScope,
  settingsBackupSelectionContained,
  settingsBackupSelectionSchema,
  settingsBackupRestoreSelectionSchema,
  timeMachineCaptureScopeSchema,
  settingsBackupJobSchema,
} from './settings-backup.js';

const point = '11111111-1111-4111-8111-111111111111';
const none = { version: 1 as const, settings: false, dashboard: false, wallpapers: false, themes: false, timeMachine: [] as string[] };

test('default settings export contains no update state, app data or implicit capture library', () => {
  expect(defaultSettingsBackupSelection()).toEqual({ version: 1, settings: true, dashboard: true, wallpapers: true, themes: true, timeMachine: [] });
  expect(settingsBackupSelectionSchema.allows(defaultSettingsBackupSelection())).toBe(true);
  for (const key of ['updateState', 'docker', 'media', 'passwords', 'hostSnapshots'])
    expect(settingsBackupSelectionSchema.allows({ ...defaultSettingsBackupSelection(), [key]: true })).toBe(false);
});

test('the user may export any nonempty combination, including only chosen captures', () => {
  expect(settingsBackupSelectionSchema.allows(none)).toBe(false);
  expect(settingsBackupSelectionSchema.allows({ ...none, themes: true })).toBe(true);
  expect(settingsBackupSelectionSchema.allows({ ...none, timeMachine: [point] })).toBe(true);
  for (const timeMachine of [[point, point], ['../capture'], Array(17).fill(point)])
    expect(settingsBackupSelectionSchema.allows({ ...none, timeMachine })).toBe(false);
});

test('automatic and manual scope defaults never opt Docker apps in implicitly', () => {
  const automatic = defaultTimeMachineCaptureScope();
  const manual = defaultTimeMachineCaptureScope();
  expect(automatic).toEqual({ version: 1, orbis: true, apps: [] });
  automatic.apps.push('jellyfin:store');
  expect(manual.apps).toEqual([]);
});

test('captures allow Orbis, selected apps or both, without accepting OS snapshots or ambiguous app IDs', () => {
  expect(timeMachineCaptureScopeSchema.allows({ version: 1, orbis: false, apps: [] })).toBe(false);
  expect(timeMachineCaptureScopeSchema.allows({ version: 1, orbis: false, apps: ['custom:_user'] })).toBe(true);
  expect(timeMachineCaptureScopeSchema.allows({ version: 1, orbis: true, apps: ['jellyfin:store'] })).toBe(true);
  for (const apps of [['a:b', 'a:b'], ['../a:b'], ['a:b:c'], Array(513).fill('a:b')])
    expect(timeMachineCaptureScopeSchema.allows({ version: 1, orbis: true, apps })).toBe(false);
  expect(timeMachineCaptureScopeSchema.allows({ ...defaultTimeMachineCaptureScope(), os: true })).toBe(false);
});

test('restore can choose a subset of verified contents but cannot silently add anything', () => {
  const available = { ...none, settings: true, themes: true, timeMachine: [point] };
  expect(settingsBackupSelectionContained(available, { ...none, themes: true })).toBe(true);
  expect(settingsBackupSelectionContained(available, { ...none, timeMachine: [point] })).toBe(true);
  expect(settingsBackupSelectionContained(available, { ...available, wallpapers: true })).toBe(false);
  expect(settingsBackupSelectionContained(available, { ...available, timeMachine: ['22222222-2222-4222-8222-222222222222'] })).toBe(false);
  expect(settingsBackupSelectionContained(available, none)).toBe(false);
});

test('restore choices bind the reviewed archive identity', () => {
  const request = { version: 1, reviewId: point, archiveSha256: 'a'.repeat(64), contents: defaultSettingsBackupSelection() };
  expect(settingsBackupRestoreSelectionSchema.allows(request)).toBe(true);
  expect(settingsBackupRestoreSelectionSchema.allows({ ...request, archiveSha256: '' })).toBe(false);
  expect(settingsBackupRestoreSelectionSchema.allows({ ...request, confirmedAll: true })).toBe(false);
});

test('only a complete, hash-bound settings job is downloadable-ready and jobs never carry account secrets', () => {
  const queued = {
    version: 1,
    id: point,
    createdAt: 1,
    status: 'queued',
    stage: 'preparing',
    completedBytes: 0,
    totalBytes: null,
    bytes: 0,
    sha256: null,
    selection: defaultSettingsBackupSelection(),
  };
  expect(settingsBackupJobSchema.allows(queued)).toBe(true);
  expect(settingsBackupJobSchema.allows({ ...queued, status: 'ready' })).toBe(false);
  const ready = { ...queued, status: 'ready', stage: 'complete', bytes: 1024, completedBytes: 1024, totalBytes: 1024, sha256: 'a'.repeat(64) };
  expect(settingsBackupJobSchema.allows(ready)).toBe(true);
  expect(settingsBackupJobSchema.allows({ ...ready, totalBytes: 100 })).toBe(false);
  for (const key of ['password', 'passphrase', 'ownerId', 'pointKey'])
    expect(settingsBackupJobSchema.allows({ ...ready, [key]: 'private' })).toBe(false);
});
