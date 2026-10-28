import { AnimatePresence, motion } from 'framer-motion';
import { IconActivity } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useReducedMotion } from './motion-preferences';
import { taskIsActive, useTasks } from './tasks';
import { readTaskAcknowledgements, taskAttentionKey, taskAttentionStorageKey } from './task-attention';

export function DesktopTaskLink() {
  const tasks = useTasks();
  const location = useLocation();
  const reducedMotion = useReducedMotion();
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
    ],
    [tasks.data?.tasks, tasks.isError, tasks.dataUpdatedAt],
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
  return (
    <Link
      to="/tasks"
      className="desktop-task-trigger"
      onClick={acknowledge}
      aria-label={`Open task centre, ${activeTasks} active operation${activeTasks === 1 ? '' : 's'}${alerts ? `, ${alerts} new alert${alerts === 1 ? '' : 's'}` : ''}`}
      title={alerts ? 'Task centre · new alerts' : 'Task centre'}
    >
      <IconActivity size={20} aria-hidden="true" />
      {activeTasks > 0 ? (
        <span className="desktop-task-badge desktop-task-count" aria-hidden="true">
          {activeTasks}
        </span>
      ) : null}
      <AnimatePresence initial={false}>
        {alerts ? (
          <motion.span
            key="attention"
            className="desktop-task-badge desktop-task-alert"
            aria-hidden="true"
            initial={reducedMotion ? false : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6, transition: { duration: reducedMotion ? 0 : 0.18 } }}
            transition={{ duration: reducedMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            !
          </motion.span>
        ) : null}
      </AnimatePresence>
    </Link>
  );
}
