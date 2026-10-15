import { updateAppMetadataMutation } from '@/api-client/@tanstack/react-query.gen';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { DataGrid, DataGridItem } from '@/components/ui/DataGrid';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import { extractAppUrn } from '@/utils/app-helpers';
import type { AppUrn } from '@runtipi/common/types';
import { CURRENT_SCHEMA_VERSION } from '@runtipi/common/schemas';
import { IconAlertCircle, IconAlertTriangle, IconExternalLink } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { Suspense, lazy } from 'react';
import React from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { Markdown } from '@/components/markdown/markdown';
import { appDescriptionText } from '../../helpers/app-description';
import { ContainerResources } from '@/components/container-resources/container-resources';
import { AppOperations } from '../app-workspace/app-operations';
import clsx from 'clsx';
import './app-details-tabs.css';

const AppDescriptionEditor = React.lazy(() =>
  import('../../components/app-description-editor/app-description-editor').then((module) => ({ default: module.AppDescriptionEditor })),
);

const AppBackups = lazy(() =>
  import('../app-backups/app-backups').then((module) => ({
    default: module.AppBackups,
  })),
);
const AppLogs = lazy(() => import('../app-logs/app-logs').then((module) => ({ default: module.AppLogs })));
const AppUserConfig = lazy(() =>
  import('../app-user-config/app-user-config').then((module) => ({
    default: module.AppUserConfig,
  })),
);

interface IProps {
  info: AppInfo;
  app?: AppDetails | null;
  metadata?: AppMetadata;
}

export const AppDetailsTabs = ({ info, app, metadata }: IProps) => {
  const { t } = useTranslation();

  const urn = extractAppUrn(info.urn as AppUrn);
  const isUserApp = urn.appStoreId === '_user';
  const metaTabId = isUserApp ? 'notes' : 'description';

  const [params, setParams] = useSearchParams();
  const installed = Boolean(app && app.status !== 'missing');
  const allowedTabs = installed
    ? [metaTabId, 'info', 'backups', 'logs', 'user-config', 'resources', 'operations']
    : [metaTabId, 'info', 'operations'];
  const requestedTab = params.get('tab') || metaTabId;
  const currentTab = allowedTabs.includes(requestedTab) ? requestedTab : metaTabId;
  const [isEditing, setIsEditing] = React.useState(false);
  const [meta, setMeta] = React.useState(info.description);
  const schemaVersion = metadata?.composeSchemaVersion;

  const saveMetaMutation = useMutation({
    ...updateAppMetadataMutation(),
    onSuccess: () => {
      setIsEditing(false);
      toast.success(t('APP_NOTES_SAVE_SUCCESS'));
    },
    onError: () => {
      toast.error(t('APP_ERROR_SAVE_NOTES'));
    },
  });

  const handleTabChange = (newTab: string) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('tab', newTab);
        return next;
      },
      { preventScrollReset: true },
    );
  };

  return (
    <Tabs className="app-detail-tabs" value={currentTab} onValueChange={handleTabChange} orientation="horizontal">
      <TabsList aria-label="Application sections">
        <TabsTrigger value={metaTabId}>{isUserApp ? t('APP_DETAILS_NOTES') : t('APP_DETAILS_DESCRIPTION')}</TabsTrigger>
        <TabsTrigger value="resources" disabled={!installed}>
          Resources
        </TabsTrigger>
        <TabsTrigger value="operations">Operations</TabsTrigger>
        <TabsTrigger value="backups" disabled={!installed}>
          {t('APP_BACKUPS_TAB_TITLE')}
        </TabsTrigger>
        <TabsTrigger value="logs" disabled={!installed}>
          {t('APP_LOGS_TAB_TITLE')}
        </TabsTrigger>
        <TabsTrigger value="user-config" disabled={!installed}>
          {t('APP_FILES_TAB_TITLE')}
        </TabsTrigger>
        <TabsTrigger value="info">{t('APP_DETAILS_BASE_INFO')}</TabsTrigger>
      </TabsList>
      <TabsContent value="resources">
        <ContainerResources appUrn={info.urn} />
      </TabsContent>
      <TabsContent value="operations">
        <AppOperations appUrn={info.urn} />
      </TabsContent>
      <TabsContent value={metaTabId}>
        {info.deprecated && (
          <Alert variant="danger" className="mb-4">
            <AlertIcon>
              <IconAlertCircle stroke={2} />
            </AlertIcon>
            <div>
              <AlertHeading>{t('APP_DETAILS_DEPRECATED_ALERT_TITLE')}</AlertHeading>
              <AlertDescription>{t('APP_DETAILS_DEPRECATED_ALERT_SUBTITLE')}</AlertDescription>
            </div>
          </Alert>
        )}
        <Alert variant="warning" className={clsx('mb-4', { 'd-none': schemaVersion === undefined || schemaVersion >= CURRENT_SCHEMA_VERSION })}>
          <AlertIcon>
            <IconAlertTriangle stroke={2} />
          </AlertIcon>
          <div>
            <AlertHeading>{t('APP_COMPOSE_SCHEMA_OUTDATED_ALERT_TITLE')}</AlertHeading>
            <AlertDescription>
              {t('APP_COMPOSE_SCHEMA_OUTDATED_ALERT_SUBTITLE', {
                version: schemaVersion,
              })}
            </AlertDescription>
          </div>
        </Alert>
        <div className="card">
          {isUserApp && (
            <div className="card-header d-flex justify-content-between align-items-center">
              <h3 className="mb-0">{t('APP_DETAILS_NOTES')}</h3>
              {!isEditing && (
                <Button variant="outline" onClick={() => setIsEditing(!isEditing)}>
                  {t('EDIT')}
                </Button>
              )}
              {isEditing && (
                <div>
                  <Button
                    variant="outline"
                    intent="danger"
                    onClick={() => {
                      setIsEditing(false);
                      setMeta(info.description);
                    }}
                  >
                    {t('ACTIONS_CANCEL')}
                  </Button>
                  <Button
                    variant="outline"
                    className="ms-2"
                    onClick={() =>
                      saveMetaMutation.mutate({
                        path: { urn: info.urn },
                        body: { data: meta },
                      })
                    }
                    loading={saveMetaMutation.isPending}
                  >
                    {t('SAVE')}
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className="card-body">
            <Suspense fallback={<output className="app-panel-loading">Loading application details…</output>}>
              {isEditing ? (
                <AppDescriptionEditor isEditing meta={meta} setMeta={setMeta} />
              ) : (
                <Markdown content={appDescriptionText(meta)} className="markdown" />
              )}
            </Suspense>
          </div>
        </div>
      </TabsContent>
      <TabsContent value="backups">
        <Suspense fallback={<output className="app-panel-loading">Loading application details…</output>}>
          <AppBackups info={info} status={app?.status ?? 'missing'} />
        </Suspense>
      </TabsContent>
      <TabsContent value="info">
        <DataGrid>
          <DataGridItem title={t('APP_DETAILS_SOURCE_CODE')}>
            <a target="_blank" rel="noreferrer" className="text-blue-500 text-xs" href={info.source}>
              {t('APP_DETAILS_LINK')}
              <IconExternalLink size={15} className="ms-1 mb-1" />
            </a>
          </DataGridItem>
          <DataGridItem title={t('APP_DETAILS_AUTHOR')}>{info.author}</DataGridItem>
          <DataGridItem title={t('APP_DETAILS_PORT')}>
            <b>{info.port}</b>
          </DataGridItem>
          <DataGridItem title={t('APP_DETAILS_CATEGORIES_TITLE')}>
            {info.categories?.map((c) => (
              <div key={c} className="badge app-detail-tag me-1">
                {t(`APP_CATEGORY_${c.toUpperCase() as Uppercase<typeof c>}`)}
              </div>
            ))}
          </DataGridItem>
          <DataGridItem title={t('APP_DETAILS_VERSION')}>{info.version}</DataGridItem>
          {info.supported_architectures && (
            <DataGridItem title={t('APP_DETAILS_SUPPORTED_ARCH')}>
              {info.supported_architectures.map((a) => (
                <div key={a} className="badge app-detail-tag me-1">
                  {a.toLowerCase()}
                </div>
              ))}
            </DataGridItem>
          )}
          {info.website && (
            <DataGridItem title={t('APP_DETAILS_WEBSITE')}>
              <a target="_blank" rel="noreferrer" className="text-blue-500 text-xs" href={info.website}>
                {info.website}
                <IconExternalLink size={15} className="ms-1 mb-1" />
              </a>
            </DataGridItem>
          )}
          {app && metadata && (
            <DataGridItem title={t('APP_DETAILS_USER_CONFIG')}>
              <b>{metadata.hasCustomConfig ? t('YES') : t('NO')}</b>
            </DataGridItem>
          )}
        </DataGrid>
      </TabsContent>
      <TabsContent value="logs">
        {app?.status === 'running' ? (
          <Suspense fallback={<output className="app-panel-loading">Loading application details…</output>}>
            <AppLogs key={info.urn} appUrn={info.urn} />
          </Suspense>
        ) : (
          <div className="app-panel-empty">
            <h3>App is not running</h3>
            <p>Start the app to view container logs. Operation output is available in Orbis logs.</p>
            <a href="/settings?tab=logs">Open instance logs</a>
          </div>
        )}
      </TabsContent>
      <TabsContent value="user-config">
        {app && (
          <Suspense fallback={<output className="app-panel-loading">Loading application details…</output>}>
            <AppUserConfig info={info} />
          </Suspense>
        )}
      </TabsContent>
    </Tabs>
  );
};
