import { useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useAppContext } from '@/context/app-context';
import { BackupEncryptionFields, backupEncryptionPassphrase } from '../system-backups/system-backups-settings';
import { approveRestoreRequest, rejectRestoreRequest, RestoreRequestScope, type IncomingRestoreRequest } from './receiver-request-api';
import './receiver-request-panel.css';

export function RequestFingerprint({ label, value }: { label: string; value: string }) {
  return (
    <div className="receiver-request-fingerprint">
      <span>{label}</span>
      <code>{value.match(/.{1,8}/g)?.join(' ')}</code>
    </div>
  );
}
export function SourceRequestReview({
  request,
  authority,
  disabled,
  onUpdate,
  onClose,
  restoreFocusTo,
}: {
  request: IncomingRestoreRequest | undefined;
  authority: object;
  disabled: boolean;
  onUpdate: (value: IncomingRestoreRequest) => void;
  onClose: () => void;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  const { user } = useAppContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountPassword, setAccountPassword] = useState(true);
  const form = useRef<HTMLFormElement>(null);
  const abort = useRef<AbortController | null>(null);
  const scope = useRef(new RestoreRequestScope());
  // biome-ignore lint/correctness/useExhaustiveDependencies: Authority changes must revoke pending work and clear credentials.
  useLayoutEffect(() => {
    scope.current.invalidate();
    abort.current?.abort();
    form.current?.reset();
    setBusy(false);
    setError(null);
    setAccountPassword(true);
    return () => {
      scope.current.invalidate();
      abort.current?.abort();
      form.current?.reset();
    };
  }, [authority, request?.id]);
  const close = () => {
    if (!busy) {
      form.current?.reset();
      onClose();
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!request || request.status !== 'awaiting-approval' || busy || disabled) return;
    const values = new FormData(event.currentTarget);
    const declining = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'reject';
    const credentials = {
      password: String(values.get('password') ?? ''),
      ...(values.get('totpCode') ? { totpCode: String(values.get('totpCode')) } : {}),
    };
    event.currentTarget.reset();
    setError(null);
    if (!credentials.password || (user?.totpEnabled && !/^\d{6}$/.test(credentials.totpCode ?? ''))) {
      setError('Enter your current account password and authentication code.');
      return;
    }
    let passphrase: string | undefined;
    if (!declining) {
      if (values.get('confirmDestination') !== 'yes') {
        setError('Compare and confirm the destination fingerprint.');
        return;
      }
      try {
        const key = backupEncryptionPassphrase(values, 'export', accountPassword);
        if (!accountPassword) passphrase = key;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Check the backup password.');
        return;
      }
    }
    const operation = new AbortController();
    abort.current = operation;
    const generation = scope.current.begin();
    setBusy(true);
    void (
      declining
        ? rejectRestoreRequest(request.id, credentials, operation.signal)
        : approveRestoreRequest(
            request,
            credentials,
            accountPassword ? 'source-account-password' : 'separate-passphrase',
            passphrase,
            operation.signal,
          )
    )
      .then((value) => {
        if (scope.current.current(generation)) onUpdate(value);
      })
      .catch((reason: unknown) => {
        if (scope.current.current(generation)) setError(reason instanceof Error ? reason.message : 'This request could not be approved.');
      })
      .finally(() => {
        if (scope.current.current(generation)) {
          setBusy(false);
          abort.current = null;
        }
      });
  };
  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        size="md"
        className="receiver-request-dialog"
        closeDisabled={busy}
        restoreFocusTo={restoreFocusTo}
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          if (restoreFocusTo.current?.matches(':focus-visible')) {
            event.preventDefault();
            form.current?.querySelector<HTMLInputElement>('input[name=password]')?.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Approve restore request</DialogTitle>
        </DialogHeader>
        <form className="modal-body receiver-request-form" ref={form} onSubmit={submit} noValidate>
          {request ? (
            <>
              <p>Compare with the destination screen. Approval creates a new encrypted backup; apps pause while their data is copied.</p>
              <RequestFingerprint label="Destination fingerprint" value={request.destinationFingerprint} />
              <RequestFingerprint label="Source fingerprint" value={request.sourceFingerprint} />
              <Input
                name="password"
                label="Your account password on this server"
                type="password"
                autoComplete="current-password"
                maxLength={1024}
                required
                disabled={busy || disabled}
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
                  disabled={busy || disabled}
                />
              ) : null}
              <BackupEncryptionFields
                id="source-request-encryption"
                useAccountPassword={accountPassword}
                disabled={busy || disabled}
                onChange={(value) => {
                  setAccountPassword(value);
                  setError(null);
                }}
              />
              <Checkbox
                name="confirmDestination"
                value="yes"
                required
                disabled={busy || disabled}
                label="The destination fingerprint matches its screen."
              />
              {request.status !== 'awaiting-approval' ? (
                <InlineFeedback>This request is no longer awaiting approval. Refresh its status.</InlineFeedback>
              ) : null}
              {error ? <InlineFeedback>{error}</InlineFeedback> : null}
              <div className="receiver-request-actions">
                <Button type="button" variant="outline" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  name="decision"
                  value="approve"
                  intent="primary"
                  disabled={busy || disabled || request.status !== 'awaiting-approval'}
                >
                  {busy ? 'Checking…' : 'Approve'}
                </Button>
              </div>
              <Button
                type="submit"
                name="decision"
                value="reject"
                variant="link"
                formNoValidate
                disabled={busy || disabled || request.status !== 'awaiting-approval'}
              >
                Decline request
              </Button>
            </>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
