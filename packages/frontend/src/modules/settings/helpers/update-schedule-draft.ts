import { hasIndependentUpdateSchedules, type AutomaticUpdateSettings, type AutomaticUpdateStatus } from '@/desktop/automatic-updates-api';

export type AutomaticScheduleEdit = { mode?: AutomaticUpdateSettings['orbis']['mode']; time?: string };

export function automaticSchedulePlan(mode: 'all' | 'apps', latest: AutomaticUpdateStatus, edit: AutomaticScheduleEdit) {
  if (!hasIndependentUpdateSchedules(latest)) throw new Error('Update Orbis to configure separate update schedules.');
  if (edit.time !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(edit.time)) throw new Error('Enter a valid update time.');
  return {
    settings: {
      ...latest.settings,
      apps: undefined,
      orbis: mode === 'all' && edit.mode ? { ...latest.settings.orbis, mode: edit.mode } : latest.settings.orbis,
      schedule: mode === 'apps' && edit.time ? { ...latest.settings.schedule, time: edit.time } : latest.settings.schedule,
    },
    options: { expectedRevision: latest.revision, ...(mode === 'all' && edit.time ? { orbisSchedule: { time: edit.time } } : {}) },
  };
}
