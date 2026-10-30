import type { AppContextDto, GetRandomPortResponse } from '@/api-client';
import { getRandomPortMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Input, InputGroup } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useAppContext } from '@/context/app-context';
import type { AppInfo, FormField } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { extractAppUrn } from '@/utils/app-helpers';
import type { AppUrn } from '@runtipi/common/types';
import { useMutation } from '@tanstack/react-query';
import React, { useEffect, useImperativeHandle, useRef } from 'react';
import { Controller, useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Tooltip } from 'react-tooltip';
import { hiddenTypes, validateAppConfig } from './form-validators';
import { InstallFormField } from './install-form-field';

interface IProps {
  formFields?: FormField[];
  onSubmit: (values: FormValues) => void;
  initialValues?: { [key: string]: unknown } & { forcePull?: boolean };
  info: AppInfo;
  loading?: boolean;
  formId: string;
  targetSettings?: InstallSettings;
  getTargetPort?: () => Promise<GetRandomPortResponse>;
}

export type InstallFormValidationResult = { valid: true; values: FormValues } | { valid: false; firstInvalidField?: string };

export type InstallFormValidationHandle = {
  validate: () => Promise<InstallFormValidationResult>;
  focusFirstInvalid: () => void;
};

export type InstallSettings = Pick<AppContextDto['userSettings'], 'guestDashboard' | 'localDomain' | 'internalIp' | 'domain' | 'maxBackups'>;

export type FormValues = {
  port?: string;
  exposed: boolean;
  exposedLocal: boolean;
  openPort: boolean;
  domain?: string;
  localSubdomain?: string;
  isVisibleOnGuestDashboard?: boolean;
  enableAuth: boolean;
  maxBackups?: number;
  forcePull?: boolean;
  [key: string]: unknown;
};

const typeFilter = (field: FormField) => !hiddenTypes.includes(field.type);

export const InstallForm = React.forwardRef<InstallFormValidationHandle, IProps>(
  ({ formFields = [], info, onSubmit, initialValues, loading, formId, targetSettings, getTargetPort }, ref) => {
    const { t } = useTranslation();
    const { userSettings } = useAppContext();
    const fieldPrefix = React.useId();
    const fieldId = (name: string) => `${fieldPrefix}-${name}`;
    const { guestDashboard, localDomain, internalIp, domain, maxBackups: globalMaxBackups } = targetSettings ?? userSettings;

    const {
      register,
      handleSubmit,
      formState: { errors, isDirty },
      setValue,
      watch,
      setError,
      clearErrors,
      control,
      trigger,
      getValues,
      getFieldState,
      setFocus,
    } = useForm<FormValues>({
      defaultValues: initialValues,
    });
    const firstInvalidField = useRef<string | undefined>(undefined);
    const parentErrorFields = useRef(new Set<string>());
    const watchExposed = watch('exposed', false);
    const watchOpenPort = watch('openPort', !info.force_expose);
    const watchExposedLocal = watch('exposedLocal', false);

    const { appName } = extractAppUrn(info.urn as AppUrn);

    useEffect(() => {
      if (initialValues && !isDirty) {
        for (const [key, value] of Object.entries(initialValues)) {
          setValue(key, value as string);
        }
      }
      if (info.force_expose) {
        setValue('exposed', true);
        setValue('openPort', false);
      }
    }, [initialValues, isDirty, setValue, info.force_expose]);

    const randomPortMutation = useMutation({
      ...getRandomPortMutation(),
      ...(getTargetPort ? { mutationFn: getTargetPort } : {}),
      onError: (e: TranslatableError) => {
        toast.error(t(e.message, e.intlParams));
      },
      onSuccess: (data: GetRandomPortResponse) => {
        setValue('port', data.port.toString(), { shouldDirty: true });
      },
    });

    const renderField = (field: FormField) => {
      return (
        <InstallFormField
          id={fieldId(field.env_variable)}
          loading={loading}
          initialValue={(initialValues ? initialValues[field.env_variable] : field.default) as string}
          register={register}
          field={field}
          control={control}
          key={field.env_variable}
          error={errors[field.env_variable]?.message}
        />
      );
    };

    const renderExposeForm = () => (
      <>
        <Controller
          control={control}
          name="exposed"
          defaultValue={false}
          render={({ field: { onChange, value, ref, ...props } }) => (
            <Switch
              {...props}
              className="mb-3"
              ref={ref}
              checked={value}
              onCheckedChange={onChange}
              disabled={loading || info.force_expose}
              label={t('APP_INSTALL_FORM_EXPOSE_APP')}
            />
          )}
        />
        {watchExposed && (
          <div className="mb-3">
            <Input
              id={fieldId('domain')}
              {...register('domain')}
              label={t('APP_INSTALL_FORM_DOMAIN_NAME')}
              error={errors.domain?.message}
              disabled={loading}
              placeholder={domain ? `${appName}.${domain}` : `${appName}.example.com`}
            />
            <p className="form-text text-muted">{t('APP_INSTALL_FORM_DOMAIN_NAME_HINT')}</p>
          </div>
        )}
      </>
    );

    const renderDynamicConfigProxyForm = () => {
      return (
        <>
          {info.exposable && (
            <>
              <Controller
                control={control}
                name="exposedLocal"
                render={({ field: { onChange, value, ref, ...props } }) => (
                  <Switch
                    {...props}
                    className="mb-3"
                    ref={ref}
                    checked={value}
                    onCheckedChange={onChange}
                    disabled={loading}
                    label={
                      <>
                        {t('APP_INSTALL_FORM_EXPOSE_LOCAL')}
                        <Tooltip className="tooltip" id={fieldId('expose-local-hint')}>
                          {t('APP_INSTALL_FORM_EXPOSE_LOCAL_HINT', {
                            domain: localDomain,
                            appId: info.urn.split(':').join('-'),
                          })}
                        </Tooltip>
                        <span className="ms-1 form-help" data-tooltip-id={fieldId('expose-local-hint')}>
                          ?
                        </span>
                      </>
                    }
                  />
                )}
              />
              {watchExposedLocal && (
                <div className="mb-3">
                  <InputGroup
                    id={fieldId('localSubdomain')}
                    groupPrefix="https://"
                    groupSuffix={`.${localDomain}`}
                    {...register('localSubdomain')}
                    label={t('APP_INSTALL_FORM_LOCAL_SUBDOMAIN')}
                    error={errors.localSubdomain?.message}
                    disabled={loading}
                    placeholder={info.urn.split(':').join('-')}
                  />
                </div>
              )}
              <Controller
                control={control}
                name="enableAuth"
                render={({ field: { onChange, value, ref, ...props } }) => (
                  <Switch
                    {...props}
                    className="mb-3"
                    ref={ref}
                    checked={value}
                    onCheckedChange={onChange}
                    disabled={loading}
                    label={
                      <>
                        {t('APP_INSTALL_FORM_ENABLE_AUTH')}
                        <Tooltip className="tooltip" id={fieldId('enable-auth-hint')}>
                          {t('APP_INSTALL_FORM_ENABLE_AUTH_HINT')}
                        </Tooltip>
                        <span className="ms-1 form-help" data-tooltip-id={fieldId('enable-auth-hint')}>
                          ?
                        </span>
                      </>
                    }
                  />
                )}
              />
            </>
          )}
        </>
      );
    };

    const validate = (values: FormValues) => {
      const validationErrors = validateAppConfig(values, formFields);
      let focusFirst = true;

      for (const [key, value] of Object.entries(validationErrors)) {
        if (value) {
          setError(key, { message: t(value.messageKey, value.params) }, { shouldFocus: focusFirst });
          focusFirst = false;
        }
      }

      if (Object.keys(validationErrors).length === 0) {
        onSubmit(values);
      }
    };

    const validateForParent = async (): Promise<InstallFormValidationResult> => {
      const formIsValid = await trigger(undefined, { shouldFocus: false });
      const values = getValues();
      const validationErrors = validateAppConfig(values, formFields);
      const customErrors = Object.entries(validationErrors).filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => Boolean(entry[1]));
      const customErrorFields = new Set(customErrors.map(([key]) => key));
      for (const key of parentErrorFields.current) {
        if (!customErrorFields.has(key)) clearErrors(key);
      }
      for (const [key, value] of customErrors) {
        setError(key, { message: t(value.messageKey, value.params) }, { shouldFocus: false });
      }
      parentErrorFields.current = customErrorFields;
      const registeredError = Object.keys(values).find((key) => getFieldState(key).invalid);
      firstInvalidField.current = customErrors[0]?.[0] ?? registeredError;
      if (!formIsValid || customErrors.length) return { valid: false, firstInvalidField: firstInvalidField.current };
      return { valid: true, values };
    };

    useImperativeHandle(ref, () => ({
      validate: validateForParent,
      focusFirstInvalid: () => {
        if (firstInvalidField.current) setFocus(firstInvalidField.current);
      },
    }));

    return (
      <form className="flex flex-col" onSubmit={handleSubmit(validate)} id={formId} aria-busy={loading}>
        {(guestDashboard || formFields.filter(typeFilter).length !== 0) && <h3>{t('APP_INSTALL_FORM_GENERAL')}</h3>}
        {formFields.filter(typeFilter).map(renderField)}
        {guestDashboard && (
          <Controller
            control={control}
            name="isVisibleOnGuestDashboard"
            defaultValue={false}
            render={({ field: { onChange, value, ref, ...props } }) => (
              <Switch
                className="mb-3"
                ref={ref}
                checked={value}
                onCheckedChange={onChange}
                {...props}
                disabled={loading}
                label={t('APP_INSTALL_FORM_DISPLAY_ON_GUEST_DASHBOARD')}
              />
            )}
          />
        )}
        {info.dynamic_config && (
          <div className="mb-3">
            <h3>{t('APP_DETAILS_PORT')}</h3>
            <Controller
              control={control}
              name="openPort"
              defaultValue={!info.force_expose}
              render={({ field: { onChange, value, ref, ...props } }) => (
                <Switch
                  {...props}
                  className="mb-3"
                  ref={ref}
                  checked={value}
                  onCheckedChange={onChange}
                  disabled={loading || info.force_expose}
                  label={
                    <>
                      {t('APP_INSTALL_FORM_OPEN_PORT')}
                      <Tooltip className="tooltip" id={fieldId('open-port-hint')}>
                        {t('APP_INSTALL_FORM_OPEN_PORT_HINT', {
                          port: info.port,
                          internalIp,
                        })}
                      </Tooltip>
                      <span className="ms-1 form-help" data-tooltip-id={fieldId('open-port-hint')}>
                        ?
                      </span>
                    </>
                  }
                />
              )}
            />
            {watchOpenPort && (
              <div>
                <InputGroup
                  id={fieldId('port')}
                  type="number"
                  aria-label={t('APP_DETAILS_PORT')}
                  defaultValue={info.port}
                  groupSuffix={
                    <Button type="button" onClick={() => randomPortMutation.mutate({})} loading={loading || randomPortMutation.isPending}>
                      {t('APP_INSTALL_FORM_RANDOM')}
                    </Button>
                  }
                  max={65535}
                  {...register('port', {
                    valueAsNumber: true,
                  })}
                  error={errors.port?.message}
                  disabled={loading || randomPortMutation.isPending}
                  placeholder="8484"
                  className="flex-grow-1"
                />
                <p className="form-text text-muted">{t('APP_INSTALL_FORM_PORT_HINT')}</p>
              </div>
            )}
          </div>
        )}
        {info.exposable && (
          <>
            {info.dynamic_config && (
              <>
                <h3>{t('APP_INSTALL_FORM_REVERSE_PROXY')}</h3>
                {renderDynamicConfigProxyForm()}
              </>
            )}
            {renderExposeForm()}
          </>
        )}
        <div className="mb-3">
          <Input
            id={fieldId('maxBackups')}
            type="number"
            min={0}
            max={100}
            {...register('maxBackups', {
              valueAsNumber: true,
              setValueAs: (value) => (value === '' || value === null ? undefined : Number(value)),
              min: { value: 0, message: t('APP_INSTALL_FORM_MAX_BACKUPS_ERROR_MIN') },
              max: { value: 100, message: t('APP_INSTALL_FORM_MAX_BACKUPS_ERROR_MAX') },
            })}
            label={t('APP_INSTALL_FORM_MAX_BACKUPS')}
            error={errors.maxBackups?.message}
            disabled={loading}
            placeholder={globalMaxBackups === 0 ? undefined : globalMaxBackups.toString()}
          />
          <p className="form-text text-muted">{t('APP_INSTALL_FORM_MAX_BACKUPS_HINT', { value: globalMaxBackups })}</p>
        </div>
        <div className="mb-3">
          <Controller
            control={control}
            name="forcePull"
            defaultValue={initialValues?.forcePull ?? info.force_pull ?? false}
            render={({ field: { onChange, value, ref, ...props } }) => {
              const checkedValue = value !== undefined ? value : false;
              return (
                <Switch
                  {...props}
                  className="mb-3"
                  ref={ref}
                  checked={checkedValue}
                  onCheckedChange={onChange}
                  disabled={loading}
                  label={
                    <>
                      {t('APP_INSTALL_FORM_FORCE_PULL')}
                      <Tooltip className="tooltip" id={fieldId('force-pull-hint')}>
                        {t('APP_INSTALL_FORM_FORCE_PULL_HINT')}
                      </Tooltip>
                      <span className="ms-1 form-help" data-tooltip-id={fieldId('force-pull-hint')}>
                        ?
                      </span>
                    </>
                  }
                />
              );
            }}
          />
        </div>
      </form>
    );
  },
);
