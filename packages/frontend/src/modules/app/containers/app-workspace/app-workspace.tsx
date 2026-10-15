import { AppLogo } from '@/components/app-logo/app-logo';
import { DockerHealth } from '@/components/docker-health/docker-health';
import { useAppContext } from '@/context/app-context';
import { useContainerTelemetry } from '@/desktop/containers';
import { taskIsActive, useTasks } from '@/desktop/tasks';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import { IconActivity, IconArrowLeft, IconArrowUpRight } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useSearchParams } from 'react-router';
import { AppStatus } from '../../components/app-status/app-status';
import { AppActions } from '../app-actions/app-actions';
import { AppDetailsTabs } from '../app-details-tabs/app-details-tabs';
import './app-workspace.css';

type Props = { info: AppInfo; app?: AppDetails | null; metadata: AppMetadata; logo?: ReactNode };

export function AppWorkspace({ info, app, metadata, logo }: Props) {
  const { userSettings } = useAppContext();
  const { t } = useTranslation();
  const location = useLocation();
  const [, setParams] = useSearchParams();
  const containers = useContainerTelemetry();
  const tasks = useTasks();
  const active = tasks.data?.tasks.filter((task) => task.appUrn === info.urn && taskIsActive(task)) ?? [];
  const storeId = info.urn.split(':')[1];
  const fromStore = location.pathname.startsWith('/app-store/');
  const updateAvailable = app && app.version < metadata.latestVersion && app.ignoredVersion !== metadata.latestVersion;

  return (
    <div className="app-workspace" data-testid="app-details">
      <Link className="app-workspace-back" to={fromStore ? `/app-store/${encodeURIComponent(storeId ?? '')}` : '/apps'}>
        <IconArrowLeft size={16} aria-hidden="true" />
        {fromStore ? t('HEADER_APP_STORE') : t('HEADER_APPS')}
      </Link>
      <header className="app-workspace-hero">
        <div className="app-workspace-logo">{logo ?? <AppLogo urn={info.urn} size={96} alt="" />}</div>
        <div className="app-workspace-identity">
          <h2>{info.name}</h2>
          <p>{info.short_desc}</p>
          <div className="app-workspace-state">
            <span className="app-workspace-lifecycle">{app && app.status !== 'missing' ? <AppStatus status={app.status} /> : 'Not installed'}</span>
            {app && app.status !== 'missing' ? (
              <span className="app-workspace-docker">
                Docker <DockerHealth appUrn={info.urn} telemetry={containers.data} stale={containers.isError} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="app-workspace-controls">
          <AppActions app={app} metadata={metadata} info={info} localDomain={userSettings.localDomain} sslPort={userSettings.sslPort} />
        </div>
      </header>
      <dl className="app-workspace-facts">
        <div>
          <dt>{t('APP_DETAILS_VERSION')}</dt>
          <dd>{info.version || 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Store</dt>
          <dd>{storeId === '_user' ? 'Custom application' : storeId}</dd>
        </div>
        <div>
          <dt>{t('APP_DETAILS_AUTHOR')}</dt>
          <dd>{info.author || 'Not provided'}</dd>
        </div>
        <div>
          <dt>Architecture</dt>
          <dd>{info.supported_architectures?.join(' · ') || 'Not specified'}</dd>
        </div>
      </dl>
      {app?.pendingRestart || updateAvailable ? (
        <div className="app-workspace-notices">
          {app?.pendingRestart ? <span>Configuration changed · restart required</span> : null}
          {updateAvailable ? <span>Update available · {metadata.latestDockerVersion || `revision ${metadata.latestVersion}`}</span> : null}
        </div>
      ) : null}
      {active.length ? (
        <button
          type="button"
          className="app-workspace-operation"
          onClick={() =>
            setParams(
              (previous) => {
                const next = new URLSearchParams(previous);
                next.set('tab', 'operations');
                return next;
              },
              { preventScrollReset: true },
            )
          }
        >
          <IconActivity size={18} aria-hidden="true" />
          <span>
            {active.length} operation{active.length === 1 ? '' : 's'} in progress
          </span>
          <IconArrowUpRight size={17} aria-hidden="true" />
        </button>
      ) : null}
      <AppDetailsTabs key={info.urn} info={info} app={app} metadata={metadata} />
    </div>
  );
}
