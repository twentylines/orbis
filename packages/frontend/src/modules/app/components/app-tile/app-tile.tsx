import { AppLogo } from '@/components/app-logo/app-logo';
import { limitText } from '@/lib/helpers/text-helpers';
import type { AppInfo, AppStatus as AppStatusType } from '@/types/app.types';
import { IconAlertCircle, IconDownload, IconRotateClockwise } from '@tabler/icons-react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { AppStatus } from '../app-status/app-status';
import './app-tile.css';
import { DockerHealth } from '@/components/docker-health/docker-health';
import type { ContainerTelemetry } from '@runtipi/common/schemas';

type AppTileInfo = Pick<AppInfo, 'urn' | 'name' | 'short_desc' | 'deprecated'>;

export const AppTile: React.FC<{
  info: AppTileInfo;
  status: AppStatusType;
  updateAvailable: boolean;
  pendingRestart?: boolean;
  docker?: { data?: ContainerTelemetry; stale: boolean };
}> = ({ info, status, updateAvailable, pendingRestart, docker }) => {
  const { t } = useTranslation();

  const notice = pendingRestart
    ? { Icon: IconRotateClockwise, label: t('MY_APPS_PENDING_RESTART') }
    : updateAvailable
      ? { Icon: IconDownload, label: t('MY_APPS_UPDATE_AVAILABLE') }
      : info.deprecated
        ? { Icon: IconAlertCircle, label: t('MY_APPS_DEPRECATED') }
        : null;

  return (
    <div className="card card-sm card-link app-tile">
      <div className="card-body d-flex gap-3 align-items-center app-tile-body">
        <AppLogo alt={`${info.name} logo`} urn={info.urn} size={60} />
        <div className="d-flex flex-column app-tile-copy">
          <div className="d-flex align-items-center gap-2">
            <span className="fw-bolder">{info.name}</span>
            {!docker || !['running', 'stopped'].includes(status) ? <AppStatus lite status={status} /> : null}
          </div>
          <div className="text-muted">{limitText(info.short_desc, 50)}</div>
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
};
