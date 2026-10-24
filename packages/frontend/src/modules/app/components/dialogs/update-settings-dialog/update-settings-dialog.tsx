import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import type { AppInfo, AppStatus } from '@/types/app.types';
import { useTranslation } from 'react-i18next';
import { AppSettingsEditor } from './app-settings-editor';

interface IProps {
  info: AppInfo;
  config: Record<string, unknown>;
  isOpen: boolean;
  onClose: () => void;
  status?: AppStatus;
}

export function UpdateSettingsDialog({ info, config, isOpen, onClose }: IProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="app-settings-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('APP_UPDATE_SETTINGS_FORM_TITLE', { name: info.id })}</DialogTitle>
        </DialogHeader>
        {isOpen ? <AppSettingsEditor info={info} config={config} onSaved={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}
