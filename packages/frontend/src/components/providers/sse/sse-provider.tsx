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

const announcePreferences = () => window.dispatchEvent(new Event(preferenceChangeEvent));

export const SSEProvider = ({ children }: PropsWithChildren) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
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

      refresh(appUrn, event !== 'status_change');

      if (appStoreId === '_user' && event === 'uninstall_success' && location.pathname === `/apps/${appName}`) {
        navigate('/apps', { replace: true });
      }

      switch (event) {
        case 'status_change':
          break;
        case 'install_success':
          toast.success(t('APP_INSTALL_SUCCESS', { id: appName }));
          break;
        case 'install_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_INSTALL', { id: appName }));
          break;
        case 'start_success':
          toast.success(t('APP_START_SUCCESS', { id: appName }));
          break;
        case 'start_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_START', { id: appName }));
          break;
        case 'stop_success':
          toast.success(t('APP_STOP_SUCCESS', { id: appName }));
          break;
        case 'stop_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_STOP', { id: appName }));
          break;
        case 'uninstall_success':
          toast.success(t('APP_UNINSTALL_SUCCESS', { id: appName }));
          break;
        case 'uninstall_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_UNINSTALL', { id: appName }));
          break;
        case 'update_success':
          toast.success(t('APP_UPDATE_SUCCESS', { id: appName }));
          break;
        case 'update_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_UPDATE', { id: appName }));
          break;
        case 'reset_success':
          toast.success(t('APP_RESET_SUCCESS', { id: appName }));
          break;
        case 'reset_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_RESET', { id: appName }));
          break;
        case 'restart_success':
          toast.success(t('APP_RESTART_SUCCESS', { id: appName }));
          break;
        case 'restart_error':
          toast.error(t('APP_ERROR_APP_FAILED_TO_RESTART', { id: appName }));
          break;
        case 'backup_success':
          toast.success(t('APP_BACKUP_SUCCESS', { id: appName }));
          break;
        case 'backup_error':
          toast.error(t('APP_BACKUP_ERROR', { id: appName }));
          break;
        case 'restore_success':
          toast.success(t('APP_RESTORE_SUCCESS', { id: appName }));
          break;
        case 'restore_error':
          toast.error(t('APP_RESTORE_ERROR', { id: appName }));
          break;
        default:
          break;
      }
    },
  });

  useBrowserPresence(streamStatus !== 'connected');
  return children;
};
