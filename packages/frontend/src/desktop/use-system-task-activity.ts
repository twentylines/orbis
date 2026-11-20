import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { readSettingsExports, readSettingsImports, readSettingsRestore, SettingsBundleApiError } from '@/modules/system-backups/settings-bundle-api';
import { readTimeMachinePoints } from '@/modules/time-machine/time-machine-api';
import { useWindowVisible } from './window-visibility';
import { useHostUpdateWatch } from './host-update-watch';
import { resolveSettingsSection } from '@/modules/settings/helpers/settings-catalogue';
import {
  settingsExportActive,
  settingsImportActive,
  systemActivityRecords,
  systemActivityPollInterval,
  type ActivitySourceIssue,
  type SystemActivitySnapshot,
} from './system-task-activity';

export function systemActivityReadIssue(label: string, error: unknown) {
  const status = error instanceof SettingsBundleApiError ? error.status : null;
  return status === 404
    ? `${label} is not supported by this server.`
    : status === 401 || status === 403
      ? `${label} is not authorized for this session.`
      : `${label} could not be refreshed. Its current state is unknown.`;
}

export function systemActivityPollingOwner(surface: 'popup' | 'page', pathname: string, search = '') {
  const params = new URLSearchParams(search);
  const scopedApp = params.get('app');
  const pageOwns = pathname === '/tasks' && !(scopedApp && scopedApp.length <= 180 && /^[^:]+:[^:]+$/.test(scopedApp));
  const backupManagerOwns = pathname === '/settings' && resolveSettingsSection(params.get('tab')) === 'backups';
  return !backupManagerOwns && (surface === 'page' || !pageOwns);
}

export function useSystemTaskActivity(open: boolean, surface: 'popup' | 'page' = 'popup'): SystemActivitySnapshot {
  const queryClient = useQueryClient();
  const { user } = useAppContext();
  const { sessionAbortSignal } = useUserContext();
  const visible = useWindowVisible();
  const location = useLocation();
  const enabled = open && visible && user.operator === true && !sessionAbortSignal.aborted;
  const poll = enabled && systemActivityPollingOwner(surface, location.pathname, location.search);
  const key = ['orbis-settings-bundles', user.id];
  const exports = useQuery({
    queryKey: [...key, 'exports'],
    queryFn: ({ signal }) => readSettingsExports(AbortSignal.any([signal, sessionAbortSignal])),
    enabled,
    retry: false,
    staleTime: 1500,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      systemActivityPollInterval(poll, Boolean(query.state.error), Boolean(query.state.data?.jobs.some(settingsExportActive))),
  });
  const imports = useQuery({
    queryKey: [...key, 'imports'],
    queryFn: ({ signal }) => readSettingsImports(AbortSignal.any([signal, sessionAbortSignal])),
    enabled,
    retry: false,
    staleTime: 1500,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      systemActivityPollInterval(
        poll,
        Boolean(query.state.error),
        Boolean(query.state.data?.available && query.state.data.jobs.some(settingsImportActive)),
      ),
  });
  const restore = useQuery({
    queryKey: [...key, 'restore'],
    queryFn: ({ signal }) => readSettingsRestore(AbortSignal.any([signal, sessionAbortSignal])),
    enabled,
    retry: false,
    staleTime: 1500,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => systemActivityPollInterval(poll, Boolean(query.state.error), query.state.data?.job?.status === 'running'),
  });
  const points = useQuery({
    queryKey: ['time-machine-points', user.id],
    queryFn: ({ signal }) => readTimeMachinePoints(AbortSignal.any([signal, sessionAbortSignal])),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
  const host = useHostUpdateWatch();
  if (user.operator !== true || sessionAbortSignal.aborted)
    return {
      records: [],
      notices: [{ message: 'System activity is restricted to an authorized operator session.' }],
      loading: false,
      incomplete: true,
    };
  const notices: ActivitySourceIssue[] = [];
  const retryRead = (refetch: (options: { cancelRefetch: boolean }) => unknown) => () => {
    if (enabled && !sessionAbortSignal.aborted) return refetch({ cancelRefetch: false });
  };
  for (const [label, query] of [
    ['Settings backups', exports],
    ['Settings imports', imports],
    ['Settings restore', restore],
  ] as const) {
    if (query.isError) {
      const unsupported = query.error instanceof SettingsBundleApiError && [401, 403, 404].includes(query.error.status);
      notices.push({ message: systemActivityReadIssue(label, query.error), retry: unsupported ? undefined : retryRead(query.refetch) });
    }
  }
  if (imports.data?.available === false && !imports.isError) {
    notices.push({ message: 'Settings imports are unavailable on this server.', retry: retryRead(imports.refetch) });
  }
  const updateStatusUnavailable = host.unavailable || host.core?.available === false;
  if (updateStatusUnavailable) {
    notices.push({
      message: 'Orbis update status is unavailable. Any shown update is the last reported state.',
      retry: () => {
        if (enabled && !sessionAbortSignal.aborted)
          return queryClient.refetchQueries({ queryKey: ['orbis-host-update-status'], exact: true, type: 'active' }, { cancelRefetch: false });
      },
    });
  }
  if (points.isError || (points.data && !points.data.available)) {
    notices.push({ message: 'Saved-point history could not be refreshed. Open Time Machine to check it.', retry: retryRead(points.refetch) });
  }
  const records = systemActivityRecords({
    exports: exports.data?.jobs,
    imports: imports.data?.available === false ? undefined : imports.data?.jobs,
    restore: restore.data?.job,
    core: host.core,
    coreStale: updateStatusUnavailable,
    points: points.data,
  });
  return {
    records: records.map((record) => ({
      ...record,
      stale:
        record.stale ||
        (record.feed === 'exports'
          ? exports.isError
          : record.feed === 'imports'
            ? imports.isError
            : record.feed === 'restore'
              ? restore.isError
              : record.feed === 'points'
                ? points.isError
                : false),
    })),
    notices,
    loading: enabled && (exports.isPending || imports.isPending || restore.isPending || points.isPending || (!host.core && !host.unavailable)),
    incomplete: notices.length > 0 || (!host.core && !enabled),
  };
}
