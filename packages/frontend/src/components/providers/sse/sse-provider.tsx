import { useSSE } from '@/lib/hooks/use-sse';
import { extractAppUrn } from '@/utils/app-helpers';
import type { AppUrn } from '@runtipi/common/types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type PropsWithChildren } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { useConnectionStore } from '@/stores/connection-store';
import { preferenceChangeEvent } from '@/desktop/appearance-cache';
import { appEventAffectsQuery } from '@/desktop/app-event-cache';
import { useBrowserPresence } from '@/desktop/browser-presence';
import { useAppContext } from '@/context/app-context';
import { AppNotification } from '@/components/notifications/app-notification';

const announcePreferences = () => window.dispatchEvent(new Event(preferenceChangeEvent));

export const SSEProvider = ({ children }: PropsWithChildren) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { userSettings } = useAppContext();
  const setConnectionStatus = useConnectionStore((state) => state.setStatus);
  const pending = useRef({
    urns: new Set<string>(),
    catalogue: false,
    reconnect: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const refresh = (urn?: string, catalogue = false, reconnect = false) => {
    const batch = pending.current;
    if (urn) batch.urns.add(urn);
    batch.catalogue ||= catalogue;
    batch.reconnect ||= reconnect;
    if (batch.timer !== undefined) return;
    batch.timer = setTimeout(() => {
      const urns = new Set(batch.urns);
      const refreshCatalogue = batch.catalogue;
      const refreshDetails = batch.reconnect;
      batch.urns.clear();
      batch.catalogue = false;
      batch.reconnect = false;
      batch.timer = undefined;
      void queryClient.invalidateQueries({ predicate: (query) => appEventAffectsQuery(query.queryKey, urns, refreshCatalogue, refreshDetails) });
    }, 100);
  };
  useEffect(() => () => clearTimeout(pending.current.timer), []);

  const streamStatus = useSSE({
    topic: 'app',
    onOpen: () => {
      setConnectionStatus('connected');
      announcePreferences();
      refresh(undefined, true, true);
    },
    onPreferencesChanged: announcePreferences,
    onError: () => setConnectionStatus('reconnecting'),
    onEvent: ({ event, appUrn, error }) => {
      if (error) {
        console.error(error);
      }

      const { appName, appStoreId } = extractAppUrn(appUrn as AppUrn);
      const path =
        appStoreId === '_user' ? `/apps/${encodeURIComponent(appName)}` : `/apps/${encodeURIComponent(appStoreId)}/${encodeURIComponent(appName)}`;
      const notify = (kind: 'success' | 'error', key: string) =>
        toast[kind](
          (item) => (
            <AppNotification
              message={t(key, { id: appName })}
              event={event}
              urn={appUrn}
              path={path}
              addresses={userSettings}
              onDismiss={() => toast.dismiss(item.id)}
            />
          ),
          { duration: kind === 'error' ? 10_000 : 7000 },
        );

      refresh(appUrn, event !== 'status_change');

      if (appStoreId === '_user' && event === 'uninstall_success' && location.pathname === `/apps/${appName}`) {
        navigate('/apps', { replace: true });
      }

      switch (event) {
        case 'status_change':
          break;
        case 'install_success':
          notify('success', 'APP_INSTALL_SUCCESS');
          break;
        case 'install_error':
          notify('error', 'APP_ERROR_APP_FAILED_TO_INSTALL');
          break;
        case 'start_success':
          notify('success', 'APP_START_SUCCESS');
          break;
        case 'start_error':
          notify('error', 'APP_ERROR_APP_FAILED_TO_START');
          break;
        case 'stop_success':
          notify('success', 'APP_STOP_SUCCESS');
          break;
        case 'stop_error':
          notify('error', 'APP_ERROR_APP_FAILED_TO_STOP');
          break;
        case 'uninstall_success':
          notify('success', 'APP_UNINSTALL_SUCCESS');
          break;
        case 'uninstall_error':
          notify('error', 'APP_ERROR_APP_FAILED_TO_UNINSTALL');
          break;
        case 'update_success':
          notify('success', 'APP_UPDATE_SUCCESS');
          break;
        case 'update_error':
          notify('error', 'APP_ERROR_APP_FAILED_TO_UPDATE');
          break;
        case 'reset_success':
          notify('success', 'APP_RESET_SUCCESS');
          break;
        case 'reset_error':
          notify('error', 'APP_ERROR_APP_FAILED_TO_RESET');
          break;
        case 'restart_success':
          notify('success', 'APP_RESTART_SUCCESS');
          break;
        case 'restart_error':
          notify('error', 'APP_ERROR_APP_FAILED_TO_RESTART');
          break;
        case 'backup_success':
          notify('success', 'APP_BACKUP_SUCCESS');
          break;
        case 'backup_error':
          notify('error', 'APP_BACKUP_ERROR');
          break;
        case 'restore_success':
          notify('success', 'APP_RESTORE_SUCCESS');
          break;
        case 'restore_error':
          notify('error', 'APP_RESTORE_ERROR');
          break;
        default:
          break;
      }
    },
  });

  useBrowserPresence(streamStatus !== 'connected');
  return children;
};
