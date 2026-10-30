import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import { IconAdjustmentsCode } from '@tabler/icons-react';
import clsx from 'clsx';
import type React from 'react';
import { Suspense, lazy, useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Tooltip } from 'react-tooltip';
import validator from 'validator';
import { type } from 'arktype';
import { AdvancedSettingsModal } from '../advanced-settings-modal/advanced-settings-modal';
import './user-settings-form.css';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { THEME_COLOR_ENUM } from '../color-selector/color-selector';
import { THEME_BASE_ENUM, type ThemeBase } from '../theme-base-selector/theme-base-selector';
import { TimeZoneSuspense } from '@/components/timezone-selector/timezone.suspense';
import { useSettingsSave } from '../../pages/settings-save';

const TimeZoneSelector = lazy(() =>
  import('@/components/timezone-selector/timezone-selector').then((module) => ({
    default: module.TimeZoneSelector,
  })),
);

const LOG_LEVEL_ENUM = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
} as const;
type LogLevel = (typeof LOG_LEVEL_ENUM)[keyof typeof LOG_LEVEL_ENUM];

const settingsSchema = type({
  appsRepoUrl: 'string?',
  localDomain: 'string?',
  guestDashboard: 'boolean?',
  allowAutoThemes: 'boolean?',
  allowErrorMonitoring: 'boolean?',
  timeZone: 'string?',
  advancedSettings: 'boolean?',
  internalIp: 'string.ip.v4?',
  listenIp: 'string.ip.v4?',
  port: '1 <= number <= 65535?',
  sslPort: '1 <= number <= 65535?',
  eventsTimeout: 'number.integer >= 1?',
  maxBackups: '0 <= number.integer <= 100?',
  persistTraefikConfig: 'boolean?',
  domain: 'string?',
  appDataPath: 'string?',
  forwardAuthUrl: 'string.url?',
  logLevel: type.enumerated(...Object.values(LOG_LEVEL_ENUM)).optional(),
  themeColor: type.enumerated(...Object.values(THEME_COLOR_ENUM)).optional(),
  themeBase: type.enumerated(...Object.values(THEME_BASE_ENUM)).optional(),
});

export type SettingsFormValues = {
  appsRepoUrl?: string;
  localDomain?: string;
  guestDashboard?: boolean;
  allowAutoThemes?: boolean;
  allowErrorMonitoring?: boolean;
  timeZone?: string;
  advancedSettings?: boolean;
  internalIp?: string;
  listenIp?: string;
  port?: number;
  sslPort?: number;
  eventsTimeout?: number;
  maxBackups?: number;
  persistTraefikConfig?: boolean;
  domain?: string;
  appDataPath?: string;
  forwardAuthUrl?: string;
  logLevel?: LogLevel;
  themeColor?: string;
  themeBase?: string;
};

interface IProps {
  currentBaseTheme?: ThemeBase;
  onSubmit: (values: SettingsFormValues) => void | Promise<void>;
  initialValues?: Partial<SettingsFormValues>;
  loading?: boolean;
  submitErrors?: Record<string, string>;
}

export const UserSettingsForm = (props: IProps) => {
  const { onSubmit, initialValues, loading, submitErrors } = props;
  const { t } = useTranslation();
  const advancedSettingsDisclosure = useDisclosure();

  const validateFields = (values: SettingsFormValues) => {
    const errors: { [K in keyof SettingsFormValues]?: string } = {};

    if (values.localDomain && !validator.isFQDN(values.localDomain)) {
      errors.localDomain = t('SETTINGS_GENERAL_INVALID_DOMAIN');
    }

    if (values.appsRepoUrl && !validator.isURL(values.appsRepoUrl)) {
      errors.appsRepoUrl = t('SETTINGS_GENERAL_INVALID_URL');
    }

    return errors;
  };

  const {
    register,
    handleSubmit,
    setError,
    control,
    reset,
    formState: { errors, isDirty },
  } = useForm<SettingsFormValues>({ values: initialValues });

  useEffect(() => {
    if (submitErrors) {
      for (const [key, value] of Object.entries(submitErrors)) {
        setError(key as keyof SettingsFormValues, { message: value });
      }
    }
  }, [submitErrors, setError]);

  const validate = (values: SettingsFormValues) => {
    const validationErrors = validateFields(values);

    for (const [key, value] of Object.entries(validationErrors)) {
      if (value) {
        setError(key as keyof SettingsFormValues, { message: value });
      }
    }

    if (Object.keys(validationErrors).length === 0) {
      const result = settingsSchema(values);
      if (result instanceof type.errors) {
        for (const [path, issue] of Object.entries(result.byPath ?? {})) {
          setError(path as keyof SettingsFormValues, { message: issue.message });
        }
        return false;
      }

      return true;
    }
    return false;
  };

  const sharedSave = useSettingsSave({
    section: 'general',
    dirty: isDirty,
    pending: Boolean(loading),
    prepare: async () => {
      let snapshot: SettingsFormValues | null = null;
      await handleSubmit((values) => {
        if (validate(values)) snapshot = structuredClone(values);
      })();
      if (!snapshot) return null;
      const values: SettingsFormValues = snapshot;
      return async () => {
        await onSubmit(values);
        reset(values);
      };
    },
  });

  const downloadCertificate = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    window.open('/api/system/certificate');
  };

  return (
    <form
      className="flex flex-col mt-2"
      onSubmit={handleSubmit(async (values) => {
        if (sharedSave.shared) return sharedSave.save?.();
        if (validate(values)) {
          try {
            await onSubmit(values);
            reset(values);
          } catch {
            // The owning mutation presents the error and retains this draft.
          }
        }
      })}
    >
      <fieldset className="settings-save-fields" disabled={loading || sharedSave.pending}>
        <div className="mb-3">
          <Controller
            control={control}
            name="guestDashboard"
            defaultValue={false}
            render={({ field: { onChange, value, ref, ...rest } }) => (
              <Switch
                id="setting-guestDashboard"
                className="mb-3"
                ref={ref}
                checked={value}
                onCheckedChange={onChange}
                {...rest}
                label={
                  <>
                    {t('SETTINGS_GENERAL_GUEST_DASHBOARD')}
                    <Tooltip className="tooltip" anchorSelect=".guest-dashboard-hint">
                      {t('SETTINGS_GENERAL_GUEST_DASHBOARD_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help guest-dashboard-hint')}>?</span>
                  </>
                }
              />
            )}
          />
        </div>
        <div className="mb-3">
          <Controller
            control={control}
            name="allowErrorMonitoring"
            defaultValue={false}
            render={({ field: { onChange, value, ref, ...rest } }) => (
              <Switch
                id="setting-allowErrorMonitoring"
                className="mb-3"
                ref={ref}
                checked={value}
                onCheckedChange={onChange}
                {...rest}
                label={
                  <>
                    {t('SETTINGS_GENERAL_ALLOW_ERROR_MONITORING')}
                    <Tooltip className="tooltip" anchorSelect=".allow-errors-hint">
                      {t('SETTINGS_GENERAL_ALLOW_ERROR_MONITORING_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help allow-errors-hint')}>?</span>
                  </>
                }
              />
            )}
          />
        </div>
        <div className="mb-3">
          <Controller
            control={control}
            name="advancedSettings"
            defaultValue={false}
            render={({ field: { onChange, value, ref, ...rest } }) => (
              <div>
                <AdvancedSettingsModal
                  onEnable={() => {
                    advancedSettingsDisclosure.close();
                    onChange(true);
                  }}
                  advancedSettingsDisclosure={advancedSettingsDisclosure}
                />
                <Switch
                  id="setting-advancedSettings"
                  className="mb-3"
                  ref={ref}
                  checked={value}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      advancedSettingsDisclosure.open();
                    } else {
                      onChange(false);
                    }
                  }}
                  {...rest}
                  label={
                    <>
                      {t('SETTINGS_GENERAL_ADVANCED_SETTINGS_TITLE')}
                      <Tooltip className="tooltip" anchorSelect=".advanced-settings-hint">
                        {t('SETTINGS_GENERAL_ADVANCED_SETTINGS_SUBTITLE')}
                      </Tooltip>
                      <span className={clsx('ms-1 form-help advanced-settings-hint')}>?</span>
                    </>
                  }
                />
              </div>
            )}
          />
        </div>
        <div className="mb-3">
          <Input
            {...register('appsRepoUrl')}
            id="setting-appsRepoUrl"
            label={
              <>
                {t('SETTINGS_GENERAL_APPS_REPO')}
                <Tooltip className="tooltip" anchorSelect=".apps-repo-hint">
                  {t('SETTINGS_GENERAL_APPS_REPO_HINT')}
                </Tooltip>
                <span className={clsx('ms-1 form-help apps-repo-hint')}>?</span>
              </>
            }
            error={errors.appsRepoUrl?.message}
            placeholder="https://github.com/runtipi/runtipi-appstore"
          />
        </div>
        <div>
          <Controller
            control={control}
            name="timeZone"
            defaultValue="Etc/GMT"
            render={({ field: { onChange, value } }) => (
              <Suspense fallback={<TimeZoneSuspense />}>
                <div id="setting-time-zone">
                  <TimeZoneSelector onChange={onChange} timeZone={value} />
                </div>
              </Suspense>
            )}
          />
        </div>
        <div className="mb-3">
          <Input
            {...register('localDomain')}
            id="setting-localDomain"
            label={
              <>
                {t('SETTINGS_GENERAL_LOCAL_DOMAIN')}
                <Tooltip className="tooltip" anchorSelect=".local-domain-hint">
                  {t('SETTINGS_GENERAL_LOCAL_DOMAIN_HINT')}
                </Tooltip>
                <span className={clsx('ms-1 form-help local-domain-hint')}>?</span>
              </>
            }
            error={errors.localDomain?.message}
            placeholder="tipi.lan"
            disabled={initialValues?.advancedSettings === false}
          />
          <Button id="setting-certificate" className="mt-2 mb-2" onClick={downloadCertificate}>
            {t('SETTINGS_GENERAL_DOWNLOAD_CERTIFICATE')}
          </Button>
        </div>
        {initialValues?.advancedSettings && (
          <div>
            <div className="d-flex mb-2">
              <IconAdjustmentsCode className="me-2" />
              <h2 className="text-2xl font-bold mb-0">{t('SETTINGS_GENERAL_ADVANCED_SETTINGS_TITLE')}</h2>
            </div>
            <p className="mb-4">{t('SETTINGS_GENERAL_ADVANCED_SETTINGS_SUBTITLE')}</p>
            <div className="mb-3">
              <Controller
                control={control}
                name="persistTraefikConfig"
                defaultValue={false}
                render={({ field: { onChange, value, ref, ...rest } }) => (
                  <Switch
                    id="setting-persistTraefikConfig"
                    className="mb-3"
                    ref={ref}
                    checked={value}
                    onCheckedChange={onChange}
                    {...rest}
                    label={
                      <>
                        {t('SETTINGS_GENERAL_PERSIST_TRAEFIK_CONFIG')}
                        <Tooltip className="tooltip" anchorSelect=".persist-traefik-config-hint">
                          {t('SETTINGS_GENERAL_PERSIST_TRAEFIK_CONFIG_HINT')}
                        </Tooltip>
                        <span className={clsx('ms-1 form-help persist-traefik-config-hint')}>?</span>
                      </>
                    }
                  />
                )}
              />
            </div>
            <div className="mb-3">
              <Input
                {...register('domain')}
                id="setting-domain"
                label={
                  <>
                    {t('SETTINGS_GENERAL_DOMAIN')}
                    <Tooltip className="tooltip" anchorSelect=".domain-hint">
                      {t('SETTINGS_GENERAL_DOMAIN_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help domain-hint')}>?</span>
                  </>
                }
                error={errors.domain?.message}
                placeholder="example.com"
              />
            </div>
            <div className="mb-3">
              <Input
                {...register('internalIp')}
                id="setting-internalIp"
                label={
                  <>
                    {t('SETTINGS_GENERAL_INTERNAL_IP')}
                    <Tooltip className="tooltip" anchorSelect=".internal-ip-hint">
                      {t('SETTINGS_GENERAL_INTERNAL_IP_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help internal-ip-hint')}>?</span>
                  </>
                }
                error={errors.internalIp?.message}
                placeholder="192.168.1.1"
              />
            </div>
            <div className="mb-3">
              <Input
                {...register('listenIp')}
                id="setting-listenIp"
                label={
                  <>
                    {t('SETTINGS_GENERAL_LISTEN_IP')}
                    <Tooltip className="tooltip" anchorSelect=".listen-ip-hint">
                      {t('SETTINGS_GENERAL_LISTEN_IP_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help listen-ip-hint')}>?</span>
                  </>
                }
                error={errors.listenIp?.message}
                placeholder="0.0.0.0"
              />
            </div>
            <div className="mb-3">
              <Input
                {...register('port', {
                  valueAsNumber: true,
                })}
                id="setting-port"
                label={
                  <>
                    {t('SETTINGS_GENERAL_PORT')}
                    <Tooltip className="tooltip" anchorSelect=".port-hint">
                      {t('SETTINGS_GENERAL_PORT_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help port-hint')}>?</span>
                  </>
                }
                error={errors.port?.message}
                placeholder="80"
                type="number"
                max={65535}
              />
            </div>
            <div className="mb-3">
              <Input
                {...register('sslPort', {
                  valueAsNumber: true,
                })}
                id="setting-sslPort"
                label={
                  <>
                    {t('SETTINGS_GENERAL_SSL_PORT')}
                    <Tooltip className="tooltip" anchorSelect=".sslPort-hint">
                      {t('SETTINGS_GENERAL_SSL_PORT_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help sslPort-hint')}>?</span>
                  </>
                }
                error={errors.sslPort?.message}
                placeholder="443"
                type="number"
                max={65535}
              />
            </div>
            <div className="mb-3">
              <Input
                {...register('eventsTimeout', {
                  valueAsNumber: true,
                  required: true,
                })}
                id="setting-eventsTimeout"
                label={
                  <>
                    {t('SETTINGS_GENERAL_EVENTS_TIMEOUT')}
                    <Tooltip className="tooltip" anchorSelect=".events-timeout-hint">
                      {t('SETTINGS_GENERAL_EVENTS_TIMEOUT_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help events-timeout-hint')}>?</span>
                  </>
                }
                error={errors.eventsTimeout?.message}
                placeholder="5"
                type="number"
              />
            </div>
            <div className="mb-3">
              <Input
                {...register('maxBackups', {
                  valueAsNumber: true,
                  required: true,
                })}
                id="setting-maxBackups"
                label={
                  <>
                    {t('SETTINGS_GENERAL_MAX_BACKUPS')}
                    <Tooltip className="tooltip" anchorSelect=".max-backups-hint">
                      {t('SETTINGS_GENERAL_MAX_BACKUPS_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help max-backups-hint')}>?</span>
                  </>
                }
                error={errors.maxBackups?.message}
                placeholder="5"
                type="number"
                min={0}
                max={100}
              />
            </div>
            <div className="mb-3">
              <Input
                {...register('appDataPath')}
                id="setting-appDataPath"
                label={
                  <>
                    {t('SETTINGS_GENERAL_APP_DATA_PATH')}
                    <Tooltip className="tooltip" anchorSelect=".app-data-path-hint">
                      {t('SETTINGS_GENERAL_APP_DATA_PATH_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help app-data-path-hint')}>?</span>
                  </>
                }
                error={errors.appDataPath?.message}
                placeholder="/path/to/app/data"
              />
            </div>
            <div className="mb-3">
              <Input
                {...register('forwardAuthUrl')}
                id="setting-forwardAuthUrl"
                label={
                  <>
                    {t('SETTINGS_GENERAL_FORWARD_AUTH_URL')}
                    <Tooltip className="tooltip" anchorSelect=".forward-auth-url-hint">
                      {t('SETTINGS_GENERAL_FORWARD_AUTH_URL_HINT')}
                    </Tooltip>
                    <span className={clsx('ms-1 form-help forward-auth-url-hint')}>?</span>
                  </>
                }
                error={errors.forwardAuthUrl?.message}
                placeholder="https://auth.example.com"
              />
            </div>
            <div className="mb-3">
              <Controller
                control={control}
                name="logLevel"
                defaultValue="info"
                render={({ field: { onChange, value } }) => (
                  <Select value={value} defaultValue="info" onValueChange={onChange}>
                    <SelectTrigger id="setting-logLevel" className="mb-3" name="logLevel" label={t('SETTINGS_GENERAL_LOG_LEVEL')}>
                      <SelectValue placeholder="Log level" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(LOG_LEVEL_ENUM).map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>
        )}
        {sharedSave.shared ? null : (
          <Button loading={loading} type="submit" intent="success">
            {t('SAVE')}
          </Button>
        )}
      </fieldset>
    </form>
  );
};
