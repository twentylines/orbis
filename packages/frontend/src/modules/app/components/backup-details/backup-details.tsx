import { DateFormat } from '@/components/date-format/date-format';
import { FileSize } from '@/components/file-size/file-size';
import type { AppBackup } from '@/types/app.types';
import './backup-details.css';

export const BackupDetails = ({ backup }: { backup: AppBackup }) => (
  <div className="backup-details">
    <code className="backup-filename">{backup.id}</code>
    <div className="backup-metadata">
      <time dateTime={new Date(backup.date).toISOString()}>
        <DateFormat date={new Date(backup.date)} />
      </time>
      <span className="backup-size">
        <FileSize size={backup.size} />
      </span>
    </div>
  </div>
);
