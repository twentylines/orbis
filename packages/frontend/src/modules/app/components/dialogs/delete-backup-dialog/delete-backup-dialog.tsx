import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import type { AppBackup } from '@/types/app.types';
import { IconAlertTriangle } from '@tabler/icons-react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { BackupDetails } from '../../backup-details/backup-details';

interface IProps {
  backup?: AppBackup | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export const DeleteAppBackupDialog: React.FC<IProps> = ({ backup, isOpen, onClose, onConfirm }) => {
  const { t } = useTranslation();

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent type="danger" size="md" className="backup-dialog">
        <DialogHeader>
          <DialogTitle>{t('DELETE_BACKUP_MODAL_TITLE')}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <div className="backup-dialog-warning">
            <IconAlertTriangle className="icon text-danger" aria-hidden="true" />
            <p>{t('DELETE_BACKUP_MODAL_SUBTITLE')}</p>
          </div>
          {backup ? <BackupDetails backup={backup} /> : null}
        </DialogDescription>
        <DialogFooter>
          <Button onClick={onConfirm} intent="danger">
            {t('DELETE_BACKUP_MODAL_SUBMIT')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
