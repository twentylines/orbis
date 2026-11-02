import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useLocation, useRevalidator } from 'react-router';
import { useWindowVisible } from '@/desktop/window-visibility';
import { backupRequest } from '@/modules/system-backups/backup-api';
import { restoreStatusSchema, type RestoreJob } from '@/modules/system-backups/contracts';
import { advanceCoreUpdate, coreJobIsActive, validCoreUpdate, type CoreUpdateStatus, type CoreUpdateWatch } from '@/desktop/core-update-state';
import { OperationStartupContext } from '@/components/startup/operation-startup';
import { StartupSurface } from '@/components/startup/startup-surface';
import { RecoveryScene } from './recovery-scene';
import { armStartedOperation, readOperationContinuity, operationContinuityStorage, type MaintenanceOperation } from './operation-continuity';
import { useOperationDeparture } from './use-operation-departure';
import { restorePresentation } from './restore-presentation';
import { loadOperationStatus, operationIsWaiting, operationShowsContent, operationUsesSpace, type OperationSnapshot } from './operation-status';
import { openResetOnboarding, SystemResetWizard } from '@/modules/system-reset/system-reset';

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
async function readCoreStatus() {
  const options: RequestInit = { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) };
  const [statusResponse, buildResponse] = await Promise.all([fetch('/api/host-updates/status', options), fetch('/api/system/build', options)]);
  if (!statusResponse.ok || !buildResponse.ok) throw new Error('Operation status is unavailable.');
  const status: CoreUpdateStatus = await statusResponse.json();
  const build: { version?: string } = await buildResponse.json();
  if (!status || typeof status.available !== 'boolean' || (status.job && !validCoreUpdate(status.job.id, status.job.targetTag)))
    throw new Error('Operation status is unavailable.');
  return { status, buildTag: typeof build?.version === 'string' ? build.version : undefined };
}
export function OperationBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
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
      return storage ? readOperationContinuity(storage) : null;
    })(),
  );
  const [attempt, setAttempt] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const [authAction, setAuthAction] = useState<'recover' | 'cancel' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const observed = useRef(false);
  const observedReset = useRef(false);
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
              status: core.phase === 'ready' ? 'succeeded' : core.phase === 'failed' ? 'recovery-required' : 'running',
              needsRecovery: core.phase === 'failed',
            }
          : null,
    [job, core, activeKind],
  );
  const continuity = useOperationDeparture(operationJob, !snapshot || snapshot.state !== 'idle' || Boolean(snapshot.unavailable));
  useEffect(() => {
    if (!visible) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const next = await loadOperationStatus(attempt > 0);
      if (!current) return;
      if (next.state === 'resetting') observedReset.current = true;
      if (observedReset.current && next.state === 'idle' && next.supported && !next.unavailable) {
        openResetOnboarding();
        return;
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
          if (restoreStatusSchema.allows(raw)) {
            const confirmed = raw.job;
            if (confirmed && marker?.jobId === confirmed.id && marker.operation === 'restore' && ['running', 'departing'].includes(marker.phase))
              startedId.current = confirmed.id;
            if (confirmed?.status === 'running' && !confirmed.needsRecovery && storage && armStartedOperation(confirmed.id, 'restore', storage))
              startedId.current = confirmed.id;
            setJob(confirmed);
          }
        } catch {
          if (current && next.state === 'idle') setJob(null);
        }
      } else if (observed.current && (kind === 'update' || kind === 'downgrade')) {
        try {
          const { status, buildTag } = await readCoreStatus();
          if (!current) return;
          let watch = coreRef.current;
          if (status.job && coreJobIsActive(status.job) && watch?.id !== status.job.id) watch = null;
          if (!watch && marker?.operation === kind && marker.jobId === status.job?.id && validCoreUpdate(status.job.id, status.job.targetTag)) {
            watch = advanceCoreUpdate(null, { type: 'accepted', id: status.job.id, targetTag: status.job.targetTag, operation: kind });
            startedId.current = status.job.id;
          }
          watch = advanceCoreUpdate(watch, { type: 'status', status, buildTag });
          if (watch) watch = { ...watch, operation: kind };
          if (status.job && coreJobIsActive(status.job) && storage && armStartedOperation(status.job.id, kind, storage))
            startedId.current = status.job.id;
          coreRef.current = watch;
          setCore(watch);
        } catch {
          if (current && next.state === 'idle') setCore(null);
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
  useEffect(() => {
    if (snapshot?.state !== 'idle') {
      released.current = false;
      return;
    }
    if (observed.current && !released.current) {
      released.current = true;
      void revalidator.revalidate();
    }
  }, [snapshot?.state, revalidator]);
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
  const authRoute = pathname === '/login' || pathname === '/reset-password';
  const matchingTerminal = Boolean(
    operationJob &&
      operationJob.id === startedId.current &&
      !operationJob.needsRecovery &&
      ['succeeded', 'rolled-back'].includes(operationJob.status),
  );
  const locked = !snapshot || snapshot.state !== 'idle' || snapshot.unavailable === true;
  const showChildren = operationShowsContent(snapshot, authRoute, matchingTerminal, continuity.departing);
  const server = snapshot ?? { state: 'checking' as const, supported: true };
  const waiting = operationIsWaiting(server);
  const useSpace = operationUsesSpace(snapshot, Boolean(operation.current ?? initialMarker.current?.operation));
  const kind = operation.current ?? 'restore';
  const restoration = kind === 'restore' && job && server.state === 'idle' && matchingTerminal ? restorePresentation(job, false) : undefined;
  const coreStage =
    core?.phase === 'downloading'
      ? 'Downloading files'
      : core?.phase === 'offline'
        ? 'Restarting'
        : core?.phase === 'checking'
          ? 'Verifying release'
          : core?.phase === 'ready'
            ? 'Opening your server'
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
      ? `Orbis ${core.targetTag}`
      : server.state === 'recovery'
        ? 'Recovery needed'
        : kind === 'update'
          ? 'Updating Orbis'
          : kind === 'downgrade'
            ? 'Downgrading Orbis'
            : server.state === 'checking' && !operation.current
              ? 'Checking server'
              : 'Restoring');
  if (server.state === 'resetting' && !authRoute)
    return (
      <>
        <RecoveryScene
          open={!resetRecovery}
          title={server.stage === 'recovering' ? 'Reset needs attention' : 'Resetting Orbis'}
          status={server.stage === 'recovering' ? 'Waiting for confirmation' : stageCopy[server.stage ?? 'resetting']}
          active={server.stage !== 'recovering'}
          variant="onboarding"
          detail={
            server.stage === 'recovering' ? 'Confirm the original reset again to continue. Server data stays locked until it finishes.' : undefined
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
        title={waiting ? 'Checking server' : title}
        status={waiting ? undefined : status}
        variant={kind}
        detail={waiting ? 'Waiting for the server to respond. Checking will continue automatically.' : undefined}
        progress={restoration?.progress ?? server.progress}
        active={waiting || ['restoring', 'updating', 'downgrading'].includes(server.state)}
        departing={continuity.departing}
        indicator={server.stage === 'restarting' || core?.phase === 'offline' || core?.phase === 'checking' ? 'restart' : 'progress'}
        footer={!waiting && kind !== 'restore' ? 'Applications keep running during this Orbis operation.' : undefined}
        actions={
          waiting ? (
            <Button className="operation-wait-retry" onClick={() => window.location.reload()}>
              Retry
            </Button>
          ) : (
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
              {locked ? (
                <a className="btn" href="/login">
                  Sign in
                </a>
              ) : null}
              {matchingTerminal && !continuity.departing ? <Button onClick={() => window.location.assign('/')}>Open server</Button> : null}
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
