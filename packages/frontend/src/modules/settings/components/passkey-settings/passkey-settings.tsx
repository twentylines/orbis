import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import {
  addPasskey,
  browserPasskeyReason,
  cancelPasskeyCeremony,
  passkeyErrorMessage,
  passkeyListOptions,
  removePasskey,
  updatePasskeyPolicy,
  warmPasskeyClient,
  type PasskeyCredential,
} from '@/modules/auth/passkeys/passkey-api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconFingerprint, IconPlus, IconTrash } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState } from 'react';
import { SecureAccessSetup } from '../secure-access/secure-access';

export function PasskeySettings({ totpEnabled }: { totpEnabled: boolean }) {
  const listOptions = passkeyListOptions();
  const list = useQuery({ ...listOptions, queryKey: [...listOptions.queryKey, totpEnabled] });
  const queryClient = useQueryClient();
  const [browserReason] = useState(browserPasskeyReason);
  const [dialog, setDialog] = useState<'add' | 'policy' | PasskeyCredential | null>(null);
  const [requireCode, setRequireCode] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const running = useRef(false);
  const generation = useRef(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  const policyControl = useRef<HTMLButtonElement | null>(null);
  const formId = useId();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
      if (running.current) cancelPasskeyCeremony();
    };
  }, []);
  const available = Boolean(!browserReason && list.data?.available);
  const unavailable = browserReason ?? list.data?.reason;
  const open = (value: 'add' | 'policy' | PasskeyCredential, control: HTMLButtonElement) => {
    opener.current = control;
    setError('');
    setNotice('');
    setName('');
    setPassword('');
    setTotpCode('');
    setDialog(value);
  };
  const close = () => {
    if (pending && dialog !== 'add') return;
    generation.current++;
    if (running.current) cancelPasskeyCeremony();
    running.current = false;
    setPending(false);
    setDialog(null);
    setName('');
    setPassword('');
    setTotpCode('');
    setError('');
  };
  const submit = async () => {
    if (!dialog || running.current || !password || (totpEnabled && !/^\d{6}$/.test(totpCode)) || (dialog === 'add' && !name.trim())) return;
    const version = ++generation.current;
    const current = () => active.current && generation.current === version;
    running.current = true;
    setPending(true);
    setError('');
    const confirmation = { password, totpCode: totpEnabled ? totpCode : undefined };
    setPassword('');
    setTotpCode('');
    try {
      if (dialog === 'add') {
        await addPasskey({ ...confirmation, name: name.trim() }, current);
        await queryClient.invalidateQueries({ queryKey: passkeyListOptions().queryKey });
        if (current()) {
          setPending(false);
          setDialog(null);
          setNotice('Passkey added.');
        }
      } else if (dialog === 'policy') {
        await updatePasskeyPolicy({ ...confirmation, requireTotpAfterPasskey: requireCode });
        await queryClient.invalidateQueries({ queryKey: passkeyListOptions().queryKey });
        if (current()) {
          setPending(false);
          setDialog(null);
          setNotice('Passkey verification updated.');
        }
      } else {
        await removePasskey({ ...confirmation, id: dialog.id });
        if (current()) window.location.replace('/login');
      }
    } catch (reason) {
      if (current()) setError(passkeyErrorMessage(reason));
    } finally {
      if (current()) {
        running.current = false;
        setPending(false);
      }
    }
  };

  return (
    <section className="settings-passkeys" aria-labelledby={`${formId}-heading`} data-dialog-focus-fallback tabIndex={-1}>
      <div className="settings-security-heading">
        <IconFingerprint aria-hidden="true" />
        <h2 id={`${formId}-heading`}>Passkeys</h2>
      </div>
      <p className="text-muted">
        Use your device, password manager or security key to sign in. Passkeys sign you in directly unless you choose extra verification below. Your
        password stays available and follows your account’s two-factor settings.
      </p>
      <SecureAccessSetup available={available} checking={list.isFetching} onCheck={() => list.refetch()} />
      {list.isPending && <output>Reading your passkeys…</output>}
      {list.isError && (
        <div className="settings-passkey-error">
          <p role="alert">Your passkeys could not be read. {passkeyErrorMessage(list.error)}</p>
          <Button onClick={() => void list.refetch()}>Try again</Button>
        </div>
      )}
      {list.data && list.data.credentials.length === 0 && <p className="settings-passkey-empty">No passkeys added yet.</p>}
      {list.data && list.data.credentials.length > 0 && (
        <ul className="settings-passkey-list">
          {list.data.credentials.map((credential) => (
            <li key={credential.id}>
              <div>
                <strong>{credential.name}</strong>
                <div className="settings-passkey-dates">
                  <span>Added {new Date(credential.createdAt).toLocaleDateString()}</span>
                  <span>{credential.lastUsedAt ? `Last used ${new Date(credential.lastUsedAt).toLocaleDateString()}` : 'Not used yet'}</span>
                </div>
              </div>
              <Button
                disabled={!list.data?.available || pending}
                onClick={(event) => open(credential, event.currentTarget)}
                aria-label={`Remove ${credential.name}`}
              >
                <IconTrash className="orbis-remove-icon" size={18} aria-hidden="true" />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        disabled={!available || pending}
        onClick={(event) => open('add', event.currentTarget)}
        onPointerEnter={warmPasskeyClient}
        onFocus={warmPasskeyClient}
      >
        <IconPlus size={18} aria-hidden="true" />
        Add passkey
      </Button>
      {notice && <output className="settings-passkey-note">{notice}</output>}
      {unavailable && <p className="settings-passkey-note">{unavailable}</p>}
      <p className="settings-passkey-note">
        Keep a working password or another passkey. Losing every sign-in method requires recovery on the server; Orbis does not send password-reset
        emails.
      </p>
      {list.data?.policy && (
        <div className="settings-passkey-policy">
          <Switch
            ref={policyControl}
            checked={list.data.policy.requireTotpAfterPasskey}
            disabled={
              !list.data.available || pending || (!list.data.policy.requireTotpAfterPasskey && (!totpEnabled || list.data.credentials.length === 0))
            }
            label="Require an account code after a passkey"
            aria-describedby={`${formId}-policy-help`}
            onCheckedChange={(checked) => {
              if (policyControl.current) {
                setRequireCode(checked);
                open('policy', policyControl.current);
              }
            }}
          />
          <p id={`${formId}-policy-help`} className="settings-passkey-note">
            {totpEnabled
              ? list.data.credentials.length === 0
                ? 'Add a passkey before enabling extra verification.'
                : 'Optional extra verification using your existing authenticator app. This is off by default.'
              : 'Enable account two-factor verification below before adding an extra code to passkey sign-in.'}
          </p>
        </div>
      )}

      <Dialog
        open={dialog !== null}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent
          size="sm"
          className="passkey-dialog"
          aria-busy={pending || undefined}
          closeDisabled={pending && dialog !== 'add'}
          onCloseAutoFocus={(event) => {
            if (opener.current?.isConnected && !opener.current.disabled) {
              event.preventDefault();
              opener.current.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{dialog === 'add' ? 'Add a passkey' : dialog === 'policy' ? 'Passkey verification' : 'Remove passkey'}</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
              className="settings-passkey-form"
            >
              <p>
                {dialog === 'add'
                  ? 'Confirm your account, then follow your browser’s instructions to save a passkey.'
                  : dialog === 'policy'
                    ? requireCode
                      ? 'Require your existing account verification code after every passkey sign-in? Confirm your account to enable this extra step.'
                      : 'Let a verified passkey sign you in directly? Your password will still follow your account’s two-factor settings. Confirm your account to save this change.'
                    : `Remove “${typeof dialog === 'object' && dialog ? dialog.name : ''}” from this account? Every account session will be signed out. You can also delete the saved passkey from your password manager.`}
              </p>
              {dialog === 'add' && (
                <Input
                  name={`${formId}-name`}
                  label="Passkey name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={60}
                  required
                  disabled={pending}
                  autoComplete="off"
                  placeholder="My laptop"
                />
              )}
              <Input
                name={`${formId}-password`}
                label="Current password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                disabled={pending}
                autoComplete="current-password"
              />
              {totpEnabled && (
                <Input
                  name={`${formId}-totp`}
                  label="Account verification code"
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ''))}
                  maxLength={6}
                  pattern="[0-9]{6}"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  disabled={pending}
                />
              )}
              {pending && (
                <output>
                  {dialog === 'add' ? 'Confirm the passkey in your browser…' : dialog === 'policy' ? 'Saving verification…' : 'Removing the passkey…'}
                </output>
              )}
              {error && (
                <p className="settings-passkey-alert" role="alert">
                  {error}
                </p>
              )}
            </form>
          </DialogDescription>
          <DialogFooter>
            <Button type="button" disabled={pending && dialog !== 'add'} onClick={close}>
              Cancel
            </Button>
            <Button
              intent={dialog === 'add' || dialog === 'policy' ? 'primary' : 'danger'}
              type="submit"
              form={formId}
              disabled={pending || !password || (dialog === 'add' && !name.trim()) || (totpEnabled && !/^\d{6}$/.test(totpCode))}
            >
              {typeof dialog === 'object' && dialog ? <IconTrash className="orbis-remove-icon" size={18} aria-hidden="true" /> : null}
              {dialog === 'add' ? 'Add passkey' : dialog === 'policy' ? 'Save' : 'Remove and sign out'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
