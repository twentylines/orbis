import { readOperationStatus, operationAllowsDeparture } from '@/components/recovery-progress/operation-status';
import { backupRequest } from './backup-api';
import { importJobSchema, importListSchema, type ImportJob } from './contracts';

export async function cancelImportBeforeRestore(
  id: string | null,
  request: typeof backupRequest = backupRequest,
  authority: typeof readOperationStatus = readOperationStatus,
): Promise<ImportJob | null> {
  const read = async () => {
    const value = await request('/imports');
    if (!importListSchema.allows(value) || !value.available) throw new Error('Backup cancellation status could not be checked. Try Cancel again.');
    return value.jobs.find((job) => job.id === id) ?? null;
  };
  let job = await read();
  if (job?.status === 'preparing') throw new Error('The restore may have started. Check its status before leaving.');
  if (job && ['uploading', 'reviewing'].includes(job.status)) {
    const cancelled = await request(`/imports/${job.id}/cancel`, 'POST');
    if (!importJobSchema.allows(cancelled) || cancelled.id !== id) throw new Error('Backup cancellation was not confirmed. Try Cancel again.');
    job = await read();
  }
  if (job && ['uploading', 'reviewing', 'preparing'].includes(job.status))
    throw new Error('Backup preparation is still running. Try Cancel again to check it.');
  if (!operationAllowsDeparture(await authority())) throw new Error('The server has not confirmed that it is ready. Check status before leaving.');
  return job;
}
