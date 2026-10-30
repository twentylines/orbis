import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Input } from '@/components/ui/Input';
import { RecoveryProgress } from '@/components/recovery-progress/recovery-progress';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { copyText } from '@/lib/clipboard';
import { NearbyServers } from '@/components/nearby-servers/nearby-servers';
import { readBackups, type BackupCredentials } from '../system-backups/backup-api';
import { formatBackupBytes } from '../system-backups/contracts';
import { SystemBackupsSettings } from '../system-backups/system-backups-settings';
import {
  approveTransferOffer,
  cancelTransfer,
  cancelTransferOffer,
  claimTransfer,
  createTransferOffer,
  readTransfers,
  startTransfer,
  TransferApiError,
  transferPollingInterval,
  type TransferJob,
  type TransferOffer,
  type TransferSnapshot,
} from './transfer-api';
import { SourceCertificatePicker } from './source-certificate-picker';
import { SourceCertificateInfo } from './source-certificate-info';
import type { SourceCertificate } from './source-certificate';
import { ReceiverRequestWizard } from './receiver-request-wizard';
import { SourceRestoreRequests } from './source-restore-requests';
import './host-transfer-panel.css';

type Props = {
  mode?: 'receive' | 'both';
  embedded?: boolean;
  contained?: boolean;
  onActivityChange?: (active: boolean) => void;
  onDismiss?: () => void;
};
type View = { kind: 'overview' | 'offer' | 'receive' } | { kind: 'approve'; offer: TransferOffer } | { kind: 'restore'; importId: string };
const offerLabels: Record<TransferOffer['status'], string> = {
  'awaiting-claim': 'Waiting for destination',
  'awaiting-approval': 'Destination needs approval',
  approved: 'Approved for transfer',
  sending: 'Sending encrypted backup',
  complete: 'Backup sent',
  failed: 'Transfer failed',
  cancelled: 'Transfer cancelled',
  expired: 'Transfer expired',
};
const jobLabels: Record<TransferJob['status'], string> = {
  'awaiting-source-approval': 'Waiting for source approval',
  'checking-approval': 'Checking approval',
  receiving: 'Receiving encrypted backup',
  complete: 'Backup received',
  failed: 'Transfer failed',
  cancelled: 'Transfer cancelled',
  expired: 'Transfer expired',
};
const stopped = new Set(['complete', 'failed', 'cancelled', 'expired']);

function Fingerprint({ label, value }: { label: string; value: string }) {
  return (
    <div className="host-transfer-fingerprint">
      <span>{label}</span>
      <code>{value.match(/.{1,8}/g)?.join(' ')}</code>
    </div>
  );
}
function Authentication({ disabled }: { disabled: boolean }) {
  return (
    <div className="host-transfer-fields">
      <Input
        label="Your account password"
        name="password"
        type="password"
        required
        autoComplete="current-password"
        maxLength={1024}
        disabled={disabled}
      />
      <Input
        label="Authentication code, if enabled"
        name="totpCode"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        autoComplete="one-time-code"
        disabled={disabled}
      />
    </div>
  );
}

export function ReceiveAccountVerification({
  source,
  code,
  localCertificate,
  disabled,
}: {
  source: string;
  code: string;
  localCertificate: boolean;
  disabled: boolean;
}) {
  return (
    <>
      <p>Confirm with your account on this server. You’ll compare fingerprints and approve the destination on the source next.</p>
      <div className="host-transfer-source-summary">
        <span>Source server</span>
        <strong className="host-transfer-address">{source}</strong>
        <small>{localCertificate ? 'Local certificate fingerprint confirmed' : 'HTTPS certificate checked when connecting'}</small>
      </div>
      <input type="hidden" name="sourceOrigin" value={source} />
      <input type="hidden" name="code" value={code} />
      <Authentication disabled={disabled} />
      <Checkbox
        className="host-transfer-confirm"
        name="confirm"
        value="yes"
        required
        disabled={disabled}
        label="I want to receive this backup for review on this server."
      />
    </>
  );
}

export function HostTransferPanel(props: Props = {}) {
  const id = useId();
  const { user } = useAppContext();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  const reportActivity = useCallback(
    (value: boolean) => {
      setActive(value);
      props.onActivityChange?.(value);
    },
    [props.onActivityChange],
  );
  if (user?.operator !== true) return null;
  if (props.embedded || props.mode === 'receive') return <ReceiverRequestWizard {...props} />;
  return (
    <section className="host-transfer-entry" data-contained={Boolean(props.contained)} aria-labelledby={`${id}-title`}>
      {props.contained ? <h3 id={`${id}-title`}>Restore from another server</h3> : <h2 id={`${id}-title`}>Restore from another server</h2>}
      <p>Bring an encrypted Orbis backup across your private network, then review it before restoring.</p>
      <div className="host-transfer-entry-actions">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOpen(true);
          }}
        >
          Connect
        </Button>
      </div>
      <SourceRestoreRequests />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!active) setOpen(next);
        }}
      >
        <DialogContent
          size="md"
          className="host-transfer-window"
          closeDisabled={active}
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (active) event.preventDefault();
          }}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Restore from another server</DialogTitle>
          </DialogHeader>
          <div className="modal-body host-transfer-window-body">
            <ReceiverRequestWizard embedded onActivityChange={reportActivity} onDismiss={() => setOpen(false)} />
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function HostTransferWizard({
  mode = 'both',
  embedded = false,
  onActivityChange,
  initialView,
  onDismiss,
}: Props & { initialView?: 'overview' | 'receive' } = {}) {
  const id = useId();
  const reduced = useReducedMotion();
  const { user } = useAppContext();
  const visible = useWindowVisible();
  const queryClient = useQueryClient();
  const key = ['orbis-host-transfers', user?.id];
  const [view, setView] = useState<View>({ kind: initialView ?? (mode === 'receive' ? 'receive' : 'overview') });
  const [direction, setDirection] = useState(1);
  const [busy, setBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState<{ id: string; value: string } | null>(null);
  const [sourceAddress, setSourceAddress] = useState('');
  const [receiveStep, setReceiveStep] = useState<'source' | 'verify'>('source');
  const [transferCode, setTransferCode] = useState('');
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const [sourceCertificate, setSourceCertificate] = useState<SourceCertificate | null>(null);
  const changeSource = (address: string) => {
    setSourceAddress(address);
    setSourceCertificate(null);
  };
  const running = useRef(false);
  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const focusNext = useRef<{ keyboard: boolean } | null>(null);
  const status = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readTransfers(signal),
    enabled: visible && user?.operator === true,
    retry: false,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      query.state.error instanceof TransferApiError && [401, 403, 404].includes(query.state.error.status)
        ? false
        : transferPollingInterval(query.state.data, visible),
  });
  const backups = useQuery({
    queryKey: ['orbis-full-backups', user?.id],
    queryFn: ({ signal }) => readBackups(signal),
    enabled: mode === 'both' && view.kind === 'offer' && visible && user?.operator === true,
    retry: false,
  });
  const snapshot = status.data;
  const offers = mode === 'both' ? (snapshot?.offers ?? []) : [];
  const jobs = snapshot?.jobs ?? [];
  const exports = backups.data?.exports.jobs.filter((job) => job.status === 'succeeded' && !job.needsRecovery && !job.restartRequired) ?? [];
  const activity = busy || restoreBusy || jobs.some((job) => ['checking-approval', 'receiving'].includes(job.status));
  const reportRestoreActivity = useCallback((active: boolean) => setRestoreBusy(active), []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    onActivityChange?.(activity);
  }, [activity, onActivityChange]);
  useEffect(() => () => onActivityChange?.(false), [onActivityChange]);
  useEffect(() => {
    if (!code || !snapshot) return;
    const offer = snapshot.offers.find((entry) => entry.id === code.id);
    if (offer && offer.status !== 'awaiting-claim') setCode(null);
  }, [code, snapshot]);
  useEffect(() => {
    const focus = focusNext.current;
    focusNext.current = null;
    if (!focus || view.kind === 'restore') return;
    const heading = stage.current?.querySelector<HTMLElement>('h3');
    const selector =
      view.kind === 'receive' && receiveStep === 'verify' ? 'input[name=password]' : 'input:not([type=checkbox]):not([type=hidden]), select';
    const target = focus.keyboard ? (stage.current?.querySelector<HTMLElement>(selector) ?? heading) : heading;
    target?.focus({ preventScroll: true });
  }, [view, receiveStep]);
  const go = (next: View) => {
    if (running.current) return;
    focusNext.current = { keyboard: document.activeElement instanceof HTMLElement && document.activeElement.matches(':focus-visible') };
    setDirection(next.kind === 'overview' ? -1 : 1);
    setSourceCertificate(null);
    setTransferCode('');
    setReceiveStep('source');
    setNearbyOpen(false);
    setError(null);
    setNotice(null);
    setView(next);
  };
  const rememberOffer = (offer: TransferOffer) =>
    queryClient.setQueryData<TransferSnapshot>(key, (previous) => ({
      offers: [...(previous?.offers.filter((entry) => entry.id !== offer.id) ?? []), offer],
      jobs: previous?.jobs ?? [],
    }));
  const rememberJob = (job: TransferJob) =>
    queryClient.setQueryData<TransferSnapshot>(key, (previous) => ({
      offers: previous?.offers ?? [],
      jobs: [...(previous?.jobs.filter((entry) => entry.id !== job.id) ?? []), job],
    }));
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await work(controller.signal);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'The transfer did not finish. Refresh status before retrying.');
    } finally {
      running.current = false;
      abort.current = null;
      if (mounted.current) {
        setBusy(false);
        void status.refetch();
      }
    }
  };
  const reviewSource = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || (sourceCertificate && !sourceCertificate.confirmed)) return;
    focusNext.current = { keyboard: document.activeElement instanceof HTMLElement && document.activeElement.matches(':focus-visible') };
    setError(null);
    setDirection(1);
    setReceiveStep('verify');
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const credentials: BackupCredentials = {
      password: String(values.get('password') ?? ''),
      ...(values.get('totpCode') ? { totpCode: String(values.get('totpCode')) } : {}),
    };
    const backupId = String(values.get('backupId') ?? '');
    const source = String(values.get('sourceOrigin') ?? '');
    const submittedCode = String(values.get('code') ?? '')
      .trim()
      .toLowerCase();
    const confirmed = values.get('confirm') === 'yes';
    form.reset();
    const selected = view;
    if (!confirmed) {
      setError('Compare and confirm the transfer details before continuing.');
      return;
    }
    void run(async (signal) => {
      if (selected.kind === 'offer') {
        const result = await createTransferOffer(backupId, credentials, signal);
        const { code: offeredCode, ...offer } = result;
        if (!mounted.current) return;
        rememberOffer(offer);
        setCode({ id: offer.id, value: offeredCode });
      } else if (selected.kind === 'approve') {
        const approved = await approveTransferOffer(selected.offer, credentials, signal);
        if (!mounted.current) return;
        rememberOffer(approved);
      } else if (selected.kind === 'receive') {
        const certificate = sourceCertificate;
        setTransferCode('');
        try {
          const job = await claimTransfer(source, submittedCode, credentials, signal, certificate);
          if (!mounted.current) return;
          setSourceCertificate(null);
          rememberJob(job);
        } catch (reason) {
          if (mounted.current) {
            focusNext.current = { keyboard: false };
            setSourceCertificate(null);
            setReceiveStep('source');
          }
          throw reason;
        }
      }
      if (mounted.current) {
        focusNext.current = { keyboard: false };
        setDirection(1);
        setView({ kind: 'overview' });
      }
    });
  };
  if (user?.operator !== true) return null;
  if (view.kind === 'restore')
    return (
      <div className="host-transfer-panel" data-embedded={embedded} data-reduced={Boolean(reduced)}>
        <div className="host-transfer-stage" data-direction={direction}>
          <div className="host-transfer-actions">
            <Button type="button" variant="outline" disabled={restoreBusy} onClick={() => go({ kind: 'overview' })}>
              Back to transfers
            </Button>
          </div>
          <SystemBackupsSettings restoreOnly embedded initialImportId={view.importId} onActivityChange={reportRestoreActivity} />
        </div>
      </div>
    );
  return (
    <section
      className="host-transfer-panel"
      data-embedded={embedded}
      data-reduced={Boolean(reduced)}
      aria-label={embedded ? 'Host transfer' : undefined}
      aria-labelledby={embedded ? undefined : `${id}-title`}
    >
      {!embedded || view.kind === 'overview' ? (
        <header className="host-transfer-heading">
          {embedded ? <h3 id={`${id}-title`}>Transfer status</h3> : <h2 id={`${id}-title`}>Restore from another server</h2>}
          <Button
            type="button"
            variant="outline"
            disabled={busy || status.isFetching}
            onClick={() => {
              void status.refetch();
            }}
          >
            Refresh
          </Button>
        </header>
      ) : null}
      {embedded ? null : (
        <p>
          Send an encrypted full backup over your private network. Orbis-to-Orbis transfers need approval on both servers. The original server stays
          unchanged.
        </p>
      )}
      {status.isPending ? <output>Reading transfer status…</output> : null}
      {status.isError ? (
        embedded && view.kind === 'receive' ? (
          <div className="host-transfer-actions">
            <InlineFeedback>{status.error.message}</InlineFeedback>
            <Button type="button" variant="outline" disabled={busy || status.isFetching} onClick={() => void status.refetch()}>
              Retry status
            </Button>
          </div>
        ) : (
          <InlineFeedback>{status.error.message}</InlineFeedback>
        )
      ) : null}
      {error ? <InlineFeedback>{error}</InlineFeedback> : null}
      {notice ? <output aria-live="polite">{notice}</output> : null}
      <div ref={stage} className="host-transfer-stage" data-direction={direction} key={`${view.kind}-${view.kind === 'receive' ? receiveStep : ''}`}>
        {view.kind === 'overview' ? (
          <>
            <div className="host-transfer-actions">
              {mode === 'both' ? (
                <Button type="button" variant="outline" disabled={busy || status.isError} onClick={() => go({ kind: 'offer' })}>
                  Create code
                </Button>
              ) : null}
              <Button type="button" variant="outline" disabled={busy || status.isError} onClick={() => go({ kind: 'receive' })}>
                Connect
              </Button>
            </div>
            {!offers.length && !jobs.length && !status.isPending ? (
              <p>Create a code on the source server, then enter it on the destination.</p>
            ) : null}
            {offers.map((offer) => (
              <article key={offer.id} className="host-transfer-job">
                <h3 tabIndex={-1}>{offerLabels[offer.status]}</h3>
                {stopped.has(offer.status) ? null : (
                  <p>
                    Expires {new Date(offer.expiresAt).toLocaleTimeString()} · {formatBackupBytes(offer.bytes)}
                  </p>
                )}
                {offer.status === 'awaiting-claim' ? (
                  <>
                    {code?.id === offer.id ? (
                      <>
                        <Fingerprint label="One-use transfer code" value={code.value} />
                        <div className="host-transfer-actions">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              void copyText(code.value).then((copied) => {
                                if (mounted.current)
                                  setNotice(
                                    copied
                                      ? 'Transfer code copied. Share it only with your destination server.'
                                      : 'Copy was unavailable. Select the transfer code and copy it manually.',
                                  );
                              });
                            }}
                          >
                            Copy code
                          </Button>
                        </div>
                      </>
                    ) : (
                      <p>The code was shown once. Cancel this offer and create a new code if you no longer have it.</p>
                    )}
                    <p>On the destination, enter this server’s private HTTPS address and the code. Keep the backup passphrase separate.</p>
                    <SourceCertificateInfo />
                  </>
                ) : null}
                {stopped.has(offer.status) ? null : <Fingerprint label="Source fingerprint" value={offer.sourceFingerprint} />}
                {offer.destinationFingerprint ? <Fingerprint label="Destination fingerprint" value={offer.destinationFingerprint} /> : null}
                {offer.status === 'awaiting-approval' ? (
                  <Button type="button" variant="outline" disabled={busy || status.isError} onClick={() => go({ kind: 'approve', offer })}>
                    Review destination
                  </Button>
                ) : null}
                {offer.status === 'approved' ? <p>On the destination, compare the source fingerprint and choose Start transfer.</p> : null}
                {offer.status === 'sending' || offer.status === 'complete' ? (
                  <RecoveryProgress
                    completed={offer.completedBytes}
                    total={offer.bytes}
                    settled={offer.status === 'complete'}
                    label="Encrypted backup sent"
                  />
                ) : null}
                {stopped.has(offer.status) ? null : (
                  <div className="host-transfer-actions">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        void run(async (signal) => {
                          const cancelled = await cancelTransferOffer(offer.id, signal);
                          if (mounted.current) rememberOffer(cancelled);
                        });
                      }}
                    >
                      Cancel offer
                    </Button>
                  </div>
                )}
              </article>
            ))}
            {jobs.map((job) => (
              <article key={job.id} className="host-transfer-job">
                <h3 tabIndex={-1}>{jobLabels[job.status]}</h3>
                <p className="host-transfer-address">{job.sourceOrigin}</p>
                <p>{job.message}</p>
                {job.status === 'awaiting-source-approval' ? (
                  <>
                    <Fingerprint label="Destination fingerprint · compare on source" value={job.destinationFingerprint} />
                    <Fingerprint label="Source fingerprint · compare with source" value={job.sourceFingerprint} />
                    <form
                      className="host-transfer-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (new FormData(event.currentTarget).get('confirm') !== 'yes') return;
                        event.currentTarget.reset();
                        void run(async (signal) => {
                          const started = await startTransfer(job, signal);
                          if (mounted.current) rememberJob(started);
                        });
                      }}
                    >
                      <Checkbox
                        className="host-transfer-confirm"
                        name="confirm"
                        value="yes"
                        required
                        disabled={busy || status.isError}
                        label="The source fingerprint matches, and I approved this destination on the source."
                      />
                      <Button type="submit" intent="primary" disabled={busy || status.isError}>
                        Start
                      </Button>
                    </form>
                  </>
                ) : null}
                {job.status === 'checking-approval' ? <RecoveryProgress label="Checking source approval" /> : null}
                {job.status === 'receiving' || job.status === 'complete' ? (
                  <RecoveryProgress
                    completed={job.completedBytes}
                    total={job.totalBytes}
                    settled={job.status === 'complete'}
                    label="Encrypted backup received"
                  />
                ) : null}
                <div className="host-transfer-actions">
                  {job.status === 'complete' ? (
                    <Button
                      type="button"
                      intent="primary"
                      disabled={busy || status.isError}
                      onClick={() => go({ kind: 'restore', importId: job.importId })}
                    >
                      Review
                    </Button>
                  ) : null}
                  {stopped.has(job.status) ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        void run(async (signal) => {
                          const cancelled = await cancelTransfer(job.id, signal);
                          if (mounted.current) rememberJob(cancelled);
                        });
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </>
        ) : (
          <form
            className="host-transfer-form"
            onSubmit={view.kind === 'receive' && receiveStep === 'source' ? reviewSource : submit}
            aria-labelledby={`${id}-action`}
          >
            {busy && view.kind === 'receive' ? <RecoveryProgress label="Connecting to source" /> : null}
            <h3
              id={`${id}-action`}
              className={embedded && view.kind === 'receive' && receiveStep === 'source' ? 'visually-hidden' : undefined}
              tabIndex={-1}
            >
              {view.kind === 'offer'
                ? 'Create a transfer code'
                : view.kind === 'approve'
                  ? 'Approve this destination'
                  : receiveStep === 'source'
                    ? 'Connect to the source'
                    : 'Verify your account'}
            </h3>
            {view.kind === 'offer' ? (
              <>
                <p>Choose a completed encrypted full backup. Nothing is sent until you approve the destination fingerprint.</p>
                {backups.isPending ? <output>Reading completed backups…</output> : null}
                {backups.isError ? <InlineFeedback>{backups.error.message}</InlineFeedback> : null}
                {!exports.length && !backups.isPending ? <p>Create an encrypted full backup in Full backup & recovery first.</p> : null}
                <div>
                  <Select name="backupId" required disabled={busy || !exports.length} defaultValue="">
                    <SelectTrigger id={`${id}-backup`} label="Encrypted full backup">
                      <SelectValue placeholder="Choose a completed backup" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="" disabled>
                        Choose a completed backup
                      </SelectItem>
                      {exports.map((job) => (
                        <SelectItem key={job.id} value={job.id}>
                          {new Date(job.createdAt).toLocaleString()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : view.kind === 'approve' ? (
              <>
                <p>Compare this value with the destination screen. Approval sends only the chosen encrypted backup.</p>
                <Fingerprint label="Destination fingerprint" value={view.offer.destinationFingerprint ?? ''} />
                <Fingerprint label="Source fingerprint" value={view.offer.sourceFingerprint} />
              </>
            ) : receiveStep === 'source' ? (
              <>
                <p>For an Orbis-to-Orbis transfer, enter the source’s private HTTPS address and one-use code.</p>
                <Input
                  label="Source server address"
                  name="sourceOrigin"
                  type="url"
                  placeholder="https://server.example"
                  required
                  maxLength={2048}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  value={sourceAddress}
                  onChange={(event) => changeSource(event.target.value)}
                />
                <div className="host-transfer-nearby">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    aria-expanded={nearbyOpen}
                    aria-controls={`${id}-nearby`}
                    onClick={() => setNearbyOpen(!nearbyOpen)}
                  >
                    Nearby servers
                  </Button>
                  {nearbyOpen ? (
                    <fieldset id={`${id}-nearby`} disabled={busy}>
                      <legend className="visually-hidden">Optional nearby source search</legend>
                      <NearbyServers onSelect={changeSource} />
                    </fieldset>
                  ) : null}
                </div>
                <Input
                  label="One-use transfer code"
                  name="code"
                  value={transferCode}
                  onChange={(event) => setTransferCode(event.currentTarget.value)}
                  required
                  pattern="[a-fA-F0-9]{64}"
                  minLength={64}
                  maxLength={64}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy}
                />
                <SourceCertificatePicker key={sourceAddress} disabled={busy} value={sourceCertificate} onChange={setSourceCertificate} />
              </>
            ) : (
              <ReceiveAccountVerification source={sourceAddress} code={transferCode} localCertificate={sourceCertificate !== null} disabled={busy} />
            )}
            {view.kind === 'receive' ? null : <Authentication disabled={busy} />}
            {view.kind === 'receive' ? null : (
              <Checkbox
                className="host-transfer-confirm"
                name="confirm"
                value="yes"
                required
                disabled={busy}
                label={
                  view.kind === 'offer'
                    ? 'I want to share this encrypted backup with a destination I approve.'
                    : view.kind === 'approve'
                      ? 'The destination fingerprint matches the screen on my destination server.'
                      : 'I want to receive this backup for review on this server.'
                }
              />
            )}
            <div className="host-transfer-actions">
              {view.kind === 'receive' && receiveStep === 'verify' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={(event) => {
                    event.currentTarget.form?.reset();
                    focusNext.current = { keyboard: event.currentTarget.matches(':focus-visible') };
                    setDirection(-1);
                    setReceiveStep('source');
                    setError(null);
                  }}
                >
                  Change source
                </Button>
              ) : embedded && mode === 'receive' ? null : (
                <Button type="button" variant="outline" disabled={busy} onClick={() => (onDismiss ? onDismiss() : go({ kind: 'overview' }))}>
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                intent="primary"
                disabled={
                  busy ||
                  status.isError ||
                  (view.kind === 'offer' && (!exports.length || backups.isError)) ||
                  (view.kind === 'receive' && sourceCertificate !== null && !sourceCertificate.confirmed)
                }
              >
                {busy
                  ? 'Checking…'
                  : view.kind === 'offer'
                    ? 'Create code'
                    : view.kind === 'approve'
                      ? 'Approve'
                      : receiveStep === 'source'
                        ? 'Continue'
                        : 'Connect'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
