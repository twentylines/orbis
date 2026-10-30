import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Input } from '@/components/ui/Input';
import { ClusterPairingError, completeClusterPairing, type ClusterPairConnection, type ClusterPairResult } from './cluster-pairing-api';

export function ClusterRemoteAccountDialog({
  connection,
  onClose,
  onPaired,
}: {
  connection: ClusterPairConnection;
  onClose: () => void;
  onPaired: (result: ClusterPairResult) => void;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || uncertain || !password) return;
    const body = { pendingId: connection.pendingId, password, ...(totp ? { totpCode: totp } : {}) };
    setPassword('');
    setTotp('');
    setPending(true);
    setError('');
    try {
      const result = await completeClusterPairing(body);
      if (!active.current) return;
      if (result.id !== connection.id)
        throw new ClusterPairingError(503, 'Pairing was not confirmed. Check cluster status on both servers before reconnecting.');
      onPaired(result);
    } catch (failure) {
      if (!active.current) return;
      setError(failure instanceof Error ? failure.message : 'Pairing was not confirmed. Check cluster status on both servers before reconnecting.');
      if (!(failure instanceof ClusterPairingError) || ![400, 401, 403, 429].includes(failure.status)) setUncertain(true);
    } finally {
      if (active.current) {
        setPassword('');
        setTotp('');
        setPending(false);
      }
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        size="sm"
        className="cluster-account-dialog"
        closeDisabled={pending}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement && event.target.matches(':focus-visible'))
            event.target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        }}
      >
        <DialogHeader>
          <DialogTitle>Authorize {connection.name}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Connected to <strong>{connection.origin}</strong>. Enter the password for the account that created the code on that server. Pairing lets
          this admin server manage its apps, status and updates.
        </DialogDescription>
        <form onSubmit={(event) => void submit(event)}>
          <div className="cluster-settings-form cluster-account-fields">
            <Input
              className="cluster-settings-control"
              id="cluster-remote-password"
              maxLength={1024}
              label={`${connection.name} account password`}
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending || uncertain}
              required
            />
            {connection.totpRequired ? (
              <Input
                className="cluster-settings-control"
                id="cluster-remote-totp"
                label="Authentication code on that server"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={totp}
                onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={pending || uncertain}
                required
              />
            ) : null}
            {error ? <InlineFeedback className="cluster-pair-error">{error}</InlineFeedback> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {uncertain ? 'Close' : 'Cancel'}
            </Button>
            <Button type="submit" intent="primary" disabled={pending || uncertain || !password || (connection.totpRequired && totp.length !== 6)}>
              {pending ? 'Authorizing…' : 'Authorize pairing'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
