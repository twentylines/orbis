import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { RecoveryScene } from '@/components/recovery-progress/recovery-scene';
import { readOperationStatus } from '@/components/recovery-progress/operation-status';
import { preferenceStorageKey } from '@/desktop/appearance-cache';
import { themePackCacheKey } from '@/modules/theme-packs/theme-pack-cache';
import { browserPasskeyReason, cancelPasskeyCeremony, passkeyErrorMessage } from '@/modules/auth/passkeys/passkey-api';
import { resetPasskeyOptions, submitReset, type ResetAccounts } from './reset-api';
import './system-reset.css';

export function openResetOnboarding() {
  try {
    localStorage.removeItem(preferenceStorageKey);
    localStorage.removeItem(themePackCacheKey);
  } catch {
    /* Server preferences remain authoritative. */
  }
  window.location.assign('/');
}
export function ResetAccountChoices({ value, onChange }: { value: ResetAccounts | null; onChange: (value: ResetAccounts) => void }) {
  return (
    <fieldset className="system-reset-choices">
      <legend>Sign-in accounts</legend>
      <label>
        <input type="radio" name="reset-accounts" value="keep" checked={value === 'keep'} onChange={() => onChange('keep')} />
        <span>
          <strong>Keep accounts</strong>
          <span>Keep passwords, passkeys and two-factor authentication.</span>
        </span>
      </label>
      <label>
        <input type="radio" name="reset-accounts" value="remove" checked={value === 'remove'} onChange={() => onChange('remove')} />
        <span>
          <strong>Remove accounts</strong>
          <span>Remove every Orbis sign-in account and create a new operator during setup.</span>
        </span>
      </label>
    </fieldset>
  );
}
export function SystemResetWizard({ open, onClose, recovery = false }: { open: boolean; onClose: () => void; recovery?: boolean }) {
  const [step, setStep] = useState(0);
  const [accounts, setAccounts] = useState<ResetAccounts | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const formId = useId();
  const wasOpen = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      setStep(0);
      setAccounts(null);
      setConfirmation('');
      setError(null);
    }
    wasOpen.current = open;
  }, [open]);
  useEffect(
    () => () => {
      pending.current?.abort();
      cancelPasskeyCeremony();
    },
    [],
  );
  useEffect(() => {
    if (!accepted) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const status = await readOperationStatus(controller.signal);
        if (controller.signal.aborted) return;
        setReconnecting(false);
        if (status.state === 'idle' && status.supported) {
          openResetOnboarding();
          return;
        }
      } catch {
        if (!controller.signal.aborted) setReconnecting(true);
      }
      if (!controller.signal.aborted) timer = setTimeout(check, 1200);
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [accepted]);
  const reset = async (method: 'password' | 'passkey') => {
    if (busy || !accounts || confirmation !== 'RESET ORBIS') return;
    const values = new FormData(form.current ?? undefined);
    const password = String(values.get('password') ?? '');
    const totpCode = String(values.get('totpCode') ?? '');
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    pending.current = controller;
    form.current?.reset();
    try {
      if (method === 'password')
        await submitReset(accounts, confirmation, { method, password, ...(totpCode ? { totpCode } : {}) }, controller.signal, recovery);
      else {
        const reason = browserPasskeyReason();
        if (reason) throw new Error(reason);
        const options = await resetPasskeyOptions(accounts, controller.signal);
        if (options.requiresTotp && !totpCode) throw new Error('Enter the current authentication code before using your passkey.');
        const client = await import('@simplewebauthn/browser');
        controller.signal.throwIfAborted();
        const response = await client.startAuthentication({ optionsJSON: options.options }).catch((failure) => {
          throw new Error(passkeyErrorMessage(failure));
        });
        controller.signal.throwIfAborted();
        await submitReset(
          accounts,
          confirmation,
          { method, challengeId: options.challengeId, response, ...(totpCode ? { totpCode } : {}) },
          controller.signal,
          recovery,
        );
      }
      setAccepted(true);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Reset was not confirmed. Check server status before retrying.');
    } finally {
      setBusy(false);
      pending.current = null;
      setConfirmation('');
    }
  };
  if (accepted)
    return (
      <RecoveryScene
        title="Resetting Orbis"
        status={reconnecting ? 'Reconnecting' : 'Resetting preferences'}
        detail={reconnecting ? 'Waiting for confirmed server status.' : undefined}
        active
        variant="onboarding"
        footer="Installed applications and their data are kept."
      />
    );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent
        size="sm"
        className="system-reset-dialog"
        closeDisabled={busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{step === 2 ? (recovery ? 'Recover reset' : 'Reset Orbis?') : 'Reset Orbis'}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="system-reset-intro">
          {step === 0
            ? 'Return Orbis to setup. Installed applications and their data are always kept.'
            : step === 1
              ? 'Choose what happens to your Orbis sign-in accounts.'
              : 'This permanently erases Orbis preferences and saved links.'}
        </DialogDescription>
        <div className="system-reset-body">
          {step === 0 ? (
            <>
              <p>Appearance, workspace, setup progress, update preferences and settings-sync consent will be cleared.</p>
              <p>
                App settings, storage, network access, installed software and server pairing trust stay in place so your applications keep working.
              </p>
              {recovery ? (
                <InlineFeedback variant="warning">
                  An interrupted reset needs confirmation. Choose the same account option as the original reset.
                </InlineFeedback>
              ) : null}
            </>
          ) : step === 1 ? (
            <ResetAccountChoices value={accounts} onChange={setAccounts} />
          ) : (
            <>
              <InlineFeedback variant="danger">
                {accounts === 'remove'
                  ? 'Remove all Orbis accounts, passwords, passkeys and two-factor settings.'
                  : 'Accounts and sign-in security are kept.'}{' '}
                Apps and their data are kept.
              </InlineFeedback>
              <form
                id={formId}
                ref={form}
                onSubmit={(event) => {
                  event.preventDefault();
                  void reset('password');
                }}
                className="system-reset-form"
              >
                <Input
                  name="reset-confirmation"
                  label="Type RESET ORBIS to confirm"
                  autoComplete="off"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={busy}
                />
                <Input
                  name="password"
                  label="Current account password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={1024}
                  disabled={busy}
                />
                <Input
                  name="totpCode"
                  label="Authentication code if enabled"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  disabled={busy}
                />
              </form>
            </>
          )}
          {error ? <InlineFeedback>{error}</InlineFeedback> : null}
        </div>
        <DialogFooter className="system-reset-actions">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              if (step) {
                setStep(step - 1);
                setConfirmation('');
              } else onClose();
            }}
          >
            {step ? 'Back' : 'Cancel'}
          </Button>
          {step < 2 ? (
            <Button
              type="button"
              disabled={step === 1 && !accounts}
              onClick={() => {
                setStep(step + 1);
                setError(null);
              }}
            >
              Next
            </Button>
          ) : (
            <>
              <Button type="submit" form={formId} intent="danger" disabled={busy || confirmation !== 'RESET ORBIS'} aria-busy={busy}>
                Reset
              </Button>
              <Button
                type="button"
                variant="outline"
                intent="danger"
                disabled={busy || confirmation !== 'RESET ORBIS'}
                onClick={() => void reset('passkey')}
              >
                Passkey
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function SystemResetPanel() {
  const [open, setOpen] = useState(false);
  return (
    <section id="setting-system-reset" className="system-reset-panel">
      <div>
        <h3>Reset Orbis</h3>
        <p>Return to setup while keeping installed applications and their data.</p>
      </div>
      <Button type="button" variant="outline" intent="danger" onClick={() => setOpen(true)}>
        Reset
      </Button>
      <SystemResetWizard open={open} onClose={() => setOpen(false)} />
    </section>
  );
}
