import type { TaskPhase, TaskRecord } from '@runtipi/common/schemas/task-history';

const phases: Record<TaskPhase, string> = {
  preparing: 'Preparing update',
  pulling_images: 'Downloading images',
  stopping: 'Stopping application',
  backing_up: 'Saving backup',
  publishing: 'Applying update',
  starting: 'Starting application',
  verifying: 'Verifying application',
  committing: 'Finishing update',
  recovering: 'Restoring previous deployment',
};

export const taskProgressLabel = (task: TaskRecord) => (task.status === 'running' && task.phase ? phases[task.phase] : undefined);
