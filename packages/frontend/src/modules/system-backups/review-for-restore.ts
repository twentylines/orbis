import { backupRequest, type BackupCredentials } from './backup-api';
import { canRestore, importListSchema, type ImportJob } from './contracts';

export async function reviewForRestore(
  id: string,
  passphrase: string,
  signal: AbortSignal,
  request: typeof backupRequest = backupRequest,
): Promise<ImportJob> {
  await request(`/imports/${id}/review`, 'POST', { passphrase }, signal);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await request('/imports', 'GET', undefined, signal);
    if (!importListSchema.allows(result) || !result.available) throw new Error('Backup verification status is unavailable.');
    const job = result.jobs.find((item) => item.id === id);
    if (!job) throw new Error('The uploaded backup is no longer available.');
    if (job.status === 'reviewed') {
      if (!canRestore(job, Date.now()) || !job.review) throw new Error('This backup cannot be restored on this server.');
      return job;
    }
    if (job.status !== 'reviewing') throw new Error('The backup could not be verified. Check its password and file.');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 1000);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  throw new Error('Backup verification is taking too long. Refresh its status before trying again.');
}

export async function restoreAfterReview(
  id: string,
  passphrase: string,
  credentials: BackupCredentials,
  signal: AbortSignal,
  request: typeof backupRequest = backupRequest,
  onSubmit?: () => void,
) {
  const reviewed = await reviewForRestore(id, passphrase, signal, request);
  if (!reviewed.review || !canRestore(reviewed, Date.now())) throw new Error('Verify this backup again before restoring.');
  signal.throwIfAborted();
  onSubmit?.();
  return request(
    '/restores',
    'POST',
    {
      ...(credentials.password ? credentials : {}),
      importId: reviewed.id,
      manifestSha256: reviewed.review.manifestSha256,
      confirmation: 'replace-server',
    },
    signal,
  );
}
