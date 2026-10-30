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
import { useTasks } from '@/desktop/tasks';
import type { TaskRecord } from '@runtipi/common/schemas';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InstallForm, type FormValues, type InstallFormValidationHandle } from '../install-form/install-form';
import { installationState, isMediaPlayer, mediaApps, mediaPlan, type MediaApp, type MediaPlayer } from './store-curation';
import './store-stack-review.css';

const privateInstallDefaults = { openPort: false, exposed: false, exposedLocal: false };
type ReviewStep = 'select' | 'configure';
type Progress = {
  status: 'submitting' | 'accepted' | 'uncertain' | 'needs-check' | 'ready' | 'busy';
  requestId?: string;
  error?: string;
  retryAllowed?: boolean;
  taskStatus?: TaskRecord['status'];
};

type InstallFence = { state: 'uncertain' } | { state: 'accepted'; requestId: string };
export const stackInstallFenceKey = (accountId: number, serverOrigin: string) =>
  `orbis.store-stack-install-fences.v1:${encodeURIComponent(serverOrigin)}:${accountId}`;

const currentFenceKey = (accountId: number) => stackInstallFenceKey(accountId, globalThis.location?.origin ?? 'server-render');
let installFenceReadFailed = false;

const hasUsableInstallFenceStorage = () => {
  try {
    return !installFenceReadFailed && canPersistStackInstallFence(globalThis.sessionStorage);
  } catch {
    return false;
  }
};

export const canPersistStackInstallFence = (storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined) => {
  if (!storage) return false;
  try {
    const probeKey = 'orbis.store-stack-install-fences.probe';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
};

export const reconcileStackInstall = (
  appUrn: string,
  fence: InstallFence | undefined,
  task: TaskRecord | undefined,
  appState: 'missing' | 'busy' | 'ready',
) => {
  if (appState === 'ready') return { status: 'ready' } satisfies Progress;
  if (appState === 'busy') return { status: 'busy', ...(fence?.state === 'accepted' ? { requestId: fence.requestId } : {}) } satisfies Progress;
  if (!fence) return { status: 'needs-check', error: 'No install request is pending for this app.' } satisfies Progress;
  if (fence.state === 'uncertain') {
    return { status: 'uncertain', error: 'The request outcome is unknown. Check Tasks; do not submit it again.' } satisfies Progress;
  }
  if (!task || task.id !== fence.requestId || task.appUrn !== appUrn || task.action !== 'install') {
    return { status: 'accepted', requestId: fence.requestId, error: 'Waiting for the exact install task to appear in Tasks.' } satisfies Progress;
  }
  if (task.status === 'queued' || task.status === 'running')
    return { status: 'accepted', requestId: fence.requestId, taskStatus: task.status } satisfies Progress;
  if (task.status === 'failed') {
    return {
      status: 'needs-check',
      requestId: fence.requestId,
      taskStatus: 'failed',
      retryAllowed: true,
      error: 'The install task failed. The app is still missing; review the configuration and retry.',
    } satisfies Progress;
  }
  return {
    status: 'needs-check',
    requestId: fence.requestId,
    taskStatus: task.status,
    error:
      task.status === 'succeeded'
        ? 'The task completed, but the app is still missing. Check the app and Tasks before continuing.'
        : 'The task outcome is not definitive. Check the app and Tasks before continuing.',
  } satisfies Progress;
};

export const hasPendingStackOperation = (appUrn: string, tasks: readonly TaskRecord[]) =>
  tasks.some((record) => record.appUrn === appUrn && ['queued', 'running', 'unconfirmed', 'interrupted'].includes(record.status));

export const canRetryStackInstall = (
  appUrn: string,
  fence: InstallFence | undefined,
  task: TaskRecord | undefined,
  appState: 'missing' | 'busy' | 'ready',
  isOperator: boolean,
  tasks: readonly TaskRecord[],
) =>
  isOperator &&
  appState === 'missing' &&
  fence?.state === 'accepted' &&
  task?.id === fence.requestId &&
  task.appUrn === appUrn &&
  task.action === 'install' &&
  task.status === 'failed' &&
  !hasPendingStackOperation(appUrn, tasks);

export const stackFormRemainsMounted = (appState: 'missing' | 'busy' | 'ready', localStatus: Progress['status'] | undefined) =>
  appState === 'missing' || (appState === 'busy' && ['submitting', 'accepted', 'uncertain', 'needs-check', 'busy'].includes(localStatus ?? ''));

const readInstallFences = (accountId: number): Record<string, InstallFence> => {
  try {
    const raw = globalThis.sessionStorage?.getItem(currentFenceKey(accountId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      installFenceReadFailed = true;
      return {};
    }
    const entries = Object.entries(parsed);
    const safeEntries = entries.filter(([, value]) => {
      if (!value || typeof value !== 'object') return false;
      const entry = value as Partial<InstallFence>;
      return entry.state === 'uncertain' || (entry.state === 'accepted' && typeof entry.requestId === 'string');
    });
    if (safeEntries.length !== entries.length) installFenceReadFailed = true;
    return Object.fromEntries(safeEntries) as Record<string, InstallFence>;
  } catch {
    installFenceReadFailed = true;
    return {};
  }
};

const writeInstallFence = (accountId: number, urn: string, fence: InstallFence) => {
  try {
    const current = readInstallFences(accountId);
    current[urn] = fence;
    if (!globalThis.sessionStorage) return false;
    globalThis.sessionStorage.setItem(currentFenceKey(accountId), JSON.stringify(current));
    return true;
  } catch {
    return false;
  }
};

const removeInstallFence = (accountId: number, urn: string) => {
  try {
    const current = readInstallFences(accountId);
    delete current[urn];
    globalThis.sessionStorage?.setItem(currentFenceKey(accountId), JSON.stringify(current));
  } catch {
    // A failed persistence operation must not weaken the current dialog's in-memory guard.
  }
};

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
  const tasks = useTasks();
  const { t } = useTranslation();
  const [player, setPlayer] = useState<MediaPlayer>(resolved.jellyfin ? 'jellyfin' : resolved.plex ? 'plex' : 'emby');
  const [companions, setCompanions] = useState<MediaApp[]>([]);
  const [client, setClient] = useState<'qbittorrent' | 'transmission' | null>(null);
  const [step, setStep] = useState<ReviewStep>('select');
  const [expandedUrn, setExpandedUrn] = useState<string | null>(null);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [progress, setProgress] = useState<Record<string, Progress>>(() =>
    Object.fromEntries(
      Object.entries(readInstallFences(user.id)).map(([urn, fence]) => [
        urn,
        fence.state === 'accepted'
          ? { status: 'accepted', requestId: fence.requestId }
          : { status: 'uncertain', error: 'The request outcome is unknown. Check Tasks; do not submit it again.' },
      ]),
    ),
  );
  const formRefs = useRef<Record<string, InstallFormValidationHandle | null>>({});
  const submitted = useRef(new Set(Object.keys(readInstallFences(user.id))));
  const batchGuard = useRef(false);
  const fenceStorageAvailable = hasUsableInstallFenceStorage();
  const formId = useId();
  const plan = mediaPlan(existingPlayer ? null : player, companions, resolved, existingClient ? null : client);
  const queryClient = useQueryClient();

  const appDetails = useQueries({
    queries:
      step === 'configure'
        ? plan.map((app) => ({
            ...getAppOptions({ path: { urn: app.urn } }),
            staleTime: 0,
            refetchOnWindowFocus: true,
          }))
        : [],
  });

  const install = useMutation({ ...installAppMutation(), retry: false });

  const close = () => {
    if (!batchSubmitting && !install.isPending) onClose();
  };

  const setAppProgress = (urn: string, next: Progress) => {
    setProgress((previous) => ({ ...previous, [urn]: next }));
  };

  const getStatus = (urn: string, details?: (typeof appDetails)[number]) => {
    const server = installationState(details?.data?.app?.status);
    if (server === 'ready') return 'ready';
    if (server === 'busy') return 'busy';
    if (hasPendingStackOperation(urn, tasks.data?.tasks ?? [])) return 'busy';
    return progress[urn]?.status ?? 'configure';
  };

  const submitValues = (values: FormValues) => ({
    ...values,
    port: values.port ? Number(values.port) : undefined,
    localSubdomain: values.localSubdomain || undefined,
    maxBackups: values.maxBackups !== undefined && Number.isNaN(values.maxBackups) ? undefined : values.maxBackups,
  });

  const sendInstall = async (app: AppInfoSimple, values: FormValues, confirmedRetry = false) => {
    if (!user.operator || !fenceStorageAvailable || (submitted.current.has(app.urn) && !confirmedRetry)) {
      if (!fenceStorageAvailable)
        setAppProgress(app.urn, {
          status: 'needs-check',
          error: 'This browser session cannot safely remember install requests. Enable session storage before installing.',
        });
      return;
    }
    submitted.current.add(app.urn);
    if (!writeInstallFence(user.id, app.urn, { state: 'uncertain' })) {
      submitted.current.delete(app.urn);
      setAppProgress(app.urn, {
        status: 'needs-check',
        error: 'This browser session cannot safely remember install requests. Enable session storage before installing.',
      });
      return;
    }
    setAppProgress(app.urn, { status: 'submitting' });
    try {
      const accepted = await install.mutateAsync({ path: { urn: app.urn }, body: submitValues(values) });
      writeInstallFence(user.id, app.urn, { state: 'accepted', requestId: accepted.requestId });
      setAppProgress(app.urn, { status: 'accepted', requestId: accepted.requestId });
      void queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getAppOptions({ path: { urn: app.urn } }).queryKey });
    } catch (error) {
      const detail = error as Partial<TranslatableError>;
      const message = detail.message ? t(detail.message, detail.intlParams) : 'The install request could not be confirmed.';
      setAppProgress(app.urn, {
        status: 'uncertain',
        error: `${message} The request may still be running. Check Tasks before taking further action.`,
      });
    }
  };

  const installAll = async () => {
    if (!user.operator || !fenceStorageAvailable || batchGuard.current || batchSubmitting || !plan.length || appDetails.length !== plan.length)
      return;
    batchGuard.current = true;
    setBatchSubmitting(true);
    try {
      const [fresh, freshTasks] = await Promise.all([Promise.all(appDetails.map((query) => query.refetch())), tasks.refetch()]);
      if (freshTasks.isError || !freshTasks.data) return;
      const invalidInfo = fresh.findIndex((result) => result.isError || !result.data);
      if (invalidInfo >= 0) {
        const app = plan[invalidInfo];
        if (app) setExpandedUrn(app.urn);
        return;
      }

      const blockedInfo = fresh.findIndex(({ data }) => {
        if (!data) return true;
        if (installationState(data.app?.status) !== 'missing') return false;
        return !data.info.available || data.info.deprecated || data.info.force_expose;
      });
      if (blockedInfo >= 0) {
        const app = plan[blockedInfo];
        if (app) setExpandedUrn(app.urn);
        return;
      }

      const missing: { app: AppInfoSimple; values?: FormValues; index: number }[] = [];
      for (let index = 0; index < plan.length; index += 1) {
        const app = plan[index];
        const result = fresh[index];
        if (!app || !result?.data) continue;
        const details = result.data;
        const state = installationState(details.app?.status);
        if (state === 'ready') {
          setAppProgress(app.urn, { status: 'ready' });
          continue;
        }
        if (state === 'busy') {
          setAppProgress(app.urn, { status: 'busy' });
          continue;
        }
        if (hasPendingStackOperation(app.urn, freshTasks.data.tasks)) continue;
        const prior = progress[app.urn];
        if (prior?.status || submitted.current.has(app.urn)) continue;
        missing.push({ app, index });
      }

      const validation = await Promise.all(missing.map(async (item) => ({ ...item, result: await formRefs.current[item.app.urn]?.validate() })));
      const firstInvalid = validation.find((item) => !item.result?.valid);
      if (firstInvalid) {
        setExpandedUrn(firstInvalid.app.urn);
        requestAnimationFrame(() => formRefs.current[firstInvalid.app.urn]?.focusFirstInvalid());
        return;
      }
      if (!validation.length) return;

      for (const item of validation) {
        if (item.result?.valid) await sendInstall(item.app, item.result.values);
      }
    } finally {
      batchGuard.current = false;
      setBatchSubmitting(false);
    }
  };

  const checkAppStatus = async (app: AppInfoSimple, index: number) => {
    const [result, taskResult] = await Promise.all([appDetails[index]?.refetch(), tasks.refetch()]);
    if (!result || result.isError || !result.data || taskResult.isError || !taskResult.data) {
      setAppProgress(app.urn, { status: 'needs-check', error: 'App status could not be refreshed.' });
      return;
    }
    const state = installationState(result.data.app?.status);
    const fences = readInstallFences(user.id);
    const fence = fences[app.urn];
    if (state === 'missing' && !fence && !submitted.current.has(app.urn) && !hasPendingStackOperation(app.urn, taskResult.data.tasks)) {
      setProgress((previous) => {
        const { [app.urn]: _, ...remaining } = previous;
        return remaining;
      });
      return;
    }
    const task =
      fence?.state === 'accepted' ? taskResult.data.tasks.find((record) => record.id === fence.requestId && record.appUrn === app.urn) : undefined;
    const next = reconcileStackInstall(app.urn, fence, task, state);
    setAppProgress(app.urn, next);
    if (state === 'ready') {
      removeInstallFence(user.id, app.urn);
      submitted.current.add(app.urn);
    }
  };

  const retryInstall = async (app: AppInfoSimple, index: number) => {
    if (!user.operator || batchGuard.current || !progress[app.urn]?.retryAllowed || !progress[app.urn]?.requestId) return;
    batchGuard.current = true;
    setBatchSubmitting(true);
    try {
      const [result, taskResult] = await Promise.all([appDetails[index]?.refetch(), tasks.refetch()]);
      const requestId = progress[app.urn]?.requestId;
      const failedTask = taskResult.data?.tasks.find((record) => record.id === requestId && record.appUrn === app.urn && record.action === 'install');
      const currentFence = readInstallFences(user.id)[app.urn];
      if (
        !result ||
        result.isError ||
        !result.data ||
        taskResult.isError ||
        !taskResult.data ||
        !canRetryStackInstall(app.urn, currentFence, failedTask, installationState(result.data.app?.status), user.operator, taskResult.data.tasks)
      ) {
        if (result?.data && installationState(result.data.app?.status) === 'ready') setAppProgress(app.urn, { status: 'ready' });
        else if (result?.data && installationState(result.data.app?.status) === 'busy') setAppProgress(app.urn, { status: 'busy' });
        return;
      }
      if (!result.data.info.available || result.data.info.deprecated || result.data.info.force_expose) {
        setAppProgress(app.urn, {
          status: 'needs-check',
          error: result.data.info.force_expose
            ? 'This app requires exposure and cannot be installed from this review.'
            : 'This app is no longer available for installation.',
        });
        setExpandedUrn(app.urn);
        return;
      }
      const validation = await formRefs.current[app.urn]?.validate();
      if (!validation?.valid) {
        setExpandedUrn(app.urn);
        requestAnimationFrame(() => formRefs.current[app.urn]?.focusFirstInvalid());
        return;
      }
      setAppProgress(app.urn, { status: 'needs-check' });
      await sendInstall(app, validation.values, true);
    } finally {
      batchGuard.current = false;
      setBatchSubmitting(false);
    }
  };

  const selectableTools = mediaApps.filter((entry) => !isMediaPlayer(entry.id) && !['qbittorrent', 'transmission'].includes(entry.id));
  const hasQueryError = appDetails.some((query) => query.isError || !query.data);
  const hasInstallable = appDetails.some((query, index) => {
    const urn = plan[index]?.urn;
    if (!urn) return false;
    return Boolean(
      query.data &&
        installationState(query.data.app?.status) === 'missing' &&
        !progress[urn]?.status &&
        !submitted.current.has(urn) &&
        !hasPendingStackOperation(urn, tasks.data?.tasks ?? []),
    );
  });
  const canInstall =
    step === 'configure' &&
    user.operator &&
    tasks.isSuccess &&
    !tasks.isError &&
    fenceStorageAvailable &&
    !batchSubmitting &&
    plan.length > 0 &&
    appDetails.length === plan.length &&
    !hasQueryError &&
    hasInstallable &&
    !appDetails.some(
      (query) =>
        query.data &&
        installationState(query.data.app?.status) === 'missing' &&
        (!query.data.info.available || query.data.info.deprecated || query.data.info.force_expose),
    );

  const statusText = (status: string) => {
    switch (status) {
      case 'ready':
        return 'Installed';
      case 'busy':
        return 'Already in progress';
      case 'submitting':
        return 'Submitting';
      case 'accepted':
        return 'Request accepted';
      case 'needs-check':
        return 'Check required';
      case 'loading':
        return 'Loading';
      case 'error':
        return 'Could not load';
      default:
        return 'Configuration';
    }
  };

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent
        className="orbis-store-stack-dialog"
        closeDisabled={batchSubmitting || install.isPending}
        onEscapeKeyDown={(event) => {
          if (batchSubmitting || install.isPending) event.preventDefault();
        }}
      >
        <DialogHeader className="orbis-store-stack-header">
          <DialogTitle>{step === 'select' ? 'Build a media stack' : 'Configure your media stack'}</DialogTitle>
          <DialogDescription>
            {step === 'select'
              ? existingPlayer
                ? `Add library tools or a download client for your installed ${existingPlayer}. Review every selected app’s settings before installing them together.`
                : 'Choose one media player, library tools and a download client. Review every selected app’s settings before installing them together.'
              : 'Configure each selected app below. Install starts only after every selected app is available and every form is valid.'}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea maxheight={600}>
          <div className="orbis-store-stack-body">
            {step === 'select' ? (
              <>
                {existingPlayer ? null : (
                  <>
                    <h3>Media player</h3>
                    <SelectionGroup className="orbis-store-player-choice" role="group" aria-label="Media player">
                      {(['jellyfin', 'plex', 'emby'] as const).map((id) =>
                        resolved[id] ? (
                          <button key={id} type="button" aria-pressed={player === id} onClick={() => setPlayer(id)}>
                            <AppLogo urn={resolved[id]?.urn} size={36} />
                            {resolved[id]?.name}
                          </button>
                        ) : null,
                      )}
                    </SelectionGroup>
                  </>
                )}
                <h3>Library tools</h3>
                <div className="orbis-store-stack-options">
                  {selectableTools.map((entry) => (
                    <div key={entry.id}>
                      <Checkbox
                        className="orbis-store-stack-option"
                        label={
                          <span className="orbis-store-stack-option-copy">
                            <span className="orbis-store-stack-option-title">{resolved[entry.id]?.name ?? entry.name}</span>
                            <span className="orbis-store-stack-option-description">
                              {resolved[entry.id]
                                ? entry.purpose
                                : installedIds.includes(entry.id)
                                  ? 'Already installed.'
                                  : 'Not available in this catalogue.'}
                            </span>
                          </span>
                        }
                        disabled={!resolved[entry.id]}
                        checked={companions.includes(entry.id)}
                        onCheckedChange={(checked) =>
                          setCompanions((previous) =>
                            checked ? (previous.includes(entry.id) ? previous : [...previous, entry.id]) : previous.filter((id) => id !== entry.id),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
                <h3>Download client</h3>
                {existingClient ? (
                  <p>Using your installed {existingClient}. A second download client will not be installed.</p>
                ) : (
                  <SelectionGroup className="orbis-store-player-choice orbis-store-download-choice" role="group" aria-label="Download client">
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
                  Apps install separately. Connect shared folders, permissions, indexers and download clients in each app afterwards.
                </p>
                <p>
                  {plan.length} {plan.length === 1 ? 'app' : 'apps'} selected. Existing installations are kept.
                </p>
              </>
            ) : (
              <>
                {tasks.isError ? (
                  <div className="orbis-store-stack-status" role="alert">
                    <p>Task status could not be loaded. Check it before installing.</p>
                    <Button variant="outline" disabled={tasks.isFetching} onClick={() => void tasks.refetch()}>
                      Try again
                    </Button>
                  </div>
                ) : null}
                {appDetails.some((query) => query.isError) ? (
                  <p className="orbis-store-stack-status" role="alert">
                    Some app requirements could not be loaded. Retry each affected app before installing.
                  </p>
                ) : null}
                {plan.map((app, index) => {
                  const details = appDetails[index];
                  const data = details?.data;
                  const serverState = installationState(data?.app?.status);
                  const local = progress[app.urn];
                  const status = details?.isPending ? 'loading' : details?.isError ? 'error' : getStatus(app.urn, details);
                  const blocked = Boolean(
                    data && serverState === 'missing' && (!data.info.available || data.info.deprecated || data.info.force_expose),
                  );
                  const showForm = Boolean(data && !blocked && stackFormRemainsMounted(serverState, local?.status));
                  const expanded = expandedUrn === app.urn;
                  const sectionId = `${formId}-section-${index}`;
                  return (
                    <section className="orbis-store-stack-app" key={app.urn}>
                      <button
                        className="orbis-store-stack-app-trigger"
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={sectionId}
                        onClick={() => setExpandedUrn(expanded ? null : app.urn)}
                      >
                        <span className="orbis-store-stack-app-title">{app.name}</span>
                        <span className="orbis-store-stack-app-status" data-status={status}>
                          {statusText(status)}
                        </span>
                      </button>
                      <div id={sectionId} className="orbis-store-stack-app-content" hidden={!expanded}>
                        {details?.isPending ? <p aria-live="polite">Loading installation requirements…</p> : null}
                        {details?.isError ? (
                          <div role="alert">
                            <p>Installation requirements could not be loaded.</p>
                            <Button onClick={() => void details.refetch()}>Retry</Button>
                          </div>
                        ) : null}
                        {blocked && data ? (
                          <div role="alert">
                            <p>
                              {data.info.force_expose
                                ? 'This app’s template requires exposure. Review its networking requirements in app details before installing it separately.'
                                : 'This app is unavailable or deprecated. Remove it from this plan before installing.'}
                            </p>
                            <Button variant="outline" onClick={() => setStep('select')}>
                              Change apps
                            </Button>
                          </div>
                        ) : null}
                        {serverState === 'ready' ? <p aria-live="polite">{app.name} is installed and will be kept.</p> : null}
                        {serverState === 'busy' ? (
                          <div aria-live="polite">
                            <p>An operation is already in progress for {app.name}.</p>
                            <Button variant="outline" onClick={() => void checkAppStatus(app, index)}>
                              Refresh status
                            </Button>
                          </div>
                        ) : null}
                        {local?.status === 'submitting' ? <p aria-live="polite">Submitting the installation request…</p> : null}
                        {local?.status === 'accepted' ? (
                          <div aria-live="polite">
                            <p>Installation queued. Check Tasks for progress.</p>
                            <Button variant="outline" onClick={() => void checkAppStatus(app, index)}>
                              Refresh status
                            </Button>
                          </div>
                        ) : null}
                        {local?.status === 'uncertain' ? (
                          <div role="alert">
                            <p>{local.error ?? 'The request outcome is unknown. Check Tasks; do not submit it again.'}</p>
                            <Button variant="outline" onClick={() => void checkAppStatus(app, index)}>
                              Check status
                            </Button>
                          </div>
                        ) : null}
                        {local?.status === 'needs-check' ? (
                          <div role="alert">
                            <p>{local.error ?? 'The request was not confirmed. Refresh status before retrying.'}</p>
                            {local.retryAllowed ? (
                              <Button
                                onClick={() => void retryInstall(app, index)}
                                disabled={!user.operator || batchSubmitting || batchGuard.current}
                              >
                                Retry
                              </Button>
                            ) : (
                              <Button variant="outline" onClick={() => void checkAppStatus(app, index)}>
                                Check app status
                              </Button>
                            )}
                          </div>
                        ) : null}
                        {showForm && data ? (
                          <div hidden={local?.status === 'accepted' || local?.status === 'submitting'}>
                            {data.info.force_pull ? (
                              <p className="orbis-store-stack-note">
                                This app always pulls its configured image tag ({data.info.version}) during installation.
                              </p>
                            ) : null}
                            <InstallForm
                              ref={(handle) => {
                                formRefs.current[app.urn] = handle;
                              }}
                              key={app.urn}
                              formId={`${formId}-${index}`}
                              info={data.info}
                              formFields={data.info.form_fields}
                              initialValues={privateInstallDefaults}
                              onSubmit={() => undefined}
                              loading={batchSubmitting || !user.operator || local?.status === 'accepted' || local?.status === 'submitting'}
                            />
                          </div>
                        ) : null}
                      </div>
                    </section>
                  );
                })}
                {user.operator ? null : <p role="note">An operator account is required to install apps.</p>}
                {fenceStorageAvailable ? null : (
                  <p role="alert">This browser session cannot safely remember install requests. Enable session storage before installing.</p>
                )}
                {hasQueryError ? <p role="note">Install remains disabled until all selected app requirements can be checked.</p> : null}
              </>
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          {step === 'select' ? (
            <Button
              intent="primary"
              onClick={() => {
                setStep('configure');
                setExpandedUrn(plan[0]?.urn ?? null);
              }}
              disabled={!plan.length || !user.operator}
            >
              Continue
            </Button>
          ) : (
            <Button intent="primary" onClick={() => void installAll()} loading={batchSubmitting} disabled={!canInstall}>
              Install {plan.length} {plan.length === 1 ? 'app' : 'apps'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
