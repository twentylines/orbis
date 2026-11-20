import { getAllAppStoresQueryKey, getEnabledAppStoresQueryKey, updateAppStoreMutation } from '@/api-client/@tanstack/react-query.gen';
import { updateAppStore, type GetAllAppStoresResponse } from '@/api-client';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { useAutosavedToggle } from '@/modules/settings/hooks/use-autosaved-toggle';
import { AutosavedSettingSwitch } from '../autosaved-setting-switch';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import type { AppStore } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { arktypeResolver } from '@hookform/resolvers/arktype';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type } from 'arktype';
import { useId } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { AppStoreError } from '../app-stores-table/app-store-error';
import { revealTableAction } from '@/components/multi-service-form/elements/reveal-table-action';

type Props = {
  appStore: AppStore;
};

const schema = type({ name: 'string <= 16' });
type FormValues = typeof schema.infer;

export const EditAppStoreDialog = ({ appStore }: Props) => {
  const editAppStoreDisclosure = useDisclosure();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const editAppStore = useMutation({
    ...updateAppStoreMutation(),
    onSuccess: () => {
      editAppStoreDisclosure.close();
    },
  });

  const enabled = useAutosavedToggle({
    id: `app-store-enabled:${appStore.slug}`,
    scope: `app-store:${appStore.slug}`,
    saved: appStore.enabled,
    disabled: editAppStore.isPending,
    save: async (checked, signal) => {
      const allKey = getAllAppStoresQueryKey();
      try {
        const { data } = await updateAppStore({ path: { id: appStore.slug }, body: { enabled: checked }, signal, throwOnError: true });
        if (data?.success !== true) throw new Error('The app store did not confirm the change.');
        await queryClient.cancelQueries({ queryKey: allKey });
        signal.throwIfAborted();
        queryClient.setQueryData<GetAllAppStoresResponse>(
          allKey,
          (current) =>
            current && { appStores: current.appStores.map((store) => (store.slug === appStore.slug ? { ...store, enabled: checked } : store)) },
        );
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && error.message === 'APP_STORE_REFRESH_ERROR') throw new Error(t(error.message, { stores: appStore.name }));
        throw new Error('The app store change could not be confirmed. Try again.');
      } finally {
        if (!signal.aborted) {
          void queryClient.invalidateQueries({ queryKey: allKey });
          void queryClient.invalidateQueries({ queryKey: getEnabledAppStoresQueryKey() });
        }
      }
    },
  });

  const { register, handleSubmit, formState, reset } = useForm<FormValues>({
    resolver: arktypeResolver(schema),
    defaultValues: { name: appStore.name },
  });

  const saveName = ({ name }: FormValues) => {
    if (enabled.pending) return;
    editAppStore.mutate({ path: { id: appStore.slug }, body: { name } });
  };
  const changeOpen = (open: boolean) => {
    if (open) {
      editAppStore.reset();
      reset({ name: appStore.name });
    }
    editAppStoreDisclosure.toggle(open);
  };

  const formId = useId();

  return (
    <div>
      <Button loading={editAppStore.isPending} size="sm" variant="ghost" onFocus={revealTableAction} onClick={() => changeOpen(true)}>
        {t('APP_STORE_TABLE_EDIT')}
      </Button>
      <Dialog open={editAppStoreDisclosure.isOpen} onOpenChange={changeOpen}>
        <DialogContent size="sm" className="app-store-dialog">
          <DialogHeader>
            <DialogTitle>{t('APP_STORE_EDIT_DIALOG_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="d-flex flex-column">
            <form onSubmit={handleSubmit(saveName)} id={formId}>
              <Input
                label="Name"
                className="mb-3"
                error={formState.errors.name?.message}
                disabled={editAppStore.isPending}
                type="text"
                placeholder={appStore.name}
                {...register('name', {
                  onChange: () => {
                    if (editAppStore.isError) editAppStore.reset();
                  },
                })}
              />
            </form>
            <AutosavedSettingSwitch className="mb-3" toggle={enabled} label={t('APP_STORE_EDIT_DIALOG_ENABLED')} showStatus />
            <AppStoreError error={editAppStore.error as TranslatableError | null} />
          </DialogDescription>
          <DialogFooter>
            <Button disabled={enabled.pending} loading={editAppStore.isPending} type="submit" intent="success" form={formId}>
              {t('APP_STORE_EDIT_DIALOG_SUBMIT')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
