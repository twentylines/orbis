import { taskHistorySchema, type TaskRecord } from '@runtipi/common/schemas';
import { type } from 'arktype';
import { useQuery } from '@tanstack/react-query';

export const taskLabels: Record<TaskRecord['action'], string> = {
  start: 'Start',
  stop: 'Stop',
  install: 'Install',
  uninstall: 'Uninstall',
  reset: 'Reset',
  restart: 'Restart',
  generate_env: 'Configure',
  backup: 'Backup',
  restore: 'Restore',
  update: 'Update',
};
export const taskStates: Record<TaskRecord['status'], string> = {
  queued: 'Queued',
  running: 'In progress',
  succeeded: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  unconfirmed: 'Awaiting confirmation',
};
export const taskIsActive = (task: TaskRecord) => task.status === 'queued' || task.status === 'running';
export const useTasks = () =>
  useQuery({
    queryKey: ['tasks'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/tasks', { credentials: 'include', signal });
      if (!response.ok) throw new Error('Task history is unavailable');
      const parsed = taskHistorySchema(await response.json());
      if (parsed instanceof type.errors) throw new Error('Task history returned an invalid response');
      return parsed;
    },
    refetchInterval: 5000,
    staleTime: 4000,
    refetchIntervalInBackground: false,
  });
