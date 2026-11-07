import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TimeMachineRestoreGrant } from '@runtipi/common/schemas/time-machine-restore';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { IconHistory, IconTrash, IconX } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Switch } from '@/components/ui/Switch/Switch';
import { Input } from '@/components/ui/Input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Alert, AlertDescription, AlertHeading, InlineFeedback } from '@/components/ui/Alert/Alert';
import { useSettingsSave } from '@/modules/settings/pages/settings-save';
import { restoreStatusSchema, type RestoreJob, formatBackupBytes } from '@/modules/system-backups/contracts';
import {
  activateTimeMachinePoint,
  authorizeTimeMachineWithPassword,
  authorizeTimeMachineWithPasskey,
  timeMachinePasskeyOptions,
  captureTimeMachine,
  removeTimeMachinePoint,
  reviewTimeMachinePoint,
  saveTimeMachinePreferences,
} from './time-machine-api';
import { backupRequest } from '@/modules/system-backups/backup-api';
import { armAcceptedRestore, operationContinuityStorage } from '@/components/recovery-progress/operation-continuity';
import { RecoveryProgressBar } from '@/components/recovery-progress/recovery-progress';
import { measuredPercent } from '@/components/recovery-progress/restore-presentation';
import { browserPasskeyReason, cancelPasskeyCeremony, passkeyErrorMessage, warmPasskeyClient } from '@/modules/auth/passkeys/passkey-api';
import { eligibleRestoreReview, verifiedRestoreReview } from './timeline-state';
import { restoreAuthorizationAvailable } from './restore-authorization';
import { TimeMachineRestoreJourney } from './restore-journey';
import { orderedPoints, parseTimeMachine, selectedPointId, type TimeMachineSnapshot } from './contracts';
import { pointDate, TimeMachineJourney } from './time-machine-journey';
import { useTimeMachine } from './use-time-machine';
import { saveTimeMachineEnabled, timeMachinePreferencesQueryKey } from './time-machine-preferences-query';
import { timeMachineRetentionSummary, timeMachineSettingsMode } from './time-machine-settings-state';
import { hasSeenTimeMachineNotice, markTimeMachineNoticeSeen } from './time-machine-notice';
import './time-machine-settings-notice.css';
import { TimeMachineCaptureProgress } from './capture-progress';
import { TimeMachineStorageStatus } from './time-machine-storage-status';
import { CapturedContents } from './captured-contents';
import { TimeMachineCapsules } from '@/modules/time-machine-capsules/capsules-panel';
import { accountSecurityKey, readAccountSecurity } from '@/desktop/account-security-api';
import './time-machine.css';

type Review = Awaited<ReturnType<typeof reviewTimeMachinePoint>>;

export function TimeMachineSetupView({ pending, onEnable }: { pending: boolean; onEnable: () => void }) {
  return (
    <section className="tm-disabled-setup" aria-labelledby="tm-disabled-setup-heading">
      <div className="tm-disabled-setup-copy">
        <h4 id="tm-disabled-setup-heading">What a Time Machine point includes</h4>
        <p>Time Machine saves manual restore points containing:</p>
        <ul className="tm-disabled-capture-list">
          <li>The server database</li>
          <li>Orbis configuration</li>
          <li>Managed app data</li>
        </ul>
        <p>Operating system snapshots are not included.</p>
      </div>
      <Button intent="primary" onClick={onEnable} disabled={pending}>
        {pending ? 'Enabling…' : 'Enable Time Machine'}
      </Button>
      <output className="tm-activation-status" aria-live="polite">
        {pending ? 'Enabling Time Machine…' : ''}
      </output>
    </section>
  );
}

export function TimeMachinePointDetails({
  point,
  capabilities,
  review,
}: {
  point: TimeMachinePoint;
  capabilities: TimeMachineSnapshot['capabilities'];
  review?: Review | null;
}) {
  const metadata = point.metadata;
  const verified = verifiedRestoreReview(review ?? null, point, Date.now());
  const eligible = eligibleRestoreReview(review ?? null, point, Date.now());
  const blockers = [
    ...new Map(
      [
        ...(capabilities.restore.supported || eligible ? [] : capabilities.restore.blockers),
        ...(review?.blockers ?? metadata?.restore.blockers ?? capabilities.restore.blockers),
      ].map((issue) => [issue.code, issue]),
    ).values(),
  ];
  return (
    <div className="tm-details">
      <dl>
        <div>
          <dt>Captured</dt>
          <dd>{pointDate(point)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{point.status}</dd>
        </div>
        {metadata ? (
          <>
            <div>
              <dt>Orbis</dt>
              <dd>{metadata.software.orbis}</dd>
            </div>
            <div>
              <dt>Controller</dt>
              <dd>{metadata.software.runtipi}</dd>
            </div>
            <div>
              <dt>Storage</dt>
              <dd>{formatBackupBytes(metadata.archiveBytes)}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {point.issue ? <InlineFeedback>{point.issue.message}</InlineFeedback> : null}
      {metadata ? (
        <>
          <CapturedContents point={point} />
          <h3>Storage breakdown</h3>
          <dl>
            {metadata.breakdown.map((part) => (
              <div key={part.id}>
                <dt>{part.id}</dt>
                <dd>
                  {formatBackupBytes(part.bytes)}, {part.entries.toLocaleString()} entries
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p>This point has no sealed archive to inspect.</p>
      )}
      <h3>Restore availability</h3>
      <p>
        {capabilities.restore.supported || eligible
          ? 'The server must verify this exact point before any restore can be authorized.'
          : 'Restoration is unavailable on this server. Browsing changes no data.'}
      </p>
      <ul>
        {blockers.map((blocker) => (
          <li key={blocker.code}>{blocker.message}</li>
        ))}
      </ul>
      <output className="tm-review-status" aria-live="polite">
        {review?.status === 'eligible' && !eligible
          ? 'Review expired or point changed. Verify again.'
          : review?.status === 'eligible'
            ? 'Host compatibility is not yet confirmed.'
            : review?.status === 'ready' && !verified
              ? 'Review expired or point changed. Verify again.'
              : review?.status === 'ready'
                ? 'Point verified. Fresh authorization is required.'
                : review?.status === 'reviewing'
                  ? 'Verifying this point.'
                  : review
                    ? 'Restore unavailable after verification.'
                    : ''}
      </output>
    </div>
  );
}
export function openTimelineAt(pointId: string | null, setSelection: (id: string | null) => void, setGallery: (open: boolean) => void) {
  setSelection(pointId);
  setGallery(true);
}

export function TimeMachineSettings({ openTimeline = false, onExitTimeline }: { openTimeline?: boolean; onExitTimeline?: () => void } = {}) {
  const machine = useTimeMachine();
  return <TimeMachineSettingsSession key={machine.identity.revision} machine={machine} openTimeline={openTimeline} onExitTimeline={onExitTimeline} />;
}
function TimeMachineSettingsSession({
  machine,
  openTimeline,
  onExitTimeline,
}: {
  machine: ReturnType<typeof useTimeMachine>;
  openTimeline: boolean;
  onExitTimeline?: () => void;
}) {
  const { snapshot, busy, error, notice, visible, user } = machine;
  const queryClient = useQueryClient();
  const capturePolicy = useQuery({
    queryKey: accountSecurityKey(user.id),
    queryFn: ({ signal }) => readAccountSecurity(AbortSignal.any([signal, machine.sessionAbortSignal])),
    enabled: user.operator,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [gallery, setGallery] = useState(openTimeline);
  const noticeOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  const [noticeDismissed, setNoticeDismissed] = useState(() => hasSeenTimeMachineNotice(machine.user.id, noticeOrigin));
  const timelineExitRequested = useRef(false);
  const changeGallery = (open: boolean) => {
    if (open && snapshot?.preferences.enabled !== true) return;
    timelineExitRequested.current = !open;
    setGallery(open);
  };
  const finishTimelineClose = () => {
    if (!timelineExitRequested.current) return;
    timelineExitRequested.current = false;
    onExitTimeline?.();
  };
  const [selection, setSelection] = useState<string | null>(null);
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const [captureLabel, setCaptureLabel] = useState('');
  const [activationPending, setActivationPending] = useState(false);
  const [action, setAction] = useState<{ kind: 'capture' | 'remove' | 'inspect' | 'authorize'; point?: TimeMachinePoint } | null>(null);
  const captureProofRequired = capturePolicy.data?.requireCaptureAuthentication === true;
  useEffect(() => {
    if (action?.kind === 'capture' || action?.kind === 'remove') void capturePolicy.refetch();
  }, [action?.kind, capturePolicy.refetch]);
  const [review, setReview] = useState<Review | null>(null);
  const [actionError, setActionError] = useState('');
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const [reviewClock, setReviewClock] = useState(Date.now);
  const [restoreJob, setRestoreJob] = useState<RestoreJob | null>(null);
  const [restoreReconnecting, setRestoreReconnecting] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const points = orderedPoints(snapshot?.list.points ?? []);
  const savedPoints = points.filter((item) => item.status === 'sealed');
  const retainedBytes = savedPoints.reduce((total, item) => total + (item.metadata?.archiveBytes ?? 0), 0);
  const selected = selectedPointId(points, selection);
  const point = points.find((item) => item.id === selected);
  const actionPoint = action?.point ? points.find((item) => item.id === action.point?.id) : undefined;
  const readyToAuthorize = restoreAuthorizationAvailable(actionPoint, review, snapshot?.capabilities.restore.supported === true, reviewClock);
  const acceptedRestoreId = restoreJob?.id;
  const active = points.find((item) => item.status === 'capturing');
  const enabled = enabledDraft ?? snapshot?.preferences.enabled ?? false;
  const dirty = snapshot !== null && enabled !== snapshot.preferences.enabled;
  const settingsMode = timeMachineSettingsMode(snapshot?.preferences ?? null);
  const save = async () => {
    if (!snapshot) throw new Error('Read Time Machine settings before saving.');
    let savedPreferences: Awaited<ReturnType<typeof saveTimeMachinePreferences>> | undefined;
    const accepted = await machine.perform(async (signal) => {
      savedPreferences = await saveTimeMachinePreferences(
        {
          expectedRevision: snapshot.preferences.revision,
          enabled,
          schedule: snapshot.preferences.schedule,
          beforeUpdate: false,
          beforeRestart: false,
          excludedApps: snapshot.preferences.excludedApps,
        },
        signal,
      );
      return savedPreferences;
    }, 'Time Machine settings saved.');
    if (!accepted) throw new Error('Time Machine settings were not confirmed.');
    if (savedPreferences) queryClient.setQueryData(timeMachinePreferencesQueryKey(machine.user.id), savedPreferences);
    setEnabledDraft(null);
  };
  const shared = useSettingsSave({ section: 'time-machine', dirty, pending: busy, prepare: async () => (snapshot && !error ? save : null) });
  const activate = async () => {
    if (!snapshot || snapshot.preferences.enabled || busy) return;
    setActivationPending(true);
    let savedPreferences: Awaited<ReturnType<typeof saveTimeMachinePreferences>> | undefined;
    try {
      const accepted = await machine.perform(async (signal) => {
        savedPreferences = await saveTimeMachineEnabled(snapshot.preferences, true, signal);
        return savedPreferences;
      }, '');
      if (!accepted || !savedPreferences) return;
      queryClient.setQueryData(timeMachinePreferencesQueryKey(machine.user.id), savedPreferences);
      setEnabledDraft(null);
    } finally {
      setActivationPending(false);
    }
  };
  useEffect(() => {
    if (settingsMode === 'setup') setGallery(false);
    else if (settingsMode === 'active' && openTimeline) setGallery(true);
  }, [settingsMode, openTimeline]);
  const chooseAction = (kind: 'capture' | 'remove' | 'inspect') => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    form.current?.reset();
    setActionError('');
    setReview(null);
    if (kind === 'capture') setCaptureLabel('');
    setAction({ kind, point: kind === 'capture' ? undefined : point });
  };
  const closeAction = () => {
    if (busy) return;
    form.current?.reset();
    setAction(null);
    setActionError('');
  };
  useEffect(() => {
    if (!action || !review || (review.status !== 'ready' && review.status !== 'eligible')) return;
    setReviewClock(Date.now());
    const timer = setInterval(() => setReviewClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [action, review]);
  useEffect(() => {
    if (action?.kind !== 'authorize' || !actionPoint?.id) return;
    return () => cancelPasskeyCeremony();
  }, [action?.kind, actionPoint?.id]);
  useEffect(() => {
    if (!visible || busy || action?.kind !== 'inspect' || !actionPoint || review?.status !== 'reviewing') return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, machine.sessionAbortSignal]);
    const timer = setTimeout(() => {
      void reviewTimeMachinePoint(actionPoint, signal, true)
        .then((result) => {
          if (!signal.aborted) {
            setReview(result);
            setReviewClock(Date.now());
          }
        })
        .catch((failure) => {
          if (!signal.aborted) setActionError(failure instanceof Error ? failure.message : 'Verification status is unavailable.');
        });
    }, 1500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [visible, busy, action?.kind, actionPoint, review, machine.sessionAbortSignal]);
  useEffect(() => {
    if (!visible || !acceptedRestoreId) return;
    if (restoreAttempt > 0) setRestoreReconnecting(true);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, machine.sessionAbortSignal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await backupRequest('/restores', 'GET', undefined, AbortSignal.any([signal, AbortSignal.timeout(12000)]));
        const parsed = parseTimeMachine(restoreStatusSchema, response);
        if (!parsed.job || parsed.job.id !== acceptedRestoreId) throw new Error('Waiting for this restore’s verified status.');
        if (signal.aborted) return;
        setRestoreJob(parsed.job);
        setRestoreReconnecting(false);
        if (!['succeeded', 'rolled-back'].includes(parsed.job.status)) timer = setTimeout(() => void poll(), 1500);
      } catch {
        if (!signal.aborted) {
          setRestoreReconnecting(true);
          timer = setTimeout(() => void poll(), 2500);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [visible, acceptedRestoreId, restoreAttempt, machine.sessionAbortSignal]);
  const verifyPoint = async (target: TimeMachinePoint) => {
    setActionError('');
    setReview(null);
    await machine.perform(async (signal) => {
      const result = await reviewTimeMachinePoint(target, signal);
      if (!signal.aborted) {
        setReview(result);
        setReviewClock(Date.now());
      }
    }, 'Point verification status received.');
  };
  const openRestore = () => {
    if (!point || point.status !== 'sealed') return;
    chooseAction('inspect');
    void verifyPoint(point);
  };
  const startRestore = async (method: 'password' | 'passkey') => {
    if (!actionPoint || !review || busy || !readyToAuthorize) return;
    if (!replacementConfirmed) {
      setActionError('Confirm replacing this server with the selected point.');
      return;
    }
    const fields = form.current ? new FormData(form.current) : new FormData();
    const password = String(fields.get('password') ?? '');
    const code = String(fields.get('totpCode') ?? '');
    if ((method === 'password' && (!password || password.length > 1024)) || ((user.totpEnabled || code) && !/^\d{6}$/.test(code))) {
      setActionError('Enter your current account password and authentication code if enabled.');
      return;
    }
    form.current?.reset();
    setActionError('');
    const accepted = await machine.perform(async (signal) => {
      let grant: TimeMachineRestoreGrant;
      if (method === 'password')
        grant = await authorizeTimeMachineWithPassword(actionPoint, review, { password, ...(code ? { totpCode: code } : {}) }, signal);
      else {
        const options = await timeMachinePasskeyOptions(actionPoint, review, signal);
        if (options.requiresTotp && !code) throw new Error('Enter the current authentication code before using your passkey.');
        const client = await import('@simplewebauthn/browser');
        signal.throwIfAborted();
        const response = await client.startAuthentication({ optionsJSON: options.options }).catch((failure) => {
          throw new Error(passkeyErrorMessage(failure));
        });
        signal.throwIfAborted();
        grant = await authorizeTimeMachineWithPasskey(actionPoint, review, options, response, code || undefined, signal);
      }
      const job = await activateTimeMachinePoint(actionPoint, review, grant, signal);
      if (signal.aborted) return;
      const storage = operationContinuityStorage();
      if (storage) armAcceptedRestore(job.id, storage);
      setRestoreJob(job);
      setRestoreReconnecting(false);
      setGallery(false);
    }, 'Restore accepted. Waiting for verified server progress.');
    setReplacementConfirmed(false);
    if (accepted) setAction(null);
    else setActionError('Restore was not confirmed. Check status before authorizing a new attempt.');
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !action ||
      busy ||
      (['capture', 'remove'].includes(action.kind) && (!capturePolicy.data || capturePolicy.isError || capturePolicy.isFetching))
    )
      return;
    const fields = new FormData(event.currentTarget);
    const credentials = {
      password: String(fields.get('password') ?? ''),
      ...(user.totpEnabled ? { totpCode: String(fields.get('totpCode') ?? '') } : {}),
    };
    const label = String(fields.get('label') ?? '').trim();
    if (captureProofRequired && (!credentials.password || (user.totpEnabled && !/^\d{6}$/.test(credentials.totpCode ?? '')))) {
      setActionError('Enter this server’s account password and current authentication code, if enabled.');
      return;
    }
    form.current?.reset();
    const accepted =
      action.kind === 'capture'
        ? await machine.perform(
            (signal) => captureTimeMachine(label, captureProofRequired ? credentials : {}, signal),
            'Capture accepted. Its progress is reported by the server.',
          )
        : action.point &&
          (await machine.perform(
            (signal) => removeTimeMachinePoint(action.point?.id ?? '', captureProofRequired ? credentials : {}, signal),
            'Point removed.',
          ));
    if (accepted) {
      if (action.kind === 'capture') void queryClient.invalidateQueries({ queryKey: ['time-machine-activity'] });
      setAction(null);
    } else {
      if (action.kind === 'capture') void capturePolicy.refetch();
      setActionError('The action was not confirmed. Review its status before retrying.');
    }
  };
  if (user.operator !== true) return <p>An operator manages Time Machine for this server.</p>;
  return (
    <section id="setting-time-machine" className="tm-settings" aria-label="Time Machine">
      <TimeMachineStorageStatus visible={visible} />
      {snapshot ? null : <output>{error ? 'Time Machine status is unavailable.' : 'Reading Time Machine…'}</output>}
      {error ? <InlineFeedback>{error}</InlineFeedback> : null}
      {notice && notice !== 'Time Machine settings saved.' ? <output>{notice}</output> : null}
      {noticeDismissed ? null : (
        <Alert variant="warning" dismissible className="tm-first-open-notice">
          <div>
            <AlertHeading>Experimental</AlertHeading>
            <AlertDescription>Keep this server running while Orbis saves a capture.</AlertDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            aria-label="Dismiss experimental notice"
            onClick={() => {
              markTimeMachineNoticeSeen(machine.user.id, noticeOrigin);
              setNoticeDismissed(true);
            }}
          >
            <IconX size={18} aria-hidden="true" />
          </Button>
        </Alert>
      )}
      {snapshot ? (
        <>
          {snapshot.list.available ? null : (
            <InlineFeedback>Time Machine storage is unavailable. No point can be captured or removed.</InlineFeedback>
          )}
          {settingsMode === 'setup' ? (
            <TimeMachineSetupView pending={busy || activationPending} onEnable={() => void activate()} />
          ) : (
            <>
              <div className="tm-enabled-preference">
                <Switch label="Enable Time Machine" checked={enabled} disabled={busy} onCheckedChange={setEnabledDraft} />
                <p>
                  Captures save Orbis settings, its database and the version needed for recovery. App data and operating system files are not
                  included.{' '}
                  {snapshot.capabilities.restore.supported
                    ? 'Each restore requires verification and fresh authorization.'
                    : 'Open a point to inspect this server’s current restore blockers.'}
                </p>
              </div>
              <div className="tm-settings-actions">
                <Button intent="primary" onClick={() => openTimelineAt(null, setSelection, setGallery)} disabled={!snapshot.list.available}>
                  <IconHistory size={20} aria-hidden="true" />
                  Enter Time Machine
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    !machine.canMutate ||
                    !snapshot.capabilities.manualCapture ||
                    !snapshot.list.available ||
                    !snapshot.preferences.enabled ||
                    Boolean(snapshot.list.activeCaptureId) ||
                    Boolean(error)
                  }
                  onClick={() => chooseAction('capture')}
                >
                  Capture
                </Button>
                {shared.shared ? null : (
                  <Button disabled={!dirty || busy} onClick={() => void save().catch(() => undefined)}>
                    Save
                  </Button>
                )}
              </div>
              {dirty ? <p>Save this change before starting a capture.</p> : null}
              <p>Automatic captures are not available on this server yet.</p>
              {active ? <TimeMachineCaptureProgress point={active} /> : null}
              <p>{timeMachineRetentionSummary(savedPoints.length, retainedBytes, formatBackupBytes)}</p>
              {points.length ? (
                <ol className="tm-point-list">
                  {points.map((item) => (
                    <li key={item.id}>
                      <div className="tm-point-summary">
                        <strong>{item.metadata?.label || pointDate(item)}</strong>
                        <span>
                          {pointDate(item)}, {item.status}
                        </span>
                        {item.issue ? <small>{item.issue.message}</small> : null}
                      </div>
                      <Button variant="outline" onClick={() => openTimelineAt(item.id, setSelection, setGallery)}>
                        Browse
                      </Button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>Your timeline will appear after the first point is captured.</p>
              )}
              <TimeMachineCapsules
                visible={visible}
                points={snapshot?.list.points ?? null}
                pointsError={Boolean(error)}
                onRefreshPoints={machine.retry}
              />
            </>
          )}
        </>
      ) : null}
      <TimeMachineJourney
        open={gallery && settingsMode === 'active'}
        onOpenChange={changeGallery}
        onClosed={finishTimelineClose}
        points={points}
        selected={selected}
        onSelect={setSelection}
        onInspect={() => chooseAction('inspect')}
        onRestore={openRestore}
        onRemove={() => chooseAction('remove')}
        session={machine.sessionAbortSignal}
        busy={busy || !machine.canMutate || Boolean(error)}
        onCapture={
          snapshot?.preferences.enabled && machine.canMutate && snapshot.capabilities.manualCapture && !snapshot.list.activeCaptureId
            ? () => chooseAction('capture')
            : undefined
        }
      />
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open) closeAction();
        }}
      >
        <DialogContent
          size={action?.kind === 'authorize' ? 'sm' : 'lg'}
          closeDisabled={busy}
          onCloseAutoFocus={(event) => {
            if (opener.current?.isConnected) {
              event.preventDefault();
              opener.current.focus({ preventScroll: true });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {action?.kind === 'capture'
                ? 'Capture'
                : action?.kind === 'remove'
                  ? 'Remove this point?'
                  : action?.kind === 'authorize'
                    ? 'Restore this point'
                    : 'Inspect saved point'}
            </DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {action?.kind === 'capture'
              ? 'Orbis pauses briefly while its data is saved. App data is not included. Keep this server running until capture finishes.'
              : action?.kind === 'remove'
                ? 'The encrypted point and its saved preview will be permanently removed. Other points and the running server stay unchanged.'
                : action?.kind === 'authorize'
                  ? review?.status === 'eligible'
                    ? 'The host will check this point before any server data is replaced.'
                    : 'This replaces current server data. Apps pause while this verified point is restored.'
                  : 'Saved contents and restore requirements for this point.'}
          </DialogDescription>
          {action?.kind === 'inspect' && action.point && snapshot ? (
            <div className="tm-dialog-body">
              <TimeMachinePointDetails point={action.point} capabilities={snapshot.capabilities} review={review} />
              <div className="tm-review-progress" aria-hidden={review?.status !== 'reviewing'}>
                <RecoveryProgressBar
                  label="Archive verification"
                  percentage={
                    review?.status === 'reviewing' ? measuredPercent(review.progress.completedBytes, review.progress.totalBytes) : undefined
                  }
                />
              </div>
              <Button
                variant="outline"
                aria-label="Verify archive integrity"
                disabled={busy || !machine.canMutate || action.point.status !== 'sealed'}
                onClick={() => actionPoint && void verifyPoint(actionPoint)}
              >
                Verify
              </Button>
              <Button
                disabled={busy || !machine.canMutate || !readyToAuthorize}
                onClick={() => {
                  setReplacementConfirmed(false);
                  setActionError('');
                  setAction({ kind: 'authorize', point: actionPoint });
                }}
              >
                Restore
              </Button>
              {actionError ? <InlineFeedback>{actionError}</InlineFeedback> : null}
              {error ? <InlineFeedback>{error}</InlineFeedback> : null}
            </div>
          ) : action?.kind === 'authorize' ? (
            <form
              ref={form}
              className="tm-dialog-body"
              onSubmit={(event) => {
                event.preventDefault();
                void startRestore('password');
              }}
            >
              <strong>{actionPoint ? pointDate(actionPoint) : 'This point is no longer available'}</strong>
              {actionPoint?.metadata?.label ? <p>{actionPoint.metadata.label}</p> : null}
              {actionPoint ? <CapturedContents point={actionPoint} /> : null}
              <Checkbox
                label="Replace this server with this saved point"
                checked={replacementConfirmed}
                onCheckedChange={setReplacementConfirmed}
                disabled={busy}
              />
              <Input
                name="password"
                type="password"
                label="Current account password"
                autoComplete="current-password"
                maxLength={1024}
                disabled={busy}
              />
              <Input
                name="totpCode"
                label={user.totpEnabled ? 'Authentication code' : 'Authentication code if enabled'}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                disabled={busy}
                required={user.totpEnabled}
              />
              {readyToAuthorize ? null : (
                <InlineFeedback>
                  Current restore authorization is unavailable. Go back and verify this point and the server’s capabilities again.
                </InlineFeedback>
              )}
              {actionError || error ? <InlineFeedback>{error || actionError}</InlineFeedback> : null}
              {error ? (
                <Button type="button" variant="outline" onClick={() => void machine.retry()}>
                  Check status
                </Button>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    form.current?.reset();
                    setAction({ kind: 'inspect', point: actionPoint });
                  }}
                >
                  Back
                </Button>
                <Button type="submit" disabled={busy || !machine.canMutate || !readyToAuthorize || !replacementConfirmed} loading={busy}>
                  Restore point
                </Button>
              </DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={
                  busy ||
                  !machine.canMutate ||
                  !readyToAuthorize ||
                  !replacementConfirmed ||
                  (typeof window !== 'undefined' && Boolean(browserPasskeyReason()))
                }
                onPointerEnter={warmPasskeyClient}
                onFocus={warmPasskeyClient}
                onClick={() => void startRestore('passkey')}
              >
                Authorize with passkey
              </Button>
              {typeof window !== 'undefined' && browserPasskeyReason() ? <small>{browserPasskeyReason()}</small> : null}
            </form>
          ) : (
            <form ref={form} className="tm-dialog-body" onSubmit={(event) => void submit(event)}>
              {action?.kind === 'capture' ? (
                <Input
                  name="label"
                  label="Capture name"
                  placeholder="Before updating Jellyfin"
                  maxLength={240}
                  disabled={busy}
                  value={captureLabel}
                  onChange={(event) => setCaptureLabel(event.currentTarget.value)}
                />
              ) : action?.point ? (
                <strong>{pointDate(action.point)}</strong>
              ) : null}
              {captureProofRequired ? (
                <>
                  <Input
                    name="password"
                    type="password"
                    label="This server’s account password"
                    autoComplete="current-password"
                    maxLength={1024}
                    disabled={busy}
                    required
                  />
                  {user.totpEnabled ? (
                    <Input
                      name="totpCode"
                      label="Authentication code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      disabled={busy}
                      required
                    />
                  ) : null}
                </>
              ) : null}
              {capturePolicy.isError ? (
                <InlineFeedback>
                  <p>Capture security could not be loaded.</p>
                  <Button type="button" variant="outline" onClick={() => void capturePolicy.refetch()}>
                    Retry
                  </Button>
                </InlineFeedback>
              ) : null}
              {actionError || error ? <InlineFeedback>{error || actionError}</InlineFeedback> : null}
              {error ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void machine.retry().then((refreshed) => {
                      if (refreshed) setActionError('');
                    })
                  }
                >
                  Check status
                </Button>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeAction} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  intent={action?.kind === 'remove' ? 'danger' : 'primary'}
                  loading={busy}
                  disabled={
                    busy ||
                    !machine.canMutate ||
                    (['capture', 'remove'].includes(action?.kind ?? '') && (!capturePolicy.data || capturePolicy.isError || capturePolicy.isFetching))
                  }
                >
                  {action?.kind === 'remove' ? <IconTrash className="tm-trash" size={18} aria-hidden="true" /> : null}
                  {action?.kind === 'remove' ? 'Remove' : 'Capture'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      {restoreJob ? (
        <TimeMachineRestoreJourney
          job={restoreJob}
          reconnecting={restoreReconnecting}
          onRetry={() => setRestoreAttempt((value) => value + 1)}
          onDone={() => window.location.assign('/')}
        />
      ) : null}
    </section>
  );
}
