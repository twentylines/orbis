import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import type React from 'react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './upload-backup-dialog.css';

interface IProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (file: File) => void;
}

export const UploadBackupDialog: React.FC<IProps> = ({ isOpen, onClose, onConfirm }) => {
  const { t } = useTranslation();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.name.endsWith('.tar.gz')) {
        setSelectedFile(null);
        e.target.value = '';
        setFileError(true);
        return;
      }
      setFileError(false);
      setSelectedFile(file);
    }
  };

  const handleConfirm = () => {
    if (selectedFile) {
      onConfirm(selectedFile);
      setFileError(false);
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleClose = () => {
    setFileError(false);
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent size="sm" className="backup-dialog upload-backup-dialog">
        <DialogHeader>
          <DialogTitle>{t('APP_BACKUP_UPLOAD_TITLE')}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <p className="upload-backup-description text-muted">{t('APP_BACKUP_UPLOAD_SUBTITLE')}</p>
          <div className="upload-backup-picker">
            <label htmlFor="backup-file" className="visually-hidden">
              {t('APP_BACKUP_UPLOAD_FILE_LABEL')}
            </label>
            <input ref={fileInputRef} id="backup-file" type="file" accept=".tar.gz" onChange={handleFileChange} hidden />
            <Button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-describedby={fileError ? 'backup-file-error' : 'backup-file-selection'}
            >
              {selectedFile
                ? t('APP_BACKUP_UPLOAD_CHANGE_FILE', { defaultValue: 'Change file' })
                : t('APP_BACKUP_UPLOAD_CHOOSE_FILE', { defaultValue: 'Choose file' })}
            </Button>
            {fileError ? (
              <p id="backup-file-error" className="upload-backup-selection upload-backup-error" role="alert">
                {t('APP_BACKUP_UPLOAD_FILE_PLACEHOLDER')}
              </p>
            ) : (
              <p id="backup-file-selection" className="upload-backup-selection text-muted" aria-live="polite">
                {selectedFile ? `${t('SELECTED_FILE')}: ${selectedFile.name}` : t('APP_BACKUP_UPLOAD_FILE_PLACEHOLDER')}
              </p>
            )}
          </div>
        </DialogDescription>
        <DialogFooter>
          <Button onClick={handleConfirm} intent="success" disabled={!selectedFile}>
            {t('APP_BACKUP_UPLOAD_SUBMIT')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
