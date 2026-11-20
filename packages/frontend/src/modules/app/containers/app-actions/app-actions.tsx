import {
  IconBan,
  IconCircleCheck,
  IconDots,
  IconDownload,
  IconEdit,
  IconEraser,
  IconLockOpen,
  IconLock,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconRotateClockwise,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react';
import type React from 'react';
import { createElement, useRef } from 'react';
import { Button, type ButtonProps } from '@/components/ui/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import './app-actions.css';
import { ignoreAppVersionMutation, startAppMutation, unignoreAppVersionMutation } from '@/api-client/@tanstack/react-query.gen';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { InstallDialog } from '../../components/dialogs/install-dialog/install-dialog';
import { ResetDialog } from '../../components/dialogs/reset-dialog/reset-dialog';
import { RestartDialog } from '../../components/dialogs/restart-dialog/restart-dialog';
import { StopDialog } from '../../components/dialogs/stop-dialog/stop-dialog';
import { UninstallDialog } from '../../components/dialogs/uninstall-dialog/uninstall-dialog';
import { UpdateSettingsDialog } from '../../components/dialogs/update-settings-dialog/update-settings-dialog';
import { TemplateSyncDialog } from '../../components/template-sync-dialog/template-sync-dialog';
import { useAppStatus } from '../../helpers/use-app-status';
import { Tooltip } from 'react-tooltip';
import { appDestinations } from '@/desktop/app-destinations';
import { primaryAppAddress } from '@/desktop/app-opening';
import { DropdownMenuChevron, DropdownMenuSeparator } from '@/components/ui/DropdownMenu/DropdownMenu';
import { useLocation, useNavigate } from 'react-router';
import { useAppLauncher } from '@/desktop/app-launcher';
import { useStorePreview } from '../../pages/store-preview-context';
import { catalogueInstallAllowed } from '../../helpers/catalogue-compatibility';
import { AppSettingsEditor } from '../../components/dialogs/update-settings-dialog/app-settings-editor';

interface IProps {
  app?: AppDetails | null;
  info: AppInfo;
  metadata: AppMetadata;
  localDomain?: string;
  sslPort?: number;
}

interface BtnProps extends ButtonProps {
  IconComponent?: typeof IconDownload;
}

const ActionButton: React.FC<BtnProps> = (props) => {
  const { IconComponent, loading, title, className, ...rest } = props;

  const testId = loading ? 'action-button-loading' : undefined;

  return (
    <Button data-testid={testId} loading={loading} {...rest} className={clsx('action-button', className)}>
      {title}
      {IconComponent && <IconComponent className="ms-1" size={14} />}
    </Button>
  );
};

export const AppActions = ({ app, info, localDomain, metadata, sslPort }: IProps) => {
  const openApp = useAppLauncher();
  const installDisclosure = useDisclosure();
  const stopDisclosure = useDisclosure();
  const restartDisclosure = useDisclosure();
  const updateSettingsDisclosure = useDisclosure();
  const uninstallDisclosure = useDisclosure();
  const resetAppDisclosure = useDisclosure();
  const syncTemplateDisclosure = useDisclosure();

  const { t } = useTranslation();
  const { setOptimisticStatus } = useAppStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const preview = useStorePreview();
  const openingInlineSettings = useRef(false);
  const openSettings = () => {
    if (preview?.openPanel && preview.closePanel) {
      openingInlineSettings.current = true;
      preview.openPanel(`${info.name} settings`, <AppSettingsEditor info={info} config={app?.config ?? {}} onSaved={preview.closePanel} />);
    } else updateSettingsDisclosure.open();
  };

  const destinations = appDestinations(
    { app, info, metadata },
    { localDomain, sslPort },
    typeof window !== 'undefined' ? window.location.hostname : '',
  );
  const preferredAddress = primaryAppAddress(destinations, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  const versionIsIgnored = app?.ignoredVersion === metadata.latestVersion;
  const updateAvailable = Number(app?.version ?? 0) < Number(metadata?.latestVersion || 0);

  const startMutation = useMutation({
    ...startAppMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onMutate: () => {
      setOptimisticStatus('starting', info.urn);
    },
  });

  const ignoreVersionMutation = useMutation({
    ...ignoreAppVersionMutation(),
    onSuccess: () => {
      toast.success(t('APP_ACTION_IGNORE_VERSION_SUCCESS'));
    },
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });

  const unignoreVersionMutation = useMutation({
    ...unignoreAppVersionMutation(),
    onSuccess: () => {
      toast.success(t('APP_ACTION_UNIGNORE_VERSION_SUCCESS'));
    },
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });

  const StartButton = (
    <ActionButton
      key="start"
      IconComponent={IconPlayerPlay}
      onClick={() => startMutation.mutate({ path: { urn: info.urn } })}
      title={t('APP_ACTION_START')}
      intent="success"
    />
  );
  const LoadingButton = <ActionButton key="loading" loading intent="success" title={t('APP_ACTION_LOADING')} />;

  const RemoveListItem = (
    <DropdownMenuItem onClick={uninstallDisclosure.open} key="remove" className="text-danger">
      <IconTrash className="me-2" size={16} />
      {t('APP_ACTION_REMOVE')}
    </DropdownMenuItem>
  );
  const SettingsListItem = (
    <DropdownMenuItem onClick={openSettings} key="settings">
      <IconSettings className="me-2" size={16} />
      {t('APP_ACTION_SETTINGS')}
    </DropdownMenuItem>
  );
  const RestartListItem = (
    <DropdownMenuItem onClick={restartDisclosure.open} key="restart" className="configChanged">
      <IconRotateClockwise className="me-2" size={16} />
      {t('APP_ACTION_RESTART')}
      {app?.pendingRestart && (
        <div>
          <Tooltip className="tooltip" anchorSelect=".configChanged">
            {t('MY_APPS_PENDING_RESTART')}
          </Tooltip>
          <span className="ms-2 badge bg-red" />
        </div>
      )}
    </DropdownMenuItem>
  );
  const UpdateListItem = (
    <DropdownMenuItem
      onClick={() =>
        navigate(
          `${location.pathname.startsWith('/app-store/') ? '/app-store' : '/apps'}/${encodeURIComponent(info.urn.split(':')[1] ?? '')}/${encodeURIComponent(info.id)}/update`,
          { state: { from: location.pathname } },
        )
      }
      key="update"
      className="updateAvailable"
    >
      <IconDownload className="me-2" size={16} />
      <Tooltip className="tooltip" anchorSelect=".updateAvailable">
        {t('MY_APPS_UPDATE_AVAILABLE')}
      </Tooltip>
      <div>
        {t('APP_ACTION_UPDATE')}
        <span className="ms-2 badge bg-red" />
      </div>
    </DropdownMenuItem>
  );
  const IgnoreVersionListItem = (
    <DropdownMenuItem
      onClick={() => ignoreVersionMutation.mutate({ path: { urn: info.urn } })}
      key="ignore-version"
      disabled={ignoreVersionMutation.isPending}
    >
      <IconBan className="me-2" size={16} />
      {t('APP_ACTION_IGNORE_VERSION')}
    </DropdownMenuItem>
  );
  const UnignoreVersionListItem = (
    <DropdownMenuItem
      onClick={() => unignoreVersionMutation.mutate({ path: { urn: info.urn } })}
      key="unignore-version"
      disabled={unignoreVersionMutation.isPending}
    >
      <IconCircleCheck className="me-2" size={16} />
      {t('APP_ACTION_UNIGNORE_VERSION')}
    </DropdownMenuItem>
  );
  const CancelListItem = (
    <DropdownMenuItem onClick={stopDisclosure.open} key="cancel">
      <IconPlayerPause className="me-2" size={16} />
      {t('APP_ACTION_CANCEL')}
    </DropdownMenuItem>
  );
  const ResetListItem = (
    <DropdownMenuItem onClick={resetAppDisclosure.open} key="reset" className="text-danger">
      <IconEraser className="me-2" size={16} />
      {t('APP_INSTALL_FORM_RESET')}
    </DropdownMenuItem>
  );

  const storeId = info.urn.split(':')[1];
  const isCustomApp = storeId === '_user';
  const editPath = isCustomApp ? `/apps/${info.id}/edit` : `/apps/${storeId}/${info.id}/edit`;

  const EditConfigListItem = (
    <DropdownMenuItem onClick={() => navigate(editPath)} key="edit-config" disabled={app?.status !== 'stopped' && app?.status !== 'missing'}>
      <IconEdit className="me-2" size={16} />
      {t('APP_EDIT_CONFIG')}
    </DropdownMenuItem>
  );

  const SyncTemplateListItem = (
    <DropdownMenuItem onClick={syncTemplateDisclosure.open} key="sync-template">
      <IconRefresh className="me-2" size={16} />
      {t('APP_SYNC_WITH_TEMPLATE')}
    </DropdownMenuItem>
  );

  const StopButton = (
    <ActionButton key="stop" IconComponent={IconPlayerPause} onClick={stopDisclosure.open} title={t('APP_ACTION_STOP')} intent="default" />
  );
  const InstallButton = (
    <ActionButton
      key="install"
      disabled={!catalogueInstallAllowed(info)}
      onClick={installDisclosure.open}
      title={t('APP_ACTION_INSTALL')}
      intent="success"
    />
  );

  const OpenButton = (
    <div className="app-launch-actions" key="open">
      <Button
        className="action-button app-launch-button"
        disabled={!preferredAddress}
        onClick={() => preferredAddress && handleOpen(preferredAddress)}
      >
        {t('APP_ACTION_OPEN')}
      </Button>
      {destinations.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="action-button app-address-button" aria-label={`Choose address for ${info.name}`}>
              <DropdownMenuChevron />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {destinations.map(({ label, url }) => (
                <DropdownMenuItem key={url} onClick={() => handleOpen(url)}>
                  {url.startsWith('https:') ? (
                    <IconLock className="me-2" size={16} aria-hidden="true" />
                  ) : (
                    <IconLockOpen className="me-2" size={16} aria-hidden="true" />
                  )}
                  <span>
                    {label}: {new URL(url).host}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );

  const buttons: React.JSX.Element[] = [];
  const listItems: React.JSX.Element[] = [];
  const listItemsAdvanced: React.JSX.Element[] = [];
  const listItemsDestructive: React.JSX.Element[] = [];

  switch (app?.status ?? 'missing') {
    case 'stopped':
      buttons.push(StartButton);
      listItems.push(SettingsListItem);
      listItemsAdvanced.push(EditConfigListItem);
      if (app && (app.templateUrn || !isCustomApp)) {
        listItemsAdvanced.push(SyncTemplateListItem);
      }
      listItemsDestructive.push(ResetListItem);
      listItemsDestructive.push(RemoveListItem);
      if (updateAvailable && !versionIsIgnored) {
        listItems.push(UpdateListItem);
        listItems.push(IgnoreVersionListItem);
      } else if (versionIsIgnored) {
        listItems.push(UnignoreVersionListItem);
      }
      break;
    case 'running':
      buttons.push(StopButton);
      listItems.push(SettingsListItem);
      listItems.push(RestartListItem);
      listItemsAdvanced.push(EditConfigListItem);
      if (app && (app.templateUrn || !isCustomApp)) {
        listItemsAdvanced.push(SyncTemplateListItem);
      }
      listItemsDestructive.push(ResetListItem);
      listItemsDestructive.push(RemoveListItem);

      if (destinations.length > 0) {
        buttons.unshift(OpenButton);
      }

      if (updateAvailable && !versionIsIgnored) {
        listItems.push(UpdateListItem);
        listItems.push(IgnoreVersionListItem);
      } else if (versionIsIgnored) {
        listItems.push(UnignoreVersionListItem);
      }
      break;
    case 'installing':
    case 'uninstalling':
    case 'starting':
    case 'stopping':
    case 'restarting':
    case 'updating':
    case 'resetting':
    case 'backing_up':
    case 'restoring':
      buttons.push(LoadingButton);
      listItems.push(CancelListItem);
      break;
    case 'missing':
      buttons.push(InstallButton);
      if (info.urn.split(':')[1] === '_user') {
        listItemsDestructive.push(RemoveListItem);
      }
      break;
    default:
      break;
  }

  function handleOpen(url: string) {
    if (!openApp({ urn: info.urn, name: info.name, categories: info.categories, preferredUrl: url }))
      window.open(url, '_blank', 'noopener,noreferrer');
  }

  return (
    <>
      <InstallDialog isOpen={installDisclosure.isOpen} onClose={installDisclosure.close} info={info} />
      <StopDialog isOpen={stopDisclosure.isOpen} onClose={stopDisclosure.close} info={info} />
      <RestartDialog isOpen={restartDisclosure.isOpen} onClose={restartDisclosure.close} info={info} />
      <UninstallDialog isOpen={uninstallDisclosure.isOpen} onClose={uninstallDisclosure.close} info={info} />
      <ResetDialog isOpen={resetAppDisclosure.isOpen} onClose={resetAppDisclosure.close} info={info} />
      <UpdateSettingsDialog
        isOpen={updateSettingsDisclosure.isOpen}
        onClose={updateSettingsDisclosure.close}
        info={info}
        config={app?.config ?? {}}
      />
      <TemplateSyncDialog appUrn={info.urn} isOpen={syncTemplateDisclosure.isOpen} onClose={syncTemplateDisclosure.close} />
      <fieldset className="app-actions" aria-label="Application actions" tabIndex={-1} data-dialog-focus-fallback>
        <div className="app-actions-primary">
          {buttons.map((button) => {
            return createElement(button.type, {
              ...button.props,
              key: button.key,
            });
          })}
        </div>
        {listItems.length + listItemsAdvanced.length + listItemsDestructive.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button name="more" className="more-button" aria-label="More application actions" title="More application actions">
                <IconDots size={14} />
                {((updateAvailable && !versionIsIgnored) || app?.pendingRestart) && <span className="app-action-notice" aria-hidden="true" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (!openingInlineSettings.current) return;
                openingInlineSettings.current = false;
                event.preventDefault();
                requestAnimationFrame(() => document.querySelector<HTMLElement>('.app-settings-preview > h2')?.focus({ preventScroll: true }));
              }}
            >
              <DropdownMenuGroup>{listItems}</DropdownMenuGroup>
              {listItemsAdvanced.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>{listItemsAdvanced}</DropdownMenuGroup>
              {listItemsDestructive.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>{listItemsDestructive}</DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </fieldset>
    </>
  );
};
