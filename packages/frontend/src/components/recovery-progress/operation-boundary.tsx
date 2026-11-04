import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useLocation, useNavigate, useRevalidator } from 'react-router';
import { useWindowVisible } from '@/desktop/window-visibility';
import { observeCoreOperationProgress, readCoreOperationProgress } from '@/desktop/core-operation-progress';
import { backupRequest } from '@/modules/system-backups/backup-api';
import { restoreStatusSchema, type RestoreJob } from '@/modules/system-backups/contracts';
import {
  advanceCoreUpdate,
  coreJobIsActive,
  resumeCoreUpdate,
  validCoreUpdate,
  type CoreUpdateStatus,
  type CoreUpdateWatch,
} from '@/desktop/core-update-state';
import { OperationStartupContext } from '@/components/startup/operation-startup';
import { StartupSurface } from '@/components/startup/startup-surface';
import { RecoveryScene } from './recovery-scene';
import { UpdateDownloadProgress } from './update-download-progress';
import {
  armStartedOperation,
  clearMatchingRestoreContinuity,
  readOperationContinuity,
  operationBootMarker,
  rememberCoreOperation,
  operationContinuityStorage,
  type MaintenanceOperation,
} from './operation-continuity';
import { useOperationDeparture } from './use-operation-departure';
import { restorePresentation } from './restore-presentation';
import {
  confirmResetSnapshot,
  hasAcceptedReset,
  loadOperationStatus,
  operationAllowsDeparture,
  operationBootIsReady,
  operationIsWaiting,
  readOperationStatus,
  operationShowsContent,
  operationUsesSpace,
  resetSceneVisible,
  rollbackCanContinue,
  type OperationSnapshot,
} from './operation-status';
import { SystemResetWizard } from '@/modules/system-reset/system-reset';
import { openResetOnboarding } from '@/modules/system-reset/reset-completion';

const stageCopy = {
  preparing: 'Preparing',
  downloading: 'Downloading files',
  applying: 'Installing release',
  restarting: 'Restarting',
  verifying: 'Verifying release',
  restoring: 'Restoring your server',
  recovering: 'Recovering the previous state',
  resetting: 'Resetting preferences',
} as const;
class OperationSignInRequired extends Error {}
async function readCoreStatus() {
  const options: RequestInit = { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) };
  const [statusResponse, buildResponse] = await Promise.all([fetch('/api/host-updates/status', options), fetch('/api/system/build', options)]);
  if (statusResponse.status === 401 || buildResponse.status === 401) throw new OperationSignInRequired();
  if (!statusResponse.ok || !buildResponse.ok) throw new Error('Operation status is unavailable.');
  const status: CoreUpdateStatus = await statusResponse.json();
  const build: { version?: string } = await buildResponse.json();
  if (!status || typeof status.available !== 'boolean' || (status.job && !validCoreUpdate(status.job.id, status.job.targetTag)))
    throw new Error('Operation status is unavailable.');
  return { status, buildTag: typeof build?.version === 'string' ? build.version : undefined };
}
export function OperationBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const released = useRef(false);
  const visible = useWindowVisible();
  const [snapshot, setSnapshot] = useState<OperationSnapshot | null>(null);
  const [job, setJob] = useState<RestoreJob | null>(null);
  const [core, setCore] = useState<CoreUpdateWatch | null>(null);
  const coreRef = useRef<CoreUpdateWatch | null>(null);
  const operation = useRef<MaintenanceOperation | null>(null);
  const initialMarker = useRef(
    (() => {
      const storage = operationContinuityStorage();
      return storage
        ? operationBootMarker(readOperationContinuity(storage), document.documentElement.getAttribute('data-orbis-operation-boot'))
        : null;
    })(),
  );
  const [attempt, setAttempt] = useState(0);
  const [signInRequired, setSignInRequired] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [authAction, setAuthAction] = useState<'recover' | 'cancel' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const observed = useRef(Boolean(initialMarker.current));
  const observedReset = useRef(hasAcceptedReset());
  const [resetRecovery, setResetRecovery] = useState(false);
  const startedId = useRef<string | null>(null);
  const activeKind =
    snapshot?.operation ??
    (snapshot?.state === 'restoring'
      ? 'restore'
      : snapshot?.state === 'updating'
        ? 'update'
        : snapshot?.state === 'downgrading'
          ? 'downgrade'
          : operation.current);
  const operationJob = useMemo(
    () =>
      activeKind === 'restore' && job
        ? { id: job.id, operation: 'restore' as const, status: job.status, needsRecovery: job.needsRecovery }
        : core && (activeKind === 'update' || activeKind === 'downgrade')
          ? {
              id: core.id,
              operation: core.operation ?? 'update',
              status:
                core.phase === 'ready'
                  ? 'succeeded'
                  : core.phase === 'returned'
                    ? 'returned'
                    : core.phase === 'failed'
                      ? 'recovery-required'
                      : 'running',
              needsRecovery: core.phase === 'failed',
            }
          : null,
    [job, core, activeKind],
  );
  const bootReady = operationBootIsReady(initialMarker.current, operationJob, snapshot);
  const continuity = useOperationDeparture(
    operationJob?.status === 'rolled-back' ? null : operationJob,
    bootReady || !snapshot || snapshot.state !== 'idle' || Boolean(snapshot.unavailable),
  );
  useEffect(() => {
    if (!visible) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const shared = await loadOperationStatus(attempt > 0);
      if (!current) return;
      if (shared.state === 'resetting' || hasAcceptedReset()) observedReset.current = true;
      let next = await confirmResetSnapshot(shared, observedReset.current);
      if (!current) return;
      if (next.state === 'resetting') observedReset.current = true;
      if (observedReset.current && next.state === 'idle' && next.supported && !next.unavailable) {
        if (openResetOnboarding(next)) return;
      }
      if (next.state !== 'idle') observed.current = true;
      const storage = operationContinuityStorage();
      const marker = storage ? readOperationContinuity(storage) : null;
      const kind =
        next.operation ??
        (next.state === 'restoring'
          ? 'restore'
          : next.state === 'updating'
            ? 'update'
            : next.state === 'downgrading'
              ? 'downgrade'
              : (operation.current ?? marker?.operation));
      if (kind && operation.current && kind !== operation.current) {
        startedId.current = null;
        coreRef.current = null;
        setCore(null);
        setJob(null);
      }
      if (kind) operation.current = kind;
      if (next.state !== 'idle') setSnapshot(next);
      if (observed.current && kind === 'restore') {
        try {
          const raw = await backupRequest('/restores', 'GET', undefined, AbortSignal.timeout(8000));
          if (!current) return;
          if (!restoreStatusSchema.allows(raw)) throw new Error('Restore status is unavailable.');
          const confirmed = raw.job;
          if (confirmed && marker?.jobId === confirmed.id && marker.operation === 'restore' && ['running', 'departing'].includes(marker.phase))
            startedId.current = confirmed.id;
          if (confirmed?.status === 'running' && !confirmed.needsRecovery && storage && armStartedOperation(confirmed.id, 'restore', storage))
            startedId.current = confirmed.id;
          if (
            next.state === 'idle' &&
            (!operationAllowsDeparture(next) ||
              !confirmed ||
              confirmed.id !== startedId.current ||
              confirmed.needsRecovery ||
              !['succeeded', 'rolled-back'].includes(confirmed.status))
          )
            next = { state: 'checking', supported: true, unavailable: true };
          setJob(confirmed);
        } catch {
          if (current && next.state === 'idle') {
            setJob(null);
            next = { state: 'checking', supported: true, unavailable: true };
          }
        }
      } else if (observed.current && (kind === 'update' || kind === 'downgrade')) {
        try {
          const { status, buildTag } = await readCoreStatus();
          if (!current) return;
          setSignInRequired(false);
          let watch = coreRef.current ?? resumeCoreUpdate(marker);
          if (watch && marker?.jobId === watch.id && marker.operation === kind) startedId.current = watch.id;
          if (status.job && coreJobIsActive(status.job) && watch?.id !== status.job.id) watch = null;
          if (!watch && marker?.operation === kind && marker.jobId === status.job?.id && validCoreUpdate(status.job.id, status.job.targetTag)) {
            watch = advanceCoreUpdate(null, { type: 'accepted', id: status.job.id, targetTag: status.job.targetTag, operation: kind });
            startedId.current = status.job.id;
          }
          watch = advanceCoreUpdate(watch, { type: 'status', status, buildTag });
          if (watch) watch = { ...watch, operation: kind };
          if (status.job && coreJobIsActive(status.job) && watch) {
            startedId.current = status.job.id;
            if (storage && (!marker || marker.jobId !== watch.id)) armStartedOperation(watch.id, kind, storage, Date.now(), watch.targetTag);
          }
          if (watch && storage) rememberCoreOperation(watch, storage);
          if (next.state === 'idle' && watch && ['ready', 'returned'].includes(watch.phase)) {
            next = await loadOperationStatus(true);
            if (!current) return;
          }
          if (
            next.state === 'idle' &&
            (!operationAllowsDeparture(next) || !watch || watch.id !== startedId.current || !['ready', 'returned'].includes(watch.phase))
          )
            next = watch?.phase === 'failed' ? { state: 'recovery', supported: true } : { state: 'checking', supported: true, unavailable: true };
          coreRef.current = watch;
          setCore(watch);
        } catch (error) {
          if (current) {
            let watch = coreRef.current ?? resumeCoreUpdate(marker);
            if (!(error instanceof OperationSignInRequired)) {
              try {
                watch = observeCoreOperationProgress(watch, await readCoreOperationProgress());
                if (!current) return;
                if (watch) {
                  watch = { ...watch, operation: kind };
                  if (storage) {
                    if (!marker || marker.jobId !== watch.id) armStartedOperation(watch.id, kind, storage, Date.now(), watch.targetTag);
                    rememberCoreOperation(watch, storage);
                  }
                  startedId.current = watch.id;
                }
              } catch {
                // Keep the last confirmed phase when the independent helper is unreachable.
              }
            }
            if (!current) return;
            coreRef.current = watch;
            setCore(watch);
            const needsSignIn = error instanceof OperationSignInRequired && operationAllowsDeparture(next);
            setSignInRequired(needsSignIn);
            if (next.state === 'idle' && !needsSignIn) next = { state: 'checking', supported: true, unavailable: true };
          }
        }
      }
      if (!current) return;
      setSnapshot(next);
      timer = setTimeout(check, next.state === 'idle' ? 3000 : 1500);
    };
    void check();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [visible, attempt]);
  const authRoute = pathname === '/login' || pathname === '/reset-password';
  useEffect(() => {
    if (signInRequired && snapshot && operationAllowsDeparture(snapshot) && !authRoute) void navigate('/', { replace: true });
  }, [signInRequired, snapshot, authRoute, navigate]);
  useEffect(() => {
    if (snapshot?.state !== 'idle') {
      released.current = false;
      return;
    }
    if (job?.status === 'rolled-back') return;
    if (observed.current && !released.current) {
      released.current = true;
      void revalidator.revalidate();
    }
  }, [snapshot?.state, job?.status, revalidator]);
  const requestAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!job || actionBusy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = values.get('password');
    const code = values.get('totpCode');
    const kind = authAction;
    if (kind !== 'recover' && kind !== 'cancel') return;
    if ((kind === 'recover' && !job.canRecover) || (kind === 'cancel' && !job.canCancel)) return;
    if (typeof password !== 'string' || !password || password.length > 1024 || (code && (typeof code !== 'string' || !/^\d{6}$/.test(code)))) {
      setActionError('Enter your current account password and authentication code if enabled.');
      return;
    }
    setActionBusy(true);
    setActionError(null);
    form.reset();
    try {
      await backupRequest(`/restores/${job.id}/${kind}`, 'POST', { password, ...(code ? { totpCode: code } : {}) });
      setAuthAction(null);
      setAttempt((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The request could not be confirmed. Check status before retrying.');
    } finally {
      setActionBusy(false);
    }
  };
  const continueRollback = async () => {
    if (!job || job.status !== 'rolled-back' || job.needsRecovery || job.id !== startedId.current || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const raw = await backupRequest('/restores', 'GET', undefined, AbortSignal.timeout(8000));
      if (!restoreStatusSchema.allows(raw) || raw.job?.id !== job.id || raw.job.status !== 'rolled-back' || raw.job.needsRecovery)
        throw new Error('The restore result could not be confirmed. Check again.');
      const fresh = await readOperationStatus();
      if (!rollbackCanContinue(raw.job, startedId.current, fresh)) throw new Error('The server is still checking the restore. Try again.');
      const storage = operationContinuityStorage();
      if (!storage || !clearMatchingRestoreContinuity(job.id, storage)) throw new Error('The restore marker could not be confirmed. Check again.');
      initialMarker.current = null;
      operation.current = null;
      startedId.current = null;
      observed.current = false;
      setJob(null);
      setSnapshot(fresh);
      setAttempt((value) => value + 1);
      void revalidator.revalidate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The restore result could not be confirmed. Check again.');
    } finally {
      setActionBusy(false);
    }
  };
  const matchingTerminal = Boolean(
    operationJob &&
      operationJob.id === startedId.current &&
      !operationJob.needsRecovery &&
      ['succeeded', 'rolled-back', 'returned'].includes(operationJob.status),
  );
  const showChildren =
    (signInRequired && authRoute && snapshot && operationAllowsDeparture(snapshot)) ||
    (!signInRequired && operationShowsContent(snapshot, authRoute, matchingTerminal && !bootReady, continuity.departing));
  const server = snapshot ?? { state: 'checking' as const, supported: true };
  const waiting = operationIsWaiting(server);
  const useSpace = operationUsesSpace(snapshot, Boolean(operation.current ?? initialMarker.current?.operation));
  const kind = operation.current ?? 'restore';
  const restoration = kind === 'restore' && job && server.state === 'idle' && matchingTerminal ? restorePresentation(job, false) : undefined;
  const coreStage =
    core?.phase === 'downloading'
      ? 'Downloading files'
      : core?.phase === 'offline'
        ? 'Restarting Orbis'
        : core?.phase === 'checking'
          ? 'Starting Orbis'
          : core?.phase === 'ready' || core?.phase === 'returned'
            ? 'Starting Orbis'
            : 'Installing release';
  const status =
    restoration?.status ??
    (server.state === 'recovery'
      ? 'Operation needs attention'
      : kind !== 'restore' && core
        ? coreStage
        : server.stage
          ? stageCopy[server.stage]
          : server.state === 'restoring'
            ? 'Restoring your server'
            : 'Checking system operation');
  const title =
    restoration?.title ??
    (kind !== 'restore' && core
      ? `Orbis ${core.phase === 'returned' ? core.returnedTag : core.targetTag}`
      : server.state === 'recovery'
        ? 'Recovery needed'
        : kind === 'update'
          ? 'Updating Orbis'
          : kind === 'downgrade'
            ? 'Downgrading Orbis'
            : server.state === 'checking' && !operation.current
              ? 'Checking server'
              : 'Restoring');
  if (resetSceneVisible(snapshot, observedReset.current))
    return (
      <>
        <div className="reset-scene-backdrop" aria-hidden="true" />
        <RecoveryScene
          open={!resetRecovery}
          title={waiting ? 'Waiting for the server to respond' : server.stage === 'recovering' ? 'Reset needs attention' : 'Resetting Orbis'}
          status={waiting ? undefined : server.stage === 'recovering' ? 'Waiting for confirmation' : stageCopy[server.stage ?? 'resetting']}
          active={waiting || server.stage !== 'recovering'}
          variant="onboarding"
          detail={
            waiting
              ? 'Orbis will reload automatically.'
              : server.stage === 'recovering'
                ? 'Confirm the original reset again to continue. Server data stays locked until it finishes.'
                : undefined
          }
          footer="Installed applications and their data are kept."
          actions={
            server.stage === 'recovering' ? (
              <>
                <Button onClick={() => setResetRecovery(true)}>Recover</Button>
                <a className="btn" href="/login">
                  Sign in
                </a>
              </>
            ) : undefined
          }
        />
        <SystemResetWizard open={resetRecovery} recovery onClose={() => setResetRecovery(false)} />
      </>
    );
  return (
    <>
      {showChildren ? (
        <OperationStartupContext.Provider value={observed.current ? operation.current : null}>{children}</OperationStartupContext.Provider>
      ) : snapshot ? null : (
        <StartupSurface initial setupSpace={useSpace} />
      )}
      <RecoveryScene
        open={!showChildren && snapshot !== null}
        title={waiting ? 'Waiting for the server to respond' : title}
        status={waiting || (core?.phase === 'downloading' && core.download) ? undefined : status}
        variant={kind}
        detail={
          waiting
            ? 'Orbis will reload automatically.'
            : (actionError ??
              (core?.phase === 'returned'
                ? core.message
                : job?.status === 'rolled-back'
                  ? 'The restore did not complete. Your previous state was restored.'
                  : undefined))
        }
        progress={core?.phase === 'ready' || core?.phase === 'returned' ? undefined : (restoration?.progress ?? server.progress)}
        progressContent={
          !waiting && kind !== 'restore' && core?.phase === 'downloading' && core.download ? (
            <UpdateDownloadProgress value={core.download} />
          ) : undefined
        }
        active={waiting || ['restoring', 'updating', 'downgrading'].includes(server.state)}
        departing={continuity.departing}
        indicator={
          server.stage === 'restarting' || (core && ['offline', 'checking', 'ready', 'returned'].includes(core.phase)) ? 'restart' : 'progress'
        }
        footer={!waiting && kind !== 'restore' ? 'Applications keep running during this Orbis operation.' : undefined}
        actions={
          waiting ? undefined : (
            <>
              {kind === 'restore' && job?.canRecover ? (
                <Button
                  onClick={() => {
                    setActionError(null);
                    setAuthAction('recover');
                  }}
                >
                  Recover
                </Button>
              ) : null}
              {kind === 'restore' && job?.canCancel ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setActionError(null);
                    setAuthAction('cancel');
                  }}
                >
                  Stop restore
                </Button>
              ) : null}
              {server.unavailable || server.state === 'recovery' ? (
                <Button onClick={() => setAttempt((value) => value + 1)}>Check again</Button>
              ) : null}
              {matchingTerminal && !continuity.departing && job?.status === 'rolled-back' ? (
                <Button disabled={actionBusy} onClick={() => void continueRollback()}>
                  Continue
                </Button>
              ) : null}
            </>
          )
        }
      />
      <Dialog
        open={authAction !== null}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setAuthAction(null);
        }}
      >
        <DialogContent
          size="sm"
          className="operation-auth-dialog"
          closeDisabled={actionBusy}
          onEscapeKeyDown={(event) => {
            if (actionBusy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{authAction === 'cancel' ? 'Stop restore' : 'Recover previous state'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={requestAction}>
            <p>Confirm with your current account password.</p>
            <Input
              label="Current account password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={1024}
              disabled={actionBusy}
            />
            <Input
              label="Authentication code if enabled"
              name="totpCode"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              disabled={actionBusy}
            />
            {actionError ? <p role="alert">{actionError}</p> : null}
            <footer>
              <Button type="button" variant="outline" disabled={actionBusy} onClick={() => setAuthAction(null)}>
                Back
              </Button>
              <Button type="submit" disabled={actionBusy}>
                {authAction === 'cancel' ? 'Stop' : 'Recover'}
              </Button>
            </footer>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
