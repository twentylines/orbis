import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import type { AppBackup } from '@/types/app.types';
import { IconAlertTriangle } from '@tabler/icons-react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { BackupDetails } from '../../backup-details/backup-details';

interface IProps {
  backup?: AppBackup | null;
  appName: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export const RestoreAppDialog: React.FC<IProps> = ({ appName, backup, isOpen, onClose, onConfirm }) => {
  const { t } = useTranslation();

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent size="md" className="backup-dialog">
        <DialogHeader>
          <DialogTitle>{t('APP_RESTORE_TITLE', { name: appName })}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <div className="backup-dialog-warning">
            <IconAlertTriangle className="icon text-warning" aria-hidden="true" />
            <p>{t('APP_RESTORE_SUBTITLE')}</p>
          </div>
          {backup ? <BackupDetails backup={backup} /> : null}
        </DialogDescription>
        <DialogFooter>
          <Button onClick={onConfirm} intent="warning">
            {t('APP_RESTORE_SUBMIT')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
