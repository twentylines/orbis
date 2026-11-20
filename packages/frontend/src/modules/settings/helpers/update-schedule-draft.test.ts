import { expect, test } from 'bun:test';
import { automaticSchedulePlan } from './update-schedule-draft';
import type { AutomaticUpdateStatus } from '@/desktop/automatic-updates-api';

const saved: AutomaticUpdateStatus = {
  available: true,
  capabilities: ['independent-schedules.v1'],
  revision: 7,
  settings: { orbis: { enabled: true, mode: 'idle' }, apps: { enabled: false }, schedule: { time: '04:00', timezone: 'UTC' } },
  orbisSchedule: { time: '03:00', timezone: 'UTC' },
};
test('an older backend cannot create an unsupported independent schedule', () => {
  const legacy = { ...saved, capabilities: [], orbisSchedule: undefined };
  expect(() => automaticSchedulePlan('all', legacy, { time: '15:00' })).toThrow('Update Orbis');
});
test('Orbis mode and time edits preserve its acknowledged enablement and the app schedule', () => {
  const plan = automaticSchedulePlan('all', saved, { mode: 'scheduled', time: '15:00' });
  expect(plan.settings.apps).toBeUndefined();
  expect(plan.settings.orbis).toEqual({ enabled: true, mode: 'scheduled' });
  expect(plan.settings.schedule.time).toBe('04:00');
  expect(plan.options).toEqual({ expectedRevision: 7, orbisSchedule: { time: '15:00' } });
});
test('saving an app time preserves the current Orbis mode and leaves the app policy omitted', () => {
  const plan = automaticSchedulePlan('apps', saved, { time: '17:30' });
  expect(plan.settings.orbis).toEqual(saved.settings.orbis);
  expect(plan.settings.apps).toBeUndefined();
  expect(plan.settings.schedule.time).toBe('17:30');
  expect(plan.options).toEqual({ expectedRevision: 7 });
});
test('a mode-only edit leaves the configured time in place and invalid times never produce a save', () => {
  expect(automaticSchedulePlan('all', saved, { mode: 'scheduled' }).options).toEqual({ expectedRevision: 7 });
  for (const time of ['24:00', '03:60', '1500', '3:00', '']) expect(() => automaticSchedulePlan('all', saved, { time })).toThrow('valid update time');
});
