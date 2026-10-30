import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { RecoveryProgress } from '@/components/recovery-progress/recovery-progress';
import { NearbyServers } from '@/components/nearby-servers/nearby-servers';
import { useAppContext } from '@/context/app-context';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { SystemBackupsSettings } from '../system-backups/system-backups-settings';
import { SourceCertificatePicker } from './source-certificate-picker';
import { sourceOrigin } from './transfer-api';
import { confirmedSourceCertificate, type SourceCertificate } from './source-certificate';
import { RequestFingerprint } from './source-request-review';
import { useRestoreRequests } from './receiver-request-context';
import {
  cancelRestoreRequest,
  createRestoreRequest,
  RestoreRequestScope,
  restoreRequestStopped,
  restoreExportStage,
  startRestoreRequest,
  type OutgoingRestoreRequest,
} from './receiver-request-api';
import './receiver-request-panel.css';

export function receiverRequestHoldsWindow(job: OutgoingRestoreRequest | null, busy: boolean, available: boolean) {
  return available && (busy || Boolean(job && !restoreRequestStopped.has(job.status)));
}
export function dismissUnavailableRequest(
  available: boolean,
  clear: () => void,
  activity: ((active: boolean) => void) | undefined,
  dismiss: (() => void) | undefined,
) {
  if (available) return false;
  clear();
  activity?.(false);
  dismiss?.();
  return true;
}
type Props = { embedded?: boolean; onActivityChange?: (active: boolean) => void; onDismiss?: () => void };
function resumableRequestStatus(status: OutgoingRestoreRequest['status']) {
  switch (status) {
    case 'awaiting-source-approval':
      return 'Awaiting approval';
    case 'checking-approval':
      return 'Checking approval';
    case 'source-exporting':
      return 'Sending backup';
    case 'receiving':
      return 'Receiving backup';
    case 'complete':
      return 'Ready to review';
    default:
      return status;
  }
}
export function ReceiverRequestWizard({ onActivityChange, onDismiss }: Props) {
  const { user } = useAppContext();
  const requests = useRestoreRequests();
  const id = useId();
  const reduced = useReducedMotion();
  const [stage, setStage] = useState<'source' | 'verify' | 'request' | 'review'>('source');
  const [address, setAddress] = useState('');
  const [certificate, setCertificate] = useState<SourceCertificate | null>(null);
  const [current, setCurrent] = useState<OutgoingRestoreRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const abort = useRef<AbortController | null>(null);
  const scope = useRef(new RestoreRequestScope());
  const activity = useRef(onActivityChange);
  activity.current = onActivityChange;
  const job = requests?.snapshot.outgoing.find((value) => value.id === current?.id) ?? current;
  const pending = Boolean(job && !restoreRequestStopped.has(job.status));
  const resumableRequests =
    requests?.snapshot.outgoing.filter(
      (value) => value.expiresAt > Date.now() && (!restoreRequestStopped.has(value.status) || value.status === 'complete'),
    ) ?? [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: Authority changes must revoke pending work and clear credentials.
  useLayoutEffect(() => {
    scope.current.invalidate();
    abort.current?.abort();
    form.current?.reset();
    setBusy(false);
    setError(null);
    setCertificate(null);
    setCurrent(null);
    setResumeOpen(false);
    setAddress('');
    setStage('source');
    return () => {
      scope.current.invalidate();
      abort.current?.abort();
      form.current?.reset();
      activity.current?.(false);
    };
  }, [requests?.authority]);
  useLayoutEffect(() => {
    if (stage !== 'review' && requests?.available === false) {
      scope.current.invalidate();
      abort.current?.abort();
      form.current?.reset();
      setBusy(false);
      setCurrent(null);
      setResumeOpen(false);
      setStage('source');
    }
  }, [requests?.available, stage]);
  useLayoutEffect(() => {
    if (stage !== 'review') activity.current?.(receiverRequestHoldsWindow(job, busy, requests?.available === true));
  }, [busy, job, requests?.available, stage]);
  const operation = (action: (signal: AbortSignal) => Promise<OutgoingRestoreRequest>, next?: () => void) => {
    if (busy || !requests?.available) return;
    const generation = scope.current.begin();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    void action(controller.signal)
      .then((value) => {
        if (!scope.current.current(generation)) return;
        requests.remember(value);
        setCurrent(value);
        next?.();
      })
      .catch((reason: unknown) => {
        if (scope.current.current(generation))
          setError(reason instanceof Error ? reason.message : 'The restore request could not be completed. Refresh status before retrying.');
      })
      .finally(() => {
        if (scope.current.current(generation)) {
          setBusy(false);
          abort.current = null;
        }
      });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (stage === 'source') {
      try {
        setAddress(sourceOrigin(address));
        confirmedSourceCertificate(certificate);
        setError(null);
        setStage('verify');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Check the private HTTPS source address.');
      }
      return;
    }
    const values = new FormData(event.currentTarget);
    event.currentTarget.reset();
    if (stage === 'verify') {
      const password = String(values.get('password') ?? '');
      const totpCode = String(values.get('totpCode') ?? '');
      if (!password || (user?.totpEnabled && !/^\d{6}$/.test(totpCode)) || values.get('confirmRequest') !== 'yes') {
        setError('Confirm this request with your account on this server.');
        return;
      }
      operation(
        (signal) => createRestoreRequest(address, { password, ...(totpCode ? { totpCode } : {}) }, certificate, signal),
        () => {
          setCertificate(null);
          setStage('request');
        },
      );
    } else if (stage === 'request' && job?.canStart) {
      if (values.get('confirmSource') !== 'yes') {
        setError('Compare and confirm the source fingerprint before continuing.');
        return;
      }
      operation((signal) => startRestoreRequest(job, signal));
    }
  };
  const cancel = () => {
    if (
      dismissUnavailableRequest(
        requests?.available === true,
        () => {
          scope.current.invalidate();
          abort.current?.abort();
          form.current?.reset();
          setBusy(false);
          setResumeOpen(false);
        },
        activity.current,
        onDismiss,
      )
    )
      return;
    if (busy) return;
    if (job && pending)
      operation(
        (signal) => cancelRestoreRequest(job.id, signal),
        () => onDismiss?.(),
      );
    else {
      form.current?.reset();
      onDismiss?.();
    }
  };
  if (user?.operator !== true) return null;
  if (!requests) return <InlineFeedback>Restore requests are unavailable. Reopen this window from an operator session.</InlineFeedback>;
  if (stage === 'review' && job?.status === 'complete')
    return <SystemBackupsSettings restoreOnly embedded initialImportId={job.importId} onActivityChange={onActivityChange} />;
  if (!requests.available)
    return (
      <div className="receiver-request-card">
        <InlineFeedback>
          Restore requests are unavailable. Sign in again or reconnect to this server. Any accepted request may continue until it expires; remote
          cancellation has not been confirmed.
        </InlineFeedback>
        <div className="receiver-request-actions">
          <Button type="button" variant="outline" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  return (
    <div className="receiver-request-card">
      <AnimatePresence initial={false} mode="wait">
        <motion.form
          key={stage}
          ref={form}
          className="receiver-request-form"
          onSubmit={submit}
          noValidate
          initial={{ opacity: 0, x: reduced ? 0 : 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: reduced ? 0 : -16 }}
          transition={{ duration: reduced ? 0 : 0.2 }}
        >
          {stage === 'source' ? (
            <>
              <p>Choose the Orbis server to restore from. Its operator will approve your request on that server.</p>
              {resumableRequests.length ? (
                <section className="receiver-request-resume">
                  <Button
                    className="receiver-request-resume-trigger"
                    type="button"
                    variant="outline"
                    aria-expanded={resumeOpen}
                    aria-controls={`${id}-resume-list`}
                    onClick={() => setResumeOpen((open) => !open)}
                  >
                    Resume ({resumableRequests.length})
                  </Button>
                  <AnimatePresence initial={false}>
                    {resumeOpen ? (
                      <motion.ul
                        className="receiver-request-list"
                        id={`${id}-resume-list`}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: reduced ? 0 : 0.16 }}
                      >
                        {resumableRequests.map((value) => (
                          <li key={value.id}>
                            <div className="receiver-request-resume-copy">
                              <strong className="host-transfer-address">{value.sourceOrigin}</strong>
                              <span>{resumableRequestStatus(value.status)}</span>
                              <time dateTime={new Date(value.expiresAt).toISOString()}>
                                Available until {new Date(value.expiresAt).toLocaleString()}
                              </time>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => {
                                setCurrent(value);
                                setStage('request');
                                setError(null);
                              }}
                            >
                              Continue
                            </Button>
                          </li>
                        ))}
                      </motion.ul>
                    ) : null}
                  </AnimatePresence>
                </section>
              ) : null}
              <NearbyServers
                onSelect={(origin) => {
                  setAddress(origin);
                  setCertificate(null);
                  setError(null);
                }}
              />
              <Input
                name="sourceOrigin"
                type="url"
                label="Source private HTTPS address"
                placeholder="https://orbis.home.arpa"
                value={address}
                onChange={(event) => {
                  setAddress(event.currentTarget.value);
                  setCertificate(null);
                  setError(null);
                }}
                required
                maxLength={2048}
                disabled={busy}
              />
              <SourceCertificatePicker key={`${id}:${address}`} disabled={busy} value={certificate} onChange={setCertificate} />
            </>
          ) : stage === 'verify' ? (
            <>
              <p>Confirm with your account on this server. Your password stays here; the source operator signs in separately.</p>
              <strong className="host-transfer-address">{address}</strong>
              <Input
                name="password"
                label="Your account password on this server"
                type="password"
                autoComplete="current-password"
                maxLength={1024}
                required
                disabled={busy}
              />
              {user?.totpEnabled ? (
                <Input
                  name="totpCode"
                  label="Authentication code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  disabled={busy}
                />
              ) : null}
              <Checkbox name="confirmRequest" value="yes" required disabled={busy} label="Request an encrypted backup for review on this server." />
              {busy ? <RecoveryProgress label="Connecting to source" /> : null}
            </>
          ) : job ? (
            <>
              <strong className="host-transfer-address">{job.sourceOrigin}</strong>
              {job.canStart ? (
                <>
                  <p>Compare these fingerprints with the source operator before continuing.</p>
                  <RequestFingerprint label="Source fingerprint" value={job.sourceFingerprint} />
                  <RequestFingerprint label="Destination fingerprint" value={job.destinationFingerprint} />
                  <Checkbox name="confirmSource" value="yes" required disabled={busy} label="The source fingerprint matches its screen." />
                </>
              ) : job.status === 'complete' ? (
                <>
                  <RecoveryProgress label="Encrypted backup received" completed={job.completedBytes} total={job.totalBytes} settled />
                  <p>
                    {job.encryption === 'source-account-password'
                      ? 'Continue with the source account password used when this backup was approved.'
                      : 'Continue with the separate backup password chosen on the source.'}{' '}
                    Review the backup before applying it.
                  </p>
                </>
              ) : (
                <>
                  {['awaiting-source-approval', 'checking-approval'].includes(job.status) ? (
                    <>
                      <RecoveryProgress label="Waiting for source approval" />
                      <p>Open Orbis on the source server and review its restore request notice.</p>
                      <RequestFingerprint label="Source fingerprint" value={job.sourceFingerprint} />
                      <RequestFingerprint label="Destination fingerprint" value={job.destinationFingerprint} />
                    </>
                  ) : null}
                  {job.status === 'source-exporting' ? (
                    <RecoveryProgress
                      label={restoreExportStage(job.exportProgress?.stage)}
                      completed={job.exportProgress?.completedBytes}
                      total={job.exportProgress?.totalBytes}
                    />
                  ) : null}
                  {job.status === 'receiving' ? (
                    <RecoveryProgress label="Receiving encrypted backup" completed={job.completedBytes} total={job.totalBytes} />
                  ) : null}
                  {restoreRequestStopped.has(job.status) ? <InlineFeedback>{job.message}</InlineFeedback> : null}
                </>
              )}
            </>
          ) : null}
          {requests.available ? null : (
            <InlineFeedback>
              This server’s restore request API is unavailable. Sign in as an operator or update both Orbis servers, then reopen this window.
            </InlineFeedback>
          )}
          {error || requests.error ? <InlineFeedback>{error ?? requests.error}</InlineFeedback> : null}
          <div className="receiver-request-actions">
            <Button type="button" variant="outline" disabled={busy} onClick={cancel}>
              {busy ? 'Working…' : 'Cancel'}
            </Button>
            {stage === 'source' || stage === 'verify' || job?.canStart ? (
              <Button type="submit" intent="primary" disabled={busy || !requests.available}>
                Continue
              </Button>
            ) : job?.status === 'complete' ? (
              <Button type="button" intent="primary" onClick={() => setStage('review')}>
                Continue
              </Button>
            ) : (
              <Button type="button" variant="outline" disabled={busy || !requests.available} onClick={requests.refresh}>
                Refresh
              </Button>
            )}
          </div>
          {stage === 'verify' && !busy ? (
            <Button
              type="button"
              variant="link"
              onClick={() => {
                form.current?.reset();
                setError(null);
                setStage('source');
              }}
            >
              Change source
            </Button>
          ) : null}
        </motion.form>
      </AnimatePresence>
    </div>
  );
}
