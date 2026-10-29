import { BackupApiError } from './backup-api';
import type { BackupSnapshot } from './contracts';

function acceptedRestoreSnapshot(data: BackupSnapshot | undefined) {
  const status = data?.restore.job?.status;
  return status === 'ready' || status === 'running';
}

export function shouldStopBackupStatusPolling(error: unknown, data: BackupSnapshot | undefined) {
  if (!(error instanceof BackupApiError)) return false;
  if ([401, 403].includes(error.status)) return true;
  return error.status === 404 && !acceptedRestoreSnapshot(data);
}

export function isAcceptedRestoreReconnect(error: unknown, restoreStatus: string | undefined, wasAccepted: boolean) {
  if (!wasAccepted || !['ready', 'running'].includes(restoreStatus ?? '')) return false;
  if (error instanceof BackupApiError) return error.status === 0 || error.status === 404 || error.status >= 500;
  return error instanceof TypeError || (error instanceof Error && error.name === 'NetworkError');
}
