import { useRestoreRequests } from '@/modules/host-transfer/receiver-request-context';
import { AnimatePresence, motion } from 'framer-motion';
import { IconActivity, IconAlertTriangle } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useReducedMotion } from './motion-preferences';
import { taskIsActive, useTasks } from './tasks';
import {
  clearRecoveredHistoryAcknowledgement,
  criticalUpdateAttentionKey,
  readTaskAcknowledgements,
  saveTaskAcknowledgements,
  mergeTaskAcknowledgements,
  requestTaskAcknowledgements,
  taskAttentionSession,
  taskAttentionKey,
} from './task-attention';
import { installedOrbisBuildOptions, orbisReleasesOptions } from './orbis-release';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import toast from 'react-hot-toast';
import { orbisReleaseChannelsOptions } from './release-channels';

function TaskBadge({ alert, reducedMotion, children }: { alert: boolean; reducedMotion: boolean; children: ReactNode }) {
  return (
    <motion.span
      className="desktop-task-badge desktop-task-count"
      data-alert={alert || undefined}
      aria-hidden="true"
      initial={reducedMotion ? false : { opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6, transition: { duration: reducedMotion ? 0 : 0.18 } }}
      transition={{ duration: reducedMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.span>
  );
}

export function DesktopTaskLink() {
  const tasks = useTasks();
  const { user } = useAppContext();
  const { sessionEpoch, sessionAbortSignal } = useUserContext();
  const queryClient = useQueryClient();
  const session = taskAttentionSession(sessionEpoch);
  const scope = `${user.id}:${session}`;
  const current = useRef({ scope, signal: sessionAbortSignal });
  current.current = { scope, signal: sessionAbortSignal };
  const acknowledgementQueryKey = useMemo(() => ['task-attention', user.id, session], [user.id, session]);
  const saved = useQuery({
    queryKey: acknowledgementQueryKey,
    queryFn: ({ signal }) => requestTaskAcknowledgements(AbortSignal.any([signal, sessionAbortSignal])),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const local = useMemo(() => {
    try {
      return readTaskAcknowledgements(window.localStorage, user.id);
    } catch {
      return [];
    }
  }, [user.id]);
  const [acknowledged, setAcknowledged] = useState({ scope, keys: local });
  const pending = useRef(new Set<string>());
  const pendingRequests = useRestoreRequests()?.pendingCount ?? 0;
  const location = useLocation();
  const reducedMotion = Boolean(useReducedMotion());
  // Observe the header's existing update queries without starting another request or polling loop.
  const channels = useQuery({ ...orbisReleaseChannelsOptions(), enabled: false });
  const build = useQuery({ ...installedOrbisBuildOptions(), enabled: false });
  const releases = useQuery({ ...orbisReleasesOptions(channels.data?.current), enabled: false });
  const criticalKey = criticalUpdateAttentionKey(
    channels.data && !channels.isError && !releases.isError ? releases.data?.[0] : undefined,
    build.data?.version,
  );
  const keys = useMemo(
    () => [
      ...(tasks.data?.tasks.flatMap((task) => {
        const key = taskAttentionKey(task);
        return key ? [key] : [];
      }) ?? []),
      ...(tasks.isError ? ['history-unavailable'] : []),
      ...(criticalKey ? [criticalKey] : []),
    ],
    [tasks.data?.tasks, tasks.isError, criticalKey],
  );
  const signature = keys.join('\n');
  const acknowledge = useCallback(() => {
    if (!keys.length || sessionAbortSignal.aborted) return;
    const observedScope = scope;
    const isCurrent = () => current.current.scope === observedScope && !sessionAbortSignal.aborted;
    setAcknowledged((previous) => {
      try {
        const merged = mergeTaskAcknowledgements(previous.scope === scope ? previous.keys : local, keys);
        return previous.scope === scope && merged.join('\n') === previous.keys.join('\n') ? previous : { scope, keys: merged };
      } catch {
        return previous;
      }
    });
    const extras = keys.filter((key) => key.startsWith('critical:') || key === 'history-unavailable');
    if (extras.length) {
      try {
        if (!saveTaskAcknowledgements(extras, window.localStorage, user.id)) throw new Error();
      } catch {
        toast.error('Update alert acknowledgements could not be saved on this browser.', { id: 'task-attention-storage' });
      }
    }
    const canonical = new Set(saved.data?.keys ?? []);
    const taskKeys = keys.filter((key) => !extras.includes(key) && !canonical.has(key));
    const requestKey = `${scope}:${taskKeys.join('\n')}`;
    if (!taskKeys.length || pending.current.has(requestKey)) return;
    pending.current.add(requestKey);
    void requestTaskAcknowledgements(sessionAbortSignal, taskKeys)
      .then((value) => {
        if (isCurrent()) queryClient.setQueryData(acknowledgementQueryKey, value);
      })
      .catch(() => {
        if (isCurrent()) toast.error('Task alerts could not be saved. Open Tasks and try again.', { id: 'task-attention-save' });
      })
      .finally(() => {
        pending.current.delete(requestKey);
      });
  }, [keys, scope, local, sessionAbortSignal, user.id, queryClient, acknowledgementQueryKey, saved.data]);
  useEffect(() => {
    if (location.pathname === '/tasks' && signature && saved.data) acknowledge();
  }, [location.pathname, signature, acknowledge, saved.data]);
  useEffect(() => {
    if (!tasks.isSuccess || !tasks.isFetchedAfterMount || sessionAbortSignal.aborted) return;
    setAcknowledged((previous) => {
      const keys = previous.scope === scope ? previous.keys : local;
      return previous.scope === scope && !keys.includes('history-unavailable')
        ? previous
        : { scope, keys: keys.filter((key) => key !== 'history-unavailable') };
    });
    try {
      clearRecoveredHistoryAcknowledgement(window.localStorage, user.id);
    } catch {
      /* Browser storage can be unavailable; task acknowledgements remain on the server. */
    }
  }, [tasks.isSuccess, tasks.isFetchedAfterMount, sessionAbortSignal, scope, local, user.id]);
  const seen = new Set([...(saved.data?.keys ?? []), ...(acknowledged.scope === scope ? acknowledged.keys : local)]);
  const attentionKnown = saved.isSuccess && saved.data !== undefined;
  const attentionState = saved.isError ? 'unavailable' : attentionKnown ? 'ready' : 'loading';
  const attentionStatus = saved.isError ? 'saved task alerts unavailable; open Tasks to retry' : attentionKnown ? null : 'checking saved task alerts';
  const alerts =
    location.pathname === '/tasks'
      ? 0
      : keys.filter((key) => !seen.has(key) && (attentionKnown || key.startsWith('critical:') || key === 'history-unavailable')).length;
  const activeTasks = tasks.data?.tasks.filter(taskIsActive).length ?? 0;
  const count = activeTasks + pendingRequests || alerts;
  return (
    <Link
      to="/tasks"
      className="desktop-task-trigger"
      onClick={() => {
        if (saved.isError) void saved.refetch();
        acknowledge();
      }}
      data-attention-state={attentionState}
      aria-busy={attentionState === 'loading' || undefined}
      aria-label={`Open task centre, ${activeTasks} active operation${activeTasks === 1 ? '' : 's'}${pendingRequests ? `, ${pendingRequests} pending restore request${pendingRequests === 1 ? '' : 's'}` : ''}${alerts ? `, ${alerts} new alert${alerts === 1 ? '' : 's'}` : ''}${attentionStatus ? `, ${attentionStatus}` : ''}`}
      title={attentionStatus ? `Task centre · ${attentionStatus}` : alerts ? 'Task centre · new alerts' : 'Task centre'}
    >
      {saved.isError ? (
        <IconAlertTriangle size={20} style={{ color: 'var(--desktop-warning)' }} aria-hidden="true" />
      ) : (
        <IconActivity size={20} aria-hidden="true" />
      )}
      <AnimatePresence initial={false}>
        {count > 0 ? (
          <TaskBadge key="activity" alert={alerts > 0} reducedMotion={reducedMotion}>
            {count}
          </TaskBadge>
        ) : null}
      </AnimatePresence>
    </Link>
  );
}
