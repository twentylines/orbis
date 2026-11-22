import type { TaskPhase, TaskRecord } from '@runtipi/common/schemas/task-history';

const phases: Record<TaskPhase, string> = {
  preparing: 'Preparing update',
  pulling_images: 'Downloading images',
  stopping: 'Stopping application',
  backing_up: 'Saving backup',
  copying: 'Copying application data',
  archiving: 'Compressing backup',
  saving: 'Saving completed backup',
  migrating: 'Upgrading application data',
  publishing: 'Applying update',
  starting: 'Starting application',
  verifying: 'Verifying application',
  committing: 'Finishing update',
  recovering: 'Restoring previous deployment',
};

export const taskProgressLabel = (task: Pick<TaskRecord, 'status' | 'phase' | 'action'>) => {
  if (task.status === 'cancelling') return 'Cancelling · restoring application state';
  if (task.status !== 'running' || !task.phase) return undefined;
  if (task.action === 'install') {
    if (task.phase === 'preparing') return 'Preparing installation';
    if (task.phase === 'publishing') return 'Installing application';
    if (task.phase === 'committing') return 'Finishing installation';
  }
  if (task.action === 'backup') {
    if (task.phase === 'preparing') return 'Preparing backup';
    if (task.phase === 'committing') return 'Finishing backup';
  }
  if (task.action === 'backup' && (task.phase === 'starting' || task.phase === 'recovering')) return 'Restoring application state';
  return phases[task.phase];
};
