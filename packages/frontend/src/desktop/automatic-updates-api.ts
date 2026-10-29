import { queryOptions } from '@tanstack/react-query';

export type AutomaticUpdateSettings = {
  orbis: { enabled: boolean; mode: 'idle' | 'scheduled' };
  apps?: { enabled: boolean };
  schedule: { time: string; timezone: string };
};
export type UpdateAttempt = { state: string; message?: string; at: number; targetVersion?: number };
export type AutomaticUpdateServerTime = { now: number; timezone: string };
export type AutomaticUpdateStatus = {
  settings: AutomaticUpdateSettings;
  appRules?: Record<string, AppUpdateRule>;
  pauseReason?: string | null;
  lastAttempt?: UpdateAttempt | null;
  available: boolean;
  reason?: string;
  serverTime?: AutomaticUpdateServerTime;
};
export type AppUpdateRule = { mode: 'disabled' | 'global' | 'custom'; time?: string };
export type AppUpdateSchedule = {
  rule: AppUpdateRule;
  shared: { time: string; timezone: string };
  available: boolean;
  reason?: string;
  lastAttempt?: UpdateAttempt | null;
  serverTime?: AutomaticUpdateServerTime;
};
export type SystemUpdateSchedule = Omit<AppUpdateSchedule, 'rule'> & { settings: { enabled: boolean }; pauseReason?: string | null };

function validServerTime(value: unknown): value is AutomaticUpdateServerTime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const clock = value as Record<string, unknown>;
  if (
    Object.keys(clock).length !== 2 ||
    !Number.isSafeInteger(clock.now) ||
    typeof clock.now !== 'number' ||
    clock.now < 0 ||
    clock.now > 8_640_000_000_000_000 ||
    typeof clock.timezone !== 'string' ||
    !clock.timezone ||
    clock.timezone.length > 100
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: clock.timezone }).format(clock.now);
    return true;
  } catch {
    return false;
  }
}

export function formatAutomaticUpdateServerTime(value: AutomaticUpdateServerTime, elapsed = 0) {
  if (!validServerTime(value) || !Number.isFinite(elapsed) || elapsed < 0 || value.now + elapsed > 8_640_000_000_000_000) return null;
  return new Intl.DateTimeFormat(undefined, { timeZone: value.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    value.now + elapsed,
  );
}

async function automaticRequest<T>(suffix = '', body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/host-updates/automatic${suffix}`, {
    method: body === undefined ? 'GET' : 'PUT',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof value?.message === 'string'
        ? value.message
        : body === undefined
          ? 'Update preferences could not be read. Try again.'
          : 'The update schedule could not be saved. Try again.',
    );
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Update preferences could not be read. Try again.');
  if (value.serverTime !== undefined && !validServerTime(value.serverTime)) throw new Error('The server time could not be read safely. Try again.');
  return value as T;
}
const scheduleQuery = { staleTime: 60_000, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false } as const;
export const automaticUpdateSettingsOptions = () =>
  queryOptions({
    queryKey: ['orbis-automatic-updates'],
    queryFn: ({ signal }) => automaticRequest<AutomaticUpdateStatus>('', undefined, signal),
    ...scheduleQuery,
  });
export const appUpdateScheduleOptions = (urn: string) =>
  queryOptions({
    queryKey: ['orbis-app-update-schedule', urn],
    queryFn: ({ signal }) => automaticRequest<AppUpdateSchedule>(`/apps/${encodeURIComponent(urn)}`, undefined, signal),
    ...scheduleQuery,
  });
export const readAppUpdateSchedule = (urn: string) => automaticRequest<AppUpdateSchedule>(`/apps/${encodeURIComponent(urn)}`);
export const saveAutomaticUpdateSettings = (settings: AutomaticUpdateSettings) =>
  automaticRequest<AutomaticUpdateStatus>('', {
    orbis: settings.orbis,
    ...(settings.apps ? { apps: settings.apps } : {}),
    schedule: { time: settings.schedule.time },
  });
export const saveAppUpdateSchedule = (urn: string, rule: AppUpdateRule) =>
  automaticRequest<AppUpdateSchedule>(`/apps/${encodeURIComponent(urn)}`, rule);
export const systemUpdateScheduleOptions = () =>
  queryOptions({
    queryKey: ['orbis-system-update-schedule'],
    queryFn: ({ signal }) => automaticRequest<SystemUpdateSchedule>('/system', undefined, signal),
    ...scheduleQuery,
  });
export const saveSystemUpdateSchedule = (settings: { enabled: boolean }) => automaticRequest<SystemUpdateSchedule>('/system', settings);
