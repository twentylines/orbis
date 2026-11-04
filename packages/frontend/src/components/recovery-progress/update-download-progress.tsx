import { readDownloadProgress } from '@/desktop/download-progress';
import { formatBackupBytes } from '@/modules/system-backups/contracts';
import { RecoveryProgressBar } from './recovery-progress';

export function UpdateDownloadProgress({ value }: { value: unknown }) {
  const download = readDownloadProgress(value);
  if (!download) return null;
  const complete = download.phase === 'complete';
  const percentage = complete
    ? 100
    : download.phase === 'extracting'
      ? undefined
      : download.totalBytes
        ? (download.currentBytes / download.totalBytes) * 100
        : undefined;
  const label = complete ? 'Download complete' : download.phase === 'extracting' ? 'Unpacking update' : 'Downloading update';
  return (
    <div className="recovery-progress update-download-progress" aria-live="polite">
      <div className="recovery-progress-heading">
        <span>{label}</span>
        {percentage !== undefined ? <span>{Math.floor(percentage)}%</span> : null}
      </div>
      <RecoveryProgressBar label={label} percentage={percentage} />
      <small>
        {download.alreadyCached
          ? 'Update files are already downloaded.'
          : download.totalBytes === null
            ? `${formatBackupBytes(download.currentBytes)} downloaded`
            : `${formatBackupBytes(download.currentBytes)} of ${formatBackupBytes(download.totalBytes)}`}
      </small>
    </div>
  );
}
