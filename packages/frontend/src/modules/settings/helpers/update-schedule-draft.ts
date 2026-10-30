import { hasIndependentUpdateSchedules, type AutomaticUpdateSettings, type AutomaticUpdateStatus } from '@/desktop/automatic-updates-api';

export function automaticScheduleDirty(
  mode: 'all' | 'apps',
  saved: AutomaticUpdateStatus | undefined,
  draft: AutomaticUpdateSettings | undefined,
  time: string | null,
) {
  if (!saved || !draft || !hasIndependentUpdateSchedules(saved)) return false;
  const savedTime = mode === 'apps' ? saved.settings.schedule.time : saved.orbisSchedule?.time;
  return (
    time !== (savedTime ?? null) ||
    (mode === 'apps'
      ? (draft.apps?.enabled ?? false) !== (saved.settings.apps?.enabled ?? false)
      : draft.orbis.enabled !== saved.settings.orbis.enabled || draft.orbis.mode !== saved.settings.orbis.mode)
  );
}

export function automaticSchedulePlan(mode: 'all' | 'apps', latest: AutomaticUpdateStatus, draft: AutomaticUpdateSettings, time: string) {
  if (!hasIndependentUpdateSchedules(latest)) throw new Error('Update Orbis to configure separate update schedules.');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Enter a valid update time.');
  return {
    settings:
      mode === 'apps'
        ? { ...latest.settings, apps: draft.apps, schedule: { ...latest.settings.schedule, time } }
        : { ...latest.settings, orbis: draft.orbis },
    options: { expectedRevision: latest.revision, ...(mode === 'all' ? { orbisSchedule: { time } } : {}) },
  };
}
