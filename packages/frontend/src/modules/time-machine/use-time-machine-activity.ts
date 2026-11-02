import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { taskAttentionSession } from '@/desktop/task-attention';
import { useWindowVisible } from '@/desktop/window-visibility';
import { readTimeMachineActivity, TimeMachineApiError } from './time-machine-api';
import { timeMachineActivity } from './time-machine-activity';

export function useTimeMachineActivity() {
  const { user } = useAppContext();
  const { sessionEpoch, sessionAbortSignal } = useUserContext();
  const visible = useWindowVisible();
  const points = useQuery({
    queryKey: ['time-machine-activity', user.id, taskAttentionSession(sessionEpoch)],
    enabled: visible && user.operator === true && !sessionAbortSignal.aborted,
    queryFn: ({ signal }) => readTimeMachineActivity(AbortSignal.any([signal, sessionAbortSignal])),
    refetchInterval: (query) => (query.state.data?.point ? 2500 : 30_000),
    refetchIntervalInBackground: false,
    staleTime: 2500,
    retry: false,
  });
  const activity = timeMachineActivity(points.data?.point ?? undefined);
  const expired = points.error instanceof TimeMachineApiError && [401, 403].includes(points.error.status);
  return {
    ...points,
    activity: expired
      ? null
      : points.isError && activity
        ? { ...activity, title: 'Connecting', stage: 'Waiting for capture status', percentage: undefined }
        : activity,
  };
}
