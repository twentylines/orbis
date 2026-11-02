import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { capturePercent } from './timeline-state';

const captureStages: Record<string, string> = {
  queued: 'Waiting to capture',
  preparing: 'Preparing capture',
  'retaining-images': 'Saving Docker images',
  'copying-files': 'Copying app configuration',
  'database-dump': 'Saving the database',
  encrypting: 'Encrypting capture',
  sealing: 'Verifying capture',
};

export function timeMachineActivity(point: TimeMachinePoint | undefined) {
  if (!point || point.status !== 'capturing') return null;
  return {
    id: point.id,
    title: 'Capturing',
    detail: 'Time Machine',
    stage: captureStages[point.stage] ?? 'Saving the server state',
    percentage: capturePercent(point.completedBytes, point.totalBytes),
  };
}
