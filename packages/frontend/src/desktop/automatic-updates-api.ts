import { queryOptions } from '@tanstack/react-query';

export type AutomaticUpdateSettings = {
  orbis: { enabled: boolean; mode: 'idle' | 'scheduled' };
  schedule: { time: string; timezone: string };
};
export type UpdateAttempt = { state: string; message?: string; at: number; targetVersion?: number };
export type AutomaticUpdateStatus = {
  settings: AutomaticUpdateSettings;
  pauseReason?: string | null;
  lastAttempt?: UpdateAttempt | null;
  available: boolean;
  reason?: string;
};
export type AppUpdateRule = { mode: 'disabled' | 'global' | 'custom'; time?: string };
export type AppUpdateSchedule = {
  rule: AppUpdateRule;
  shared: { time: string; timezone: string };
  available: boolean;
  reason?: string;
  lastAttempt?: UpdateAttempt | null;
};

async function automaticRequest<T>(suffix = '', body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/host-updates/automatic${suffix}`, {
    method: body === undefined ? 'GET' : 'PUT',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value?.message === 'string' ? value.message : 'The update schedule could not be saved.');
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
export const saveAutomaticUpdateSettings = (settings: AutomaticUpdateSettings) => automaticRequest<AutomaticUpdateStatus>('', settings);
export const saveAppUpdateSchedule = (urn: string, rule: AppUpdateRule) =>
  automaticRequest<AppUpdateSchedule>(`/apps/${encodeURIComponent(urn)}`, rule);
