import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { capturePercent } from './timeline-state';

const stages: Record<string, { label: string; pose: string }> = {
  queued: { label: 'Waiting to capture', pose: 'waiting' },
  preparing: { label: 'Preparing capture', pose: 'preparing' },
  'saving-preview': { label: 'Saving the Home preview', pose: 'preview' },
  'capturing-core': { label: 'Capturing the server state', pose: 'collecting' },
  'retaining-images': { label: 'Saving Docker images', pose: 'collecting' },
  'copying-files': { label: 'Copying app configuration', pose: 'collecting' },
  'database-dump': { label: 'Saving the database', pose: 'collecting' },
  encrypting: { label: 'Encrypting capture', pose: 'sealing' },
  sealing: { label: 'Verifying capture', pose: 'sealing' },
};

export function capturePresentation(point: TimeMachinePoint, unavailable = false) {
  if (unavailable)
    return { title: 'Time Machine capture', stage: 'Waiting for capture status', pose: 'waiting', active: false, percentage: undefined };
  if (point.status !== 'capturing')
    return {
      title: point.status === 'sealed' ? 'Capture saved' : point.status === 'interrupted' ? 'Capture interrupted' : 'Capture failed',
      stage:
        point.status === 'sealed'
          ? 'The server confirmed this saved point.'
          : (point.issue?.message ?? 'This capture did not finish. Check its status before trying again.'),
      pose: point.status === 'sealed' ? 'saved' : 'stopped',
      active: false,
      percentage: undefined,
    };
  const stage = stages[point.stage];
  return {
    title: 'Time Machine capture',
    stage: stage?.label ?? `Server stage: ${point.stage.replaceAll('-', ' ')}`,
    pose: stage?.pose ?? 'collecting',
    active: point.stage !== 'queued',
    percentage: capturePercent(point.completedBytes, point.totalBytes),
  };
}
