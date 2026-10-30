import { updateAppStoreMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import type { AppStore } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { arktypeResolver } from '@hookform/resolvers/arktype';
import { useMutation } from '@tanstack/react-query';
import { type } from 'arktype';
import { useId } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { AppStoreError } from '../app-stores-table/app-store-error';
import { revealTableAction } from '@/components/multi-service-form/elements/reveal-table-action';

type Props = {
  appStore: AppStore;
};

export const EditAppStoreDialog = ({ appStore }: Props) => {
  const editAppStoreDisclosure = useDisclosure();
  const { t } = useTranslation();

  const schema = type({
    name: 'string <= 16',
    enabled: 'boolean',
  });

  type FormValues = typeof schema.infer;

  const editAppStore = useMutation({
    ...updateAppStoreMutation(),
    onSuccess: () => {
      editAppStoreDisclosure.close();
    },
  });

  const { register, control, handleSubmit, formState } = useForm<FormValues>({
    resolver: arktypeResolver(schema),
    values: { name: appStore.name, enabled: appStore.enabled },
  });

  const validate = (values: FormValues) => {
    editAppStore.mutate({ path: { id: appStore.slug }, body: { name: values.name, enabled: values.enabled } });
  };

  const formId = useId();

  return (
    <div>
      <Button
        loading={editAppStore.isPending}
        size="sm"
        variant="ghost"
        onFocus={revealTableAction}
        onClick={() => {
          if (editAppStore.isError) editAppStore.reset();
          editAppStoreDisclosure.open();
        }}
      >
        {t('APP_STORE_TABLE_EDIT')}
      </Button>
      <Dialog
        open={editAppStoreDisclosure.isOpen}
        onOpenChange={(open) => {
          if (open && editAppStore.isError) editAppStore.reset();
          editAppStoreDisclosure.toggle(open);
        }}
      >
        <DialogContent size="sm" className="app-store-dialog">
          <DialogHeader>
            <DialogTitle>{t('APP_STORE_EDIT_DIALOG_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="d-flex flex-column">
            <form onSubmit={handleSubmit(validate)} id={formId}>
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
              <Controller
                control={control}
                name="enabled"
                defaultValue={appStore.enabled}
                render={({ field: { onChange, value, ref, ...rest } }) => (
                  <Switch
                    className="mb-3"
                    disabled={editAppStore.isPending}
                    ref={ref}
                    checked={Boolean(value)}
                    onCheckedChange={(checked) => {
                      if (editAppStore.isError) editAppStore.reset();
                      onChange(checked);
                    }}
                    {...rest}
                    label={t('APP_STORE_EDIT_DIALOG_ENABLED')}
                  />
                )}
              />
            </form>
            <AppStoreError error={editAppStore.error as TranslatableError | null} />
          </DialogDescription>
          <DialogFooter>
            <Button loading={editAppStore.isPending} type="submit" intent="success" form={formId}>
              {t('APP_STORE_EDIT_DIALOG_SUBMIT')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
