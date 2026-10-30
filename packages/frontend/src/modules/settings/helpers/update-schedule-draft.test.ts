import { expect, test } from 'bun:test';
import { automaticScheduleDirty, automaticSchedulePlan } from './update-schedule-draft';
import type { AutomaticUpdateStatus } from '@/desktop/automatic-updates-api';

const saved: AutomaticUpdateStatus = {
  available: true,
  capabilities: ['independent-schedules.v1'],
  revision: 7,
  settings: { orbis: { enabled: true, mode: 'idle' }, apps: { enabled: false }, schedule: { time: '04:00', timezone: 'UTC' } },
  orbisSchedule: { time: '03:00', timezone: 'UTC' },
};
test('an older backend never manufactures unsaved changes or independent scheduling support', () => {
  const legacy = { ...saved, capabilities: [], orbisSchedule: undefined };
  expect(automaticScheduleDirty('all', legacy, legacy.settings, null)).toBe(false);
  expect(() => automaticSchedulePlan('all', legacy, legacy.settings, '15:00')).toThrow('Update Orbis');
});
test('saving Core changes cannot overwrite app enablement or the app schedule', () => {
  const oldDraft = { ...saved.settings, apps: { enabled: true }, schedule: { time: '08:00', timezone: 'UTC' } };
  const plan = automaticSchedulePlan('all', saved, oldDraft, '15:00');
  expect(plan.settings.apps).toEqual({ enabled: false });
  expect(plan.settings.schedule.time).toBe('04:00');
  expect(plan.options).toEqual({ expectedRevision: 7, orbisSchedule: { time: '15:00' } });
});
test('saving app changes preserves the current Core mode and uses a distinct scheduled time', () => {
  const draft = { ...saved.settings, orbis: { enabled: false, mode: 'scheduled' as const }, apps: { enabled: true } };
  const plan = automaticSchedulePlan('apps', saved, draft, '17:30');
  expect(plan.settings.orbis).toEqual(saved.settings.orbis);
  expect(plan.settings.schedule.time).toBe('17:30');
  expect(plan.options).toEqual({ expectedRevision: 7 });
});
test('other scope changes do not create dirty fields and invalid times never produce a save', () => {
  const draft = { ...saved.settings, apps: { enabled: true } };
  expect(automaticScheduleDirty('all', saved, draft, '03:00')).toBe(false);
  expect(automaticScheduleDirty('apps', saved, draft, '04:00')).toBe(true);
  for (const time of ['24:00', '03:60', '1500', '3:00', ''])
    expect(() => automaticSchedulePlan('all', saved, draft, time)).toThrow('valid update time');
});
