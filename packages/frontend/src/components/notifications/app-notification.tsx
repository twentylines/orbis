import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { appDestinations } from '@/desktop/app-destinations';
import { requestAppLaunch } from '@/desktop/app-launch-event';
import { primaryAppAddress } from '@/desktop/app-opening';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';

type Props = {
  message: string;
  event: string;
  urn: string;
  path: string;
  addresses: { localDomain?: string; sslPort?: number };
  onDismiss: () => void;
};

export function AppNotification({ message, event, urn, path, addresses, onDismiss }: Props) {
  const failed = event.endsWith('_error');
  const openable = ['install_success', 'start_success', 'restart_success', 'update_success', 'reset_success', 'restore_success'].includes(event);
  const app = useQuery({ ...getAppOptions({ path: { urn } }), enabled: failed || openable, retry: false, staleTime: 0 });
  const navigate = useNavigate();
  const entry = app.data?.app && app.data.info && app.data.metadata ? app.data : undefined;
  const url = entry ? primaryAppAddress(appDestinations(entry, addresses, window.location.hostname), window.location.origin) : undefined;
  const installed = entry?.app && entry.app.status !== 'missing';
  const destination = failed ? (installed ? `${path}?tab=logs` : '/tasks') : event === 'backup_success' ? `${path}?tab=backups` : path;
  const label = failed ? (installed ? 'View logs' : 'View tasks') : event === 'backup_success' ? 'View backups' : 'View app';
  return (
    <>
      <p>{message}</p>
      {event !== 'uninstall_success' ? (
        <div className="orbis-notification-actions">
          {openable && url && entry ? (
            <button
              type="button"
              className="orbis-notification-action"
              onClick={() => {
                if (!requestAppLaunch({ urn, name: entry.info.name, launchUrl: url, manageUrl: path, categories: entry.info.categories }))
                  void navigate(path);
                onDismiss();
              }}
            >
              <span>Open</span>
            </button>
          ) : (
            <button
              type="button"
              className="orbis-notification-action"
              onClick={() => {
                void navigate(destination);
                onDismiss();
              }}
            >
              <span>{label}</span>
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}
