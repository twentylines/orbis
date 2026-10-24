import { getAppQueryKey, updateAppSettingsMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { type FormValues, InstallForm } from '../../install-form/install-form';
import { AppUpdateSchedule } from './app-update-schedule';
import './app-settings-editor.css';

export function AppSettingsEditor({ info, config, onSaved }: { info: AppInfo; config: Record<string, unknown>; onSaved: () => void }) {
  const { t } = useTranslation();
  const { user } = useAppContext();
  const formId = useId();
  const cache = useQueryClient();
  const updateConfig = useMutation({
    ...updateAppSettingsMutation(),
    onError: (error: TranslatableError) => toast.error(t(error.message, error.intlParams)),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: getAppQueryKey({ path: { urn: info.urn } }) });
      toast.success(t('APP_UPDATE_CONFIG_SUCCESS'));
      onSaved();
    },
  });
  return (
    <div className="app-settings-editor">
      <div className="app-settings-fields">
        <InstallForm
          onSubmit={(values: FormValues) =>
            updateConfig.mutate({
              path: { urn: info.urn },
              body: {
                ...values,
                port: values.port ? Number(values.port) : undefined,
                localSubdomain: values.localSubdomain || undefined,
                maxBackups: values.maxBackups !== undefined && Number.isNaN(values.maxBackups) ? undefined : values.maxBackups,
              },
            })
          }
          formFields={info.form_fields}
          info={info}
          initialValues={config}
          loading={updateConfig.isPending}
          formId={formId}
        />
        {user.operator ? <AppUpdateSchedule key={info.urn} urn={info.urn} name={info.name} /> : null}
      </div>
      <div className="app-settings-save">
        <Button type="submit" intent="primary" form={formId} disabled={updateConfig.isPending} aria-busy={updateConfig.isPending}>
          {updateConfig.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
