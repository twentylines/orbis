import { useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconServer, IconSwitchHorizontal } from '@tabler/icons-react';
import toast from 'react-hot-toast';
import { Trans } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { getInstalledAppsQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { useAppContext } from '@/context/app-context';
import type { AppInfo } from '@/types/app.types';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { InstallForm, type FormValues, type InstallSettings } from '@/modules/app/components/install-form/install-form';
import { InstallFormButtons } from '@/modules/app/components/install-form-buttons/install-form-buttons';
import { clusterRequest, ServerSelector, useCluster } from './cluster';
import { useDesktopPreferences } from './preferences';
import './cluster-install.css';

type InstallContext = {
  info: AppInfo;
  source: { appName: string; storeUrl: string; branch: string };
  installed: boolean;
  settings: InstallSettings;
};
type AcceptedInstall = { accepted: true; urn: string; requestId: string } | { accepted: false; message: string };

export function ClusterInstallDialog({
  urn,
  serverId,
  name,
  isOpen,
  onClose,
}: {
  urn: string;
  serverId: string;
  name: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const cluster = useCluster();
  const { user } = useAppContext();
  const { preferences } = useDesktopPreferences();
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState(serverId);
  const [selecting, setSelecting] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const target = cluster.data?.servers.find((server) => server.id === choice);
  const targetName = target?.local ? preferences.serverName : (target?.name ?? 'Server unavailable');
  const source = useQuery({
    queryKey: ['cluster-install-context', serverId, urn],
    queryFn: () => clusterRequest<InstallContext>(`/servers/${encodeURIComponent(serverId)}/read/install-context?urn=${encodeURIComponent(urn)}`),
    enabled: isOpen,
    staleTime: 0,
    retry: false,
  });
  const mapped = useQuery({
    queryKey: ['cluster-install-target', choice, source.data?.source],
    queryFn: () => {
      const identity = source.data?.source;
      if (!identity) throw new Error('The app’s store could not be identified.');
      return clusterRequest<InstallContext>(`/servers/${encodeURIComponent(choice)}/read/install-context?${new URLSearchParams(identity)}`);
    },
    enabled: isOpen && choice !== serverId && !!source.data && !!target,
    staleTime: 0,
    retry: false,
  });
  const contextQuery = choice === serverId ? source : mapped;
  const context = target ? contextQuery.data : undefined;
  const canInstall =
    user.operator &&
    cluster.data?.role !== 'member' &&
    !!target &&
    !!context &&
    !context.installed &&
    !contextQuery.isFetching &&
    !contextQuery.isError &&
    !source.isError;
  const install = useMutation({
    mutationFn: async (values: FormValues) => {
      if (!canInstall || !context) throw new Error('Choose an available server first.');
      const result = await clusterRequest<AcceptedInstall>(`/servers/${encodeURIComponent(choice)}/command`, 'POST', {
        action: 'install-app',
        payload: {
          urn: context.info.urn,
          form: {
            ...values,
            port: values.port ? Number(values.port) : undefined,
            localSubdomain: values.localSubdomain || undefined,
            maxBackups: Number.isNaN(values.maxBackups) ? undefined : values.maxBackups,
          },
        },
      });
      if (!result.accepted) throw new Error(result.message);
      return result;
    },
    onSuccess: () => {
      toast.success(`Installation started on ${targetName}.`);
      void queryClient.invalidateQueries({ queryKey: ['cluster-server', choice, 'apps'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster-install-context'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster-install-target'] });
      void queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
      onClose();
    },
  });
  const error = install.error ?? source.error ?? contextQuery.error;
  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open && !install.isPending && !selecting) onClose();
        }}
      >
        <DialogContent className="cluster-install-dialog">
          <DialogHeader>
            <DialogTitle>Install {name}</DialogTitle>
          </DialogHeader>
          <ScrollArea maxheight={500}>
            <DialogDescription>
              <div className="cluster-install-target">
                <div>
                  <IconServer size={22} aria-hidden="true" />
                  <span>
                    <small>Install on</small>
                    <strong title={targetName}>{targetName}</strong>
                  </span>
                </div>
                {(cluster.data?.servers.length ?? 0) > 1 && cluster.data?.role !== 'member' ? (
                  <Button ref={opener} type="button" disabled={install.isPending} onClick={() => setSelecting(true)}>
                    <IconSwitchHorizontal size={18} aria-hidden="true" /> Change server
                  </Button>
                ) : null}
              </div>
              {context && !context.installed && user.operator && context.info.force_pull ? (
                <Alert variant="warning">
                  <AlertDescription>
                    <Trans i18nKey="APP_INSTALL_FORM_FORCE_PULL_WARNING" values={{ tag: context.info.version }} components={{ code: <code /> }} />
                  </AlertDescription>
                </Alert>
              ) : null}
              {error ? (
                <div className="cluster-install-error" role="alert">
                  <p>{error.message}</p>
                  <Button
                    type="button"
                    onClick={() => {
                      install.reset();
                      void source.refetch();
                      if (choice !== serverId) void mapped.refetch();
                    }}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              {!context && !error ? <output>Loading this server’s app configuration…</output> : null}
              {user.operator ? (
                cluster.data?.role === 'member' ? (
                  <p>Install apps from the cluster’s admin server.</p>
                ) : context?.installed ? (
                  <p>This app is already installed on {targetName}. Choose another server to install a separate copy.</p>
                ) : context ? (
                  <InstallForm
                    key={`${choice}:${context.info.urn}`}
                    formFields={context.info.form_fields}
                    info={context.info}
                    formId={formId}
                    targetSettings={context.settings}
                    getTargetPort={() => clusterRequest(`/servers/${encodeURIComponent(choice)}/read/install-port`)}
                    loading={install.isPending}
                    onSubmit={(values) => install.mutate(values)}
                  />
                ) : null
              ) : (
                <p>An operator account is required to install apps on paired servers.</p>
              )}
            </DialogDescription>
          </ScrollArea>
          {canInstall ? (
            <DialogFooter>
              <InstallFormButtons loading={install.isPending} formId={formId} />
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
      <ServerSelector
        open={isOpen && selecting}
        onOpenChange={setSelecting}
        selectedId={choice}
        purpose="install"
        returnFocus={() => opener.current}
        onSelect={(id) => {
          if (!install.isPending) {
            setChoice(id);
            install.reset();
          }
        }}
      />
    </>
  );
}
