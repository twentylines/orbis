import { deleteAppStoreMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import type { AppStore } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { AppStoreError } from '../app-stores-table/app-store-error';
import { revealTableAction } from '@/components/multi-service-form/elements/reveal-table-action';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { useRef } from 'react';

type Props = {
  appStore: AppStore;
};

export const DeleteAppStoreDialog = ({ appStore }: Props) => {
  const { t } = useTranslation();
  const deleteAppStoreDisclosure = useDisclosure();
  const focusFallback = useRef<HTMLElement | null>(null);
  const deleted = useRef(false);

  const deleteAppStore = useMutation({
    ...deleteAppStoreMutation(),
    onSuccess: () => {
      deleted.current = true;
      toast.success(t('APP_STORE_DELETE_SUCCESS'));
      deleteAppStoreDisclosure.close();
    },
  });

  return (
    <div>
      <Button
        size="sm"
        intent="danger"
        variant="ghost"
        disabled={deleteAppStore.isPending}
        onFocus={revealTableAction}
        onClick={(event) => {
          focusFallback.current = event.currentTarget.closest<HTMLElement>('[data-dialog-focus-fallback]');
          deleted.current = false;
          if (deleteAppStore.isError) deleteAppStore.reset();
          deleteAppStoreDisclosure.open();
        }}
      >
        {t('APP_STORE_TABLE_DELETE')}
      </Button>
      <Dialog
        open={deleteAppStoreDisclosure.isOpen}
        onOpenChange={(open) => {
          if (open && deleteAppStore.isError) deleteAppStore.reset();
          deleteAppStoreDisclosure.toggle(open);
        }}
      >
        <DialogContent
          type="danger"
          size="sm"
          className="app-store-dialog"
          onCloseAutoFocus={(event) => {
            if (deleted.current && focusFallback.current?.isConnected) {
              event.preventDefault();
              focusFallback.current.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('APP_STORE_DELETE_DIALOG_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="text-center">
            <IconAlertTriangle size={32} className="text-danger" aria-hidden="true" />
            <p className="app-store-delete-copy">
              <WrapWords text={t('APP_STORE_DELETE_DIALOG_WARNING', { name: appStore.name })} />
            </p>
            <AppStoreError error={deleteAppStore.error as TranslatableError | null} />
          </DialogDescription>
          <DialogFooter>
            <Button loading={deleteAppStore.isPending} intent="danger" onClick={() => deleteAppStore.mutate({ path: { id: appStore.slug } })}>
              {t('APP_STORE_DELETE_DIALOG_SUBMIT')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
