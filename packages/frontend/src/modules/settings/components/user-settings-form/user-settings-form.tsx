import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { IconAdjustmentsCode } from '@tabler/icons-react';
import clsx from 'clsx';
import type React from 'react';
import { Suspense, lazy, useRef, useState } from 'react';
import { Controller, useForm, type RegisterOptions } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Tooltip } from 'react-tooltip';
import validator from 'validator';
import { type } from 'arktype';
import './user-settings-form.css';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { THEME_COLOR_ENUM } from '../color-selector/color-selector';
import { THEME_BASE_ENUM, type ThemeBase } from '../theme-base-selector/theme-base-selector';
import { TimeZoneSuspense } from '@/components/timezone-selector/timezone.suspense';
import { useSettingsPreferenceActivity } from '../../pages/settings-save';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import type { useGeneralSettingToggles } from '../../hooks/use-general-setting-toggles';
import { AutosavedSettingSwitch } from '../autosaved-setting-switch';

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
  timeZone: 'string?',
  advancedSettings: 'boolean?',
  internalIp: 'string.ip.v4?',
  listenIp: 'string.ip.v4?',
  port: '1 <= number.integer <= 65535?',
  sslPort: '1 <= number.integer <= 65535?',
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
  signal?: AbortSignal;
  toggles: ReturnType<typeof useGeneralSettingToggles>;
}

export const UserSettingsForm = (props: IProps) => {
  const { onSubmit, initialValues, signal, toggles } = props;
  const { t } = useTranslation();

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

  const { guestDashboard: guestDashboardEnabled, advancedSettings: _advanced, persistTraefikConfig: _proxy, ...draftValues } = initialValues ?? {};
  const {
    register,
    getValues,
    clearErrors,
    setError,
    control,
    resetField,
    formState: { errors, dirtyFields },
  } = useForm<SettingsFormValues>({ values: draftValues, resetOptions: { keepDirtyValues: true } });
  const guestDashboard = toggles['guest-dashboard'];
  const advancedSettings = toggles['advanced-settings'].checked;
  type Field = keyof SettingsFormValues;
  const inFlight = useRef(new Set<Field>());
  const [pending, setPending] = useState<ReadonlySet<Field>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<Field>>(() => new Set());
  const [saved, setSaved] = useState(false);
  useSettingsPreferenceActivity(pending.size > 0, saved, failed.size > 0 || Object.keys(dirtyFields).length > 0);

  const commit = async (field: Field, value: SettingsFormValues[Field], changed = dirtyFields[field]) => {
    if (signal?.aborted || !changed || inFlight.current.has(field)) return;
    const patch = { [field]: value };
    const domainError = validateFields(patch)[field];
    const schema = settingsSchema(patch);
    if (domainError || schema instanceof type.errors) {
      setError(field, { message: domainError ?? (schema instanceof type.errors ? schema.summary : undefined) });
      return;
    }
    clearErrors(field);
    inFlight.current.add(field);
    setPending(new Set(inFlight.current));
    setFailed((current) => new Set([...current].filter((key) => key !== field)));
    try {
      await onSubmit(patch);
      if (signal?.aborted) return;
      if (Object.is(getValues(field), value)) resetField(field, { defaultValue: value });
      setSaved(true);
    } catch {
      if (!signal?.aborted) setFailed((current) => new Set([...current, field]));
    } finally {
      inFlight.current.delete(field);
      if (!signal?.aborted) setPending(new Set(inFlight.current));
    }
  };

  const preferenceInput = <K extends Field>(field: K, options?: RegisterOptions<SettingsFormValues, K>) => ({
    ...register(field, {
      ...options,
      onBlur: () => void commit(field, getValues(field)),
      onChange: () => clearErrors(field),
    }),
    disabled: pending.has(field),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.currentTarget.blur();
    },
  });

  const downloadCertificate = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    window.open('/api/system/certificate');
  };

  return (
    <form className="settings-general-form flex flex-col mt-2" onSubmit={(event) => event.preventDefault()}>
      <fieldset className="settings-save-fields">
        <div className="settings-general-toggles">
          <div className="settings-guest-dashboard">
            <AutosavedSettingSwitch
              id="setting-guestDashboard"
              toggle={guestDashboard}
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
            {guestDashboardEnabled && guestDashboard.checked && (
              <Button asChild variant="outline">
                <Link to="/apps" aria-label="Manage shared applications">
                  Manage
                </Link>
              </Button>
            )}
          </div>
          <div>
            <AutosavedSettingSwitch
              id="setting-advancedSettings"
              toggle={toggles['advanced-settings']}
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
        </div>
        <div className="mb-3">
          <Input
            {...preferenceInput('appsRepoUrl')}
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
                  <TimeZoneSelector
                    onChange={(next) => {
                      if (next === value || pending.has('timeZone')) return;
                      onChange(next);
                      void commit('timeZone', next, true);
                    }}
                    timeZone={value}
                  />
                </div>
              </Suspense>
            )}
          />
        </div>
        <div className="mb-3">
          <Input
            {...preferenceInput('localDomain')}
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
            placeholder="orbis.lan"
            disabled={!advancedSettings || pending.has('localDomain')}
          />
          <Button id="setting-certificate" className="mt-2 mb-2" onClick={downloadCertificate}>
            {t('SETTINGS_GENERAL_DOWNLOAD_CERTIFICATE')}
          </Button>
        </div>
        {advancedSettings && (
          <div>
            <div className="d-flex mb-2">
              <IconAdjustmentsCode className="me-2" />
              <h2 className="text-2xl font-bold mb-0">{t('SETTINGS_GENERAL_ADVANCED_SETTINGS_TITLE')}</h2>
            </div>
            <p className="mb-4">{t('SETTINGS_GENERAL_ADVANCED_SETTINGS_SUBTITLE')}</p>
            <div className="mb-3">
              <AutosavedSettingSwitch
                id="setting-persistTraefikConfig"
                className="mb-3"
                toggle={toggles['persist-proxy']}
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
            </div>
            <div className="mb-3">
              <Input
                {...preferenceInput('domain')}
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
                {...preferenceInput('internalIp')}
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
                {...preferenceInput('listenIp')}
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
                {...preferenceInput('port', {
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
                {...preferenceInput('sslPort', {
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
                {...preferenceInput('eventsTimeout', {
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
                {...preferenceInput('maxBackups', {
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
                {...preferenceInput('appDataPath')}
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
                {...preferenceInput('forwardAuthUrl')}
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
                  <Select
                    value={value}
                    defaultValue="info"
                    disabled={pending.has('logLevel')}
                    onValueChange={(next: LogLevel) => {
                      if (next === value) return;
                      onChange(next);
                      void commit('logLevel', next, true);
                    }}
                  >
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
        {failed.size > 0 && (
          <InlineFeedback>
            Some preferences could not be saved. Your changes are still here.
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                for (const field of failed) void commit(field, getValues(field), true);
              }}
            >
              Retry
            </Button>
          </InlineFeedback>
        )}
      </fieldset>
    </form>
  );
};
