import { AppLogo } from '@/components/app-logo/app-logo';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import type { AppInfo, AppStatus as AppStatusType } from '@/types/app.types';
import { IconAlertCircle, IconDownload, IconRotateClockwise, IconSparkles } from '@tabler/icons-react';
import { memo } from 'react';
import { appHealthSnapshot, sameAppHealth } from '@/desktop/container-health';
import { useTranslation } from 'react-i18next';
import { AppStatus } from '../app-status/app-status';
import './app-tile.css';
import { DockerHealth } from '@/components/docker-health/docker-health';
import type { ContainerTelemetry } from '@runtipi/common/schemas';

type AppTileInfo = Pick<AppInfo, 'urn' | 'name' | 'short_desc' | 'deprecated'>;

type AppTileProps = {
  info: AppTileInfo;
  status: AppStatusType;
  updateAvailable: boolean;
  pendingRestart?: boolean;
  recentlyInstalled?: boolean;
  docker?: { data?: ContainerTelemetry; stale: boolean };
};

export const AppTile = memo(
  function AppTile({ info, status, updateAvailable, pendingRestart, recentlyInstalled, docker }: AppTileProps) {
    const { t } = useTranslation();

    const notice = pendingRestart
      ? { Icon: IconRotateClockwise, label: t('MY_APPS_PENDING_RESTART') }
      : updateAvailable
        ? { Icon: IconDownload, label: t('MY_APPS_UPDATE_AVAILABLE') }
        : info.deprecated
          ? { Icon: IconAlertCircle, label: t('MY_APPS_DEPRECATED') }
          : recentlyInstalled
            ? { Icon: IconSparkles, label: 'New' }
            : null;

    return (
      <div className="card card-sm card-link app-tile">
        <div className="card-body d-flex gap-3 align-items-center app-tile-body">
          <AppLogo alt={`${info.name} logo`} urn={info.urn} size={60} />
          <div className="d-flex flex-column app-tile-copy">
            <div className="d-flex align-items-center gap-2">
              <span className="fw-bolder app-tile-name" title={info.name}>
                <WrapWords text={info.name} />
              </span>
              {!docker || !['running', 'stopped'].includes(status) ? <AppStatus lite status={status} /> : null}
            </div>
            <div className="text-muted">
              <WrapWords text={info.short_desc} />
            </div>
            {docker ? <DockerHealth appUrn={info.urn} telemetry={docker.data} stale={docker.stale} /> : null}
            <span className="app-tile-notice" aria-hidden={notice ? undefined : true}>
              {notice ? (
                <>
                  <notice.Icon size={13} aria-hidden="true" />
                  {notice.label}
                </>
              ) : null}
            </span>
          </div>
        </div>
      </div>
    );
  },
  (a, b) =>
    a.info === b.info &&
    a.status === b.status &&
    a.updateAvailable === b.updateAvailable &&
    a.pendingRestart === b.pendingRestart &&
    a.recentlyInstalled === b.recentlyInstalled &&
    Boolean(a.docker) === Boolean(b.docker) &&
    sameAppHealth(appHealthSnapshot(a.docker?.data, a.info.urn, a.docker?.stale), appHealthSnapshot(b.docker?.data, b.info.urn, b.docker?.stale)),
);
