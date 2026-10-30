import { useRestoreRequests } from '@/modules/host-transfer/receiver-request-context';
import { AnimatePresence, motion } from 'framer-motion';
import { IconActivity } from '@tabler/icons-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useReducedMotion } from './motion-preferences';
import { taskIsActive, useTasks } from './tasks';
import { criticalUpdateAttentionKey, readTaskAcknowledgements, taskAttentionKey, taskAttentionStorageKey } from './task-attention';
import { installedOrbisBuildOptions, orbisReleasesOptions } from './orbis-release';
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
  const [acknowledged, setAcknowledged] = useState(() => {
    try {
      return readTaskAcknowledgements(window.sessionStorage);
    } catch {
      return [];
    }
  });
  const keys = useMemo(
    () => [
      ...(tasks.data?.tasks.flatMap((task) => {
        const key = taskAttentionKey(task);
        return key ? [key] : [];
      }) ?? []),
      ...(tasks.isError ? [`history:${tasks.dataUpdatedAt}`] : []),
      ...(criticalKey ? [criticalKey] : []),
    ],
    [tasks.data?.tasks, tasks.isError, tasks.dataUpdatedAt, criticalKey],
  );
  const signature = keys.join('\n');
  const acknowledge = () => {
    setAcknowledged(keys);
    try {
      window.sessionStorage.setItem(taskAttentionStorageKey, JSON.stringify(keys));
    } catch {
      /* Keep acknowledgement for this mounted session. */
    }
  };
  useEffect(() => {
    if (location.pathname !== '/tasks') return;
    const current = signature ? signature.split('\n') : [];
    setAcknowledged((previous) => (previous.join('\n') === signature ? previous : current));
    try {
      window.sessionStorage.setItem(taskAttentionStorageKey, JSON.stringify(current));
    } catch {
      /* Storage may be disabled. */
    }
  }, [location.pathname, signature]);
  const seen = new Set(acknowledged);
  const alerts = location.pathname === '/tasks' ? 0 : keys.filter((key) => !seen.has(key)).length;
  const activeTasks = tasks.data?.tasks.filter(taskIsActive).length ?? 0;
  const count = activeTasks + pendingRequests || alerts;
  return (
    <Link
      to="/tasks"
      className="desktop-task-trigger"
      onClick={acknowledge}
      aria-label={`Open task centre, ${activeTasks} active operation${activeTasks === 1 ? '' : 's'}${pendingRequests ? `, ${pendingRequests} pending restore request${pendingRequests === 1 ? '' : 's'}` : ''}${alerts ? `, ${alerts} new alert${alerts === 1 ? '' : 's'}` : ''}`}
      title={alerts ? 'Task centre · new alerts' : 'Task centre'}
    >
      <IconActivity size={20} aria-hidden="true" />
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
