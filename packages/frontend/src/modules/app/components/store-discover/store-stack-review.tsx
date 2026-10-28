import { getAppOptions, getInstalledAppsQueryKey, installAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { ScrollArea } from '@/components/ui/ScrollArea';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
import { useAppContext } from '@/context/app-context';
import type { AppInfoSimple } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InstallForm, type FormValues } from '../install-form/install-form';
import { installationState, mediaApps, mediaPlan, type MediaApp } from './store-curation';

const privateInstallDefaults = { openPort: false, exposed: false, exposedLocal: false };

export function StoreStackReview({
  resolved,
  existingPlayer,
  existingClient,
  installedIds,
  onClose,
}: {
  resolved: Partial<Record<MediaApp, AppInfoSimple>>;
  existingPlayer?: string;
  existingClient?: string;
  installedIds: string[];
  onClose: () => void;
}) {
  const { user } = useAppContext();
  const { t } = useTranslation();
  const [player, setPlayer] = useState<'jellyfin' | 'plex'>(resolved.jellyfin ? 'jellyfin' : 'plex');
  const [companions, setCompanions] = useState<MediaApp[]>([]);
  const [client, setClient] = useState<'qbittorrent' | 'transmission' | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [requestError, setRequestError] = useState('');
  const submitted = useRef(false);
  const formId = useId();
  const plan = mediaPlan(existingPlayer ? null : player, companions, resolved, existingClient ? null : client);
  const current = step === null ? undefined : plan[step];
  const queryClient = useQueryClient();
  const details = useQuery({
    ...getAppOptions({ path: { urn: current?.urn ?? '' } }),
    enabled: Boolean(current),
    staleTime: 0,
    refetchInterval: (query) =>
      installationState(query.state.data?.app?.status) !== 'ready' && (waiting || installationState(query.state.data?.app?.status) === 'busy')
        ? 2000
        : false,
    refetchOnWindowFocus: waiting,
  });
  const state = installationState(details.data?.app?.status);
  const installed = !details.isFetching && !details.isError && state === 'ready';
  const install = useMutation({
    ...installAppMutation(),
    retry: false,
    onError: (error: TranslatableError) => setRequestError(t(error.message, error.intlParams)),
    onSuccess: async () => {
      setWaiting(true);
      await Promise.all([details.refetch(), queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() })]);
    },
    onSettled: () => {
      submitted.current = false;
    },
  });
  const next = () => {
    setWaiting(false);
    install.reset();
    setRequestError('');
    setStep((previous) => (previous ?? -1) + 1);
  };
  const close = () => {
    if (!install.isPending) onClose();
  };
  const submit = (values: FormValues) => {
    if (
      !current ||
      !user.operator ||
      submitted.current ||
      waiting ||
      install.isPending ||
      install.isError ||
      !details.data ||
      details.isFetching ||
      details.isError ||
      !details.data.info.available ||
      details.data.info.deprecated ||
      details.data.info.force_expose ||
      state !== 'missing'
    )
      return;
    submitted.current = true;
    install.mutate({
      path: { urn: current.urn },
      body: {
        ...values,
        port: values.port ? Number(values.port) : undefined,
        localSubdomain: values.localSubdomain || undefined,
        maxBackups: values.maxBackups !== undefined && Number.isNaN(values.maxBackups) ? undefined : values.maxBackups,
      },
    });
  };
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent
        className="orbis-store-stack-dialog"
        closeDisabled={install.isPending}
        onEscapeKeyDown={(event) => {
          if (install.isPending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {step === null ? 'Build a media stack' : current ? `${step + 1} of ${plan.length} · ${current.name}` : 'Media stack reviewed'}
          </DialogTitle>
          <DialogDescription>
            {step === null
              ? 'Choose one media player and the optional tools you need. Review each app’s ports and configuration before installing it on this server.'
              : current
                ? 'Each installation is separate. Closing this review leaves accepted installations running in Tasks.'
                : 'The selected apps have been reviewed. Their libraries and integrations still need to be configured.'}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea maxheight={520}>
          <div className="orbis-store-stack-body">
            {step === null ? (
              <>
                <h3>Media player</h3>
                {existingPlayer ? (
                  <p>Using your installed {existingPlayer}. A second player will not be installed.</p>
                ) : (
                  <SelectionGroup className="orbis-store-player-choice" role="group" aria-label="Media player">
                    {(['jellyfin', 'plex'] as const).map((id) =>
                      resolved[id] ? (
                        <button key={id} type="button" aria-pressed={player === id} onClick={() => setPlayer(id)}>
                          <AppLogo urn={resolved[id]?.urn} size={36} />
                          {resolved[id]?.name}
                        </button>
                      ) : null,
                    )}
                  </SelectionGroup>
                )}
                <h3>Optional library tools</h3>
                <div className="orbis-store-stack-options">
                  {mediaApps
                    .filter((entry) => !['jellyfin', 'plex', 'qbittorrent', 'transmission'].includes(entry.id))
                    .map((entry) => (
                      <div key={entry.id}>
                        <Checkbox
                          label={resolved[entry.id]?.name ?? entry.name}
                          disabled={!resolved[entry.id]}
                          checked={companions.includes(entry.id)}
                          onCheckedChange={(checked) =>
                            setCompanions((previous) => (checked ? [...previous, entry.id] : previous.filter((id) => id !== entry.id)))
                          }
                        />
                        <p>
                          {resolved[entry.id]
                            ? entry.purpose
                            : installedIds.includes(entry.id)
                              ? 'Already installed.'
                              : 'Not available in this catalogue.'}
                        </p>
                      </div>
                    ))}
                </div>
                <h3>Optional download client</h3>
                {existingClient ? (
                  <p>Using your installed {existingClient}. A second download client will not be installed.</p>
                ) : (
                  <SelectionGroup className="orbis-store-player-choice" role="group" aria-label="Download client">
                    <button type="button" aria-pressed={client === null} onClick={() => setClient(null)}>
                      None
                    </button>
                    {(['qbittorrent', 'transmission'] as const).map((id) =>
                      resolved[id] ? (
                        <button key={id} type="button" aria-pressed={client === id} onClick={() => setClient(id)}>
                          <AppLogo urn={resolved[id]?.urn} size={36} />
                          {resolved[id]?.name}
                        </button>
                      ) : null,
                    )}
                  </SelectionGroup>
                )}
                <p className="orbis-store-stack-note">
                  These apps are installed independently. Set shared media paths, permissions, indexers and API keys in the apps afterwards. Sonarr
                  and Radarr need a configured download client for downloads. Selecting a client installs it without connecting it to the other apps.
                  App templates can publish fixed ports; review their requirements before installation. This review creates no router or firewall
                  rules.
                </p>
                <p>
                  {plan.length} {plan.length === 1 ? 'app' : 'apps'} selected. Existing installations are kept.
                </p>
              </>
            ) : current ? (
              details.isPending ? (
                <p aria-live="polite">Loading installation requirements…</p>
              ) : details.isError ? (
                <div role="alert">
                  <p>Installation requirements could not be loaded.</p>
                  <Button onClick={() => void details.refetch()}>Try again</Button>
                </div>
              ) : details.data ? (
                <>
                  {details.data.info.force_expose ? (
                    <p role="alert">
                      This app’s template requires exposure. Review its networking requirements in app details before installing it separately.
                    </p>
                  ) : details.data.info.deprecated || !details.data.info.available ? (
                    <p role="alert">This app is no longer available for installation. Close the review and update the catalogue.</p>
                  ) : installed ? (
                    <p aria-live="polite">
                      {current.name} is installed{details.data.app?.status === 'stopped' ? ' and stopped' : ''}. Continue when you are ready.
                    </p>
                  ) : waiting || state === 'busy' ? (
                    <div aria-live="polite">
                      <p>
                        {waiting ? 'Installation request accepted.' : 'An operation is already in progress for this app.'} Current state:{' '}
                        {details.data.app?.status ?? 'waiting for the server'}.
                      </p>
                      <p>Review Tasks for progress or errors. The next app will wait for this one.</p>
                    </div>
                  ) : (
                    <>
                      {details.data.info.force_pull ? (
                        <p className="orbis-store-stack-note">
                          This app always pulls its configured image tag ({details.data.info.version}) during installation.
                        </p>
                      ) : null}
                      <InstallForm
                        key={current.urn}
                        formId={formId}
                        info={details.data.info}
                        formFields={details.data.info.form_fields}
                        initialValues={privateInstallDefaults}
                        onSubmit={submit}
                        loading={install.isPending || !user.operator}
                      />
                    </>
                  )}
                  {install.isError ? (
                    <div role="alert">
                      <p>The installation request could not be confirmed. Check Tasks and refresh this app’s status before retrying.</p>
                      {requestError ? <p>{requestError}</p> : null}
                    </div>
                  ) : null}
                  {install.isError ? (
                    <Button
                      onClick={() => {
                        void details.refetch().then((result) => {
                          if (!result.isError) {
                            install.reset();
                            setRequestError('');
                          }
                        });
                      }}
                    >
                      Check app status
                    </Button>
                  ) : null}
                </>
              ) : null
            ) : (
              <p>
                Open each app to finish its setup. No library connections, API credentials, accounts or download services were created by this review.
              </p>
            )}
            {user.operator ? null : <p role="note">An operator account is required to install apps.</p>}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={install.isPending}>
            {current ? 'Close review' : 'Done'}
          </Button>
          {step === null ? (
            <Button intent="primary" onClick={() => setStep(0)} disabled={!plan.length || !user.operator}>
              Review {plan.length} {plan.length === 1 ? 'app' : 'apps'}
            </Button>
          ) : current && installed ? (
            <Button intent="primary" onClick={next}>
              {step + 1 === plan.length ? 'Finish review' : 'Next app'}
            </Button>
          ) : current &&
            details.data &&
            !details.isError &&
            !details.isFetching &&
            state === 'missing' &&
            !waiting &&
            details.data.info.available &&
            !details.data.info.force_expose &&
            !details.data.info.deprecated ? (
            <Button intent="primary" type="submit" form={formId} loading={install.isPending} disabled={!user.operator || install.isError}>
              Install {current.name}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
