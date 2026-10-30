import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { IconCopy, IconPlus, IconServer, IconTrash } from '@tabler/icons-react';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { clusterRequest, useCluster } from '@/desktop/cluster';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useAppContext } from '@/context/app-context';
import { copyText } from '@/lib/clipboard';
import { ClusterSyncSettings } from './cluster-sync-settings';
import { NearbyServers } from '@/components/nearby-servers/nearby-servers';
import { NearbyVisibility } from '@/components/nearby-servers/nearby-visibility';
import { displayCertificateFingerprint, readSourceCertificate, type SourceCertificate } from '@/modules/host-transfer/source-certificate';
import {
  createClusterInvitation,
  connectClusterServer,
  clusterPairingAccess,
  type ClusterPairRequest,
  type ClusterPairConnection,
} from './cluster-pairing-api';
import { authorityRequestGate, certificateReadGate, pairingConnectionRequest, requestScope, type PairingRequestScope } from './cluster-pairing-state';
import { ClusterRemoteAccountDialog } from './cluster-remote-account-dialog';
import './cluster-settings.css';

type Invitation = { code: string; expiresAt: string };

type ClusterPairingCertificateProps = {
  mode: 'system' | 'peer';
  https: boolean;
  busy: boolean;
  certificate: SourceCertificate | null;
  fileName: string;
  confirmed: boolean;
  onMode: (mode: 'system' | 'peer') => void;
  onFile: (file?: File) => void;
  onConfirm: (confirmed: boolean) => void;
};
export function ClusterPairingCertificate({
  mode,
  https,
  busy,
  certificate,
  fileName,
  confirmed,
  onMode,
  onFile,
  onConfirm,
}: ClusterPairingCertificateProps) {
  return (
    <>
      <Select value={mode} onValueChange={(value) => onMode(value === 'peer' ? 'peer' : 'system')} disabled={busy || !https}>
        <SelectTrigger label="HTTPS certificate">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">Use normal HTTPS trust</SelectItem>
          <SelectItem value="peer">Compare an uploaded public certificate</SelectItem>
        </SelectContent>
      </Select>
      {mode === 'peer' ? (
        <div className="cluster-pair-certificate">
          <label htmlFor="cluster-peer-certificate">Other server’s public certificate</label>
          <p>
            Choose one public CA root or self-signed certificate. Compare the fingerprint on that server before confirming. Its HTTPS hostname must
            match.
          </p>
          <input
            id="cluster-peer-certificate"
            type="file"
            accept=".pem,.crt,application/x-pem-file"
            disabled={busy || !https}
            onChange={(event) => onFile(event.target.files?.[0])}
          />
          {certificate ? (
            <div className="cluster-pair-fingerprint">
              <span>{fileName}</span>
              <code>{displayCertificateFingerprint(certificate.sha256)}</code>
              <Checkbox
                checked={confirmed}
                onCheckedChange={onConfirm}
                disabled={busy || !https}
                label="I compared this fingerprint with the other server and approve it for HTTPS pairing."
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function clusterInvitationContents({
  busy,
  error,
  onClose,
  onGenerate,
}: {
  busy: boolean;
  error: string;
  onClose: () => void;
  onGenerate: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Create a pairing code?</DialogTitle>
      </DialogHeader>
      <DialogDescription>
        The code expires in five minutes. The admin server must confirm this server’s account before pairing. Creating a code gives it no access.
      </DialogDescription>
      {error ? <InlineFeedback className="cluster-invite-error">{error}</InlineFeedback> : null}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" intent="primary" disabled={busy} aria-busy={busy} onClick={onGenerate}>
          Generate code
        </Button>
      </DialogFooter>
    </>
  );
}
export function ClusterInvitationDialog({
  open,
  busy,
  error,
  opener,
  onClose,
  onGenerate,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  opener: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onGenerate: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent
        size="sm"
        className="cluster-invite-dialog"
        closeDisabled={busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus({ preventScroll: true });
          }
        }}
      >
        {clusterInvitationContents({ busy, error, onClose, onGenerate })}
      </DialogContent>
    </Dialog>
  );
}

export function ClusterSettings() {
  const visible = useWindowVisible();
  const { user, sessionIdentity } = useAppContext();
  const cluster = useCluster();
  const { preferences } = useDesktopPreferences();
  const pairingAccess = useQuery({
    queryKey: ['cluster-pairing-access', user.id, user.username, cluster.data?.localId],
    queryFn: clusterPairingAccess,
    enabled: visible && user.operator && cluster.data?.role === 'admin',
    staleTime: 0,
    retry: false,
  });
  const [clusterName, setClusterName] = useState(cluster.data?.name ?? '');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [serverName, setServerName] = useState('');
  const [allowInsecureLan, setAllowInsecureLan] = useState(false);
  const [pairPassword, setPairPassword] = useState('');
  const [pairTotp, setPairTotp] = useState('');
  const [certificateMode, setCertificateMode] = useState<'system' | 'peer'>('system');
  const [peerCertificate, setPeerCertificate] = useState<SourceCertificate | null>(null);
  const certificateReads = useRef(certificateReadGate());
  const authorityRequests = useRef(authorityRequestGate());
  const [peerCertificateName, setPeerCertificateName] = useState('');
  const [confirmPeerCertificate, setConfirmPeerCertificate] = useState(false);
  const [pairError, setPairError] = useState('');
  const [remoteConnection, setRemoteConnection] = useState<ClusterPairConnection | null>(null);
  const remoteScope = useRef<PairingRequestScope | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const inviteTrigger = useRef<HTMLButtonElement>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const invitationField = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [removeFailed, setRemoveFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setClusterName(cluster.data?.name ?? '');
  }, [cluster.data?.name]);
  useEffect(() => {
    if (!invitation || !visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [invitation, visible]);
  const run = async (action: (scope: PairingRequestScope) => Promise<unknown>, success: string, onError?: (message: string) => void) => {
    const scope = requestScope(authorityRequests.current);
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await action(scope);
      if (!scope.current()) return;
      await scope.accept(cluster.refetch(), () => setMessage(success));
    } catch (error) {
      scope.commit(() => {
        const detail = error instanceof Error ? error.message : 'The request failed. Try again.';
        if (onError) onError(detail);
        else {
          setFailed(true);
          setMessage(detail);
        }
      });
    } finally {
      scope.commit(() => setBusy(false));
    }
  };
  const saveCluster = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        clusterRequest(cluster.data?.role === 'standalone' ? '/create' : '', cluster.data?.role === 'standalone' ? 'POST' : 'PUT', {
          name: clusterName.trim(),
          ...(cluster.data?.role === 'standalone' ? { serverName: preferences.serverName } : {}),
        }),
      cluster.data?.role === 'standalone' ? 'Cluster created. This server is the admin.' : '',
    );
  };
  const pair = (event: FormEvent) => {
    event.preventDefault();
    setPairError('');
    if (!pairingAccess.data?.available) {
      setPairError(
        pairingAccess.data && !pairingAccess.data.available
          ? pairingAccess.data.message
          : 'Secure pairing could not be checked. Refresh the connection.',
      );
      return;
    }
    let request: ClusterPairRequest;
    try {
      request = pairingConnectionRequest({
        url,
        code,
        name: serverName,
        password: pairPassword,
        totpCode: pairTotp,
        allowInsecureLan,
        certificateMode,
        certificate: peerCertificate,
        confirmedCertificate: confirmPeerCertificate,
      });
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'Check the pairing details and try again.');
      return;
    }
    setPairPassword('');
    setPairTotp('');
    void run(
      async (scope) => {
        try {
          await scope.accept(connectClusterServer(request), (connection) => {
            remoteScope.current = scope;
            setRemoteConnection(connection);
          });
        } finally {
          scope.commit(() => {
            setPairPassword('');
            setPairTotp('');
          });
        }
      },
      '',
      (detail) => setPairError(detail),
    );
  };
  const closeInvite = () => {
    if (busy) return;
    setInviteOpen(false);
    setInviteError('');
  };
  const createInvite = () => {
    setInviteError('');
    void run(
      async (scope) => {
        await scope.accept(createClusterInvitation(), (next) => {
          setNow(Date.now());
          setInvitation(next);
          setCopyMessage('');
          setInviteOpen(false);
        });
      },
      'Pairing code created. Enter it on the admin server.',
      (detail) => setInviteError(detail),
    );
  };
  const clearPairingTrust = () => {
    setRemoteConnection(null);
    remoteScope.current = null;
    certificateReads.current.invalidate();
    setPairPassword('');
    setPairTotp('');
    setPeerCertificate(null);
    setPeerCertificateName('');
    setConfirmPeerCertificate(false);
    setCertificateMode('system');
  };
  const updatePairAddress = (next: string) => {
    setUrl(next);
    clearPairingTrust();
    setAllowInsecureLan(false);
    setPairError('');
  };
  const loadPeerCertificate = async (file?: File) => {
    const read = certificateReads.current.begin();
    setPairError('');
    setPeerCertificate(null);
    setPeerCertificateName('');
    setConfirmPeerCertificate(false);
    if (!file) return;
    try {
      const parsed = await readSourceCertificate(file);
      if (!certificateReads.current.current(read)) return;
      setPeerCertificate(parsed);
      setPeerCertificateName(file.name);
    } catch (error) {
      if (!certificateReads.current.current(read)) return;
      setCertificateMode('system');
      setPairError(error instanceof Error ? error.message.replace(/source server/gi, 'other server') : 'The certificate could not be read.');
    }
  };
  const addressIsHttps = (() => {
    try {
      return new URL(url.trim()).protocol === 'https:';
    } catch {
      return false;
    }
  })();
  useLayoutEffect(() => {
    certificateReads.current.invalidate();
    authorityRequests.current.bind({
      sessionIdentity,
      userId: user.id,
      username: user.username,
      operator: user.operator,
      hostId: cluster.data?.localId,
      role: cluster.data?.role,
    });
    setBusy(false);
    setMessage('');
    setFailed(false);
    setPairError('');
    setRemoteConnection(null);
    remoteScope.current = null;
    setInviteError('');
    setRemoveId(null);
    setRemoveFailed(false);
    setPeerCertificate(null);
    setConfirmPeerCertificate(false);
    setPeerCertificateName('');
    setPairPassword('');
    setPairTotp('');
    setInviteOpen(false);
    setInvitation(null);
    setCode('');
    setCertificateMode('system');
    setAllowInsecureLan(false);
    return () => {
      certificateReads.current.invalidate();
      authorityRequests.current.invalidate();
    };
  }, [sessionIdentity, user.id, user.username, user.operator, cluster.data?.localId, cluster.data?.role]);
  useEffect(() => {
    if (visible) return;
    authorityRequests.current.invalidate();
    setRemoteConnection(null);
    remoteScope.current = null;
    setPairPassword('');
    setPairTotp('');
    setBusy(false);
  }, [visible]);
  const expiresIn = invitation ? Math.max(0, Math.ceil((new Date(invitation.expiresAt).getTime() - now) / 1000)) : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Invitation text and text scaling change measured height without changing the textarea ref.
  useLayoutEffect(() => {
    const field = invitationField.current;
    if (!field) return;
    const resize = () => {
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight + 2}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (field.parentElement) observer.observe(field.parentElement);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [invitation, preferences.appearance.textScale, expiresIn > 0]);
  const copyInvitation = async () => {
    if (!invitation || expiresIn <= 0) return;
    const copied = await copyText(invitation.code);
    if (invitationField.current?.value !== invitation.code) return;
    setCopyMessage(copied ? 'Pairing code copied.' : 'Copy was blocked. The code is selected; copy it using your browser or keyboard.');
    if (!copied) {
      invitationField.current?.focus({ preventScroll: true });
      invitationField.current?.select();
    }
  };
  const canManage = cluster.data?.role === 'admin';
  const member = cluster.data?.role === 'member';
  const serverToRemove = cluster.data?.servers.find((server) => server.id === removeId);

  if (cluster.isPending) return <output className="cluster-settings-state">Loading cluster settings…</output>;
  if (cluster.isError)
    return (
      <div className="cluster-settings-state" role="alert">
        <p>Cluster settings could not be loaded.</p>
        <Button onClick={() => void cluster.refetch()}>Retry</Button>
      </div>
    );
  if (!user.operator)
    return (
      <div className="cluster-settings-state">
        <h2>{cluster.data?.name}</h2>
        <p>An operator account is required to manage this cluster.</p>
      </div>
    );
  return (
    <div className="cluster-settings">
      {message ? (
        <p className="cluster-settings-message" role={failed ? 'alert' : 'status'} data-failed={failed}>
          {message}
        </p>
      ) : null}
      <section className="cluster-settings-section" aria-labelledby="cluster-group-heading">
        <div>
          <h2 id="cluster-group-heading">Cluster group</h2>
          <p>
            {member
              ? `${cluster.data?.admin?.name ?? 'The admin server'} manages this cluster.`
              : 'Manage paired servers from one admin server. Apps keep running on the server where they are installed.'}
          </p>
        </div>
        {member ? (
          <div className="cluster-settings-membership">
            <strong>{cluster.data?.name}</strong>
            <span>Member server</span>
            <Button
              disabled={busy}
              intent="danger"
              variant="outline"
              onClick={() => {
                setRemoveFailed(false);
                setRemoveId('membership');
              }}
            >
              Leave cluster
            </Button>
          </div>
        ) : (
          <form className="cluster-settings-form" onSubmit={saveCluster}>
            <label htmlFor="cluster-name">Cluster name</label>
            <div className="cluster-settings-input-action">
              <input
                id="cluster-name"
                disabled={busy}
                value={clusterName}
                onChange={(event) => setClusterName(event.target.value)}
                maxLength={60}
                required
                autoComplete="off"
                placeholder="My homelab"
              />
              <Button type="submit" disabled={busy || !clusterName.trim()} intent="primary">
                {canManage ? 'Save' : 'Create cluster'}
              </Button>
            </div>
            {canManage && cluster.data?.servers.length === 1 ? (
              <Button
                type="button"
                variant="outline"
                intent="danger"
                disabled={busy}
                onClick={() => {
                  setRemoveFailed(false);
                  setRemoveId('membership');
                }}
              >
                Leave cluster
              </Button>
            ) : null}
          </form>
        )}
      </section>
      {canManage ? (
        <section className="cluster-settings-section" aria-labelledby="cluster-pair-heading">
          <div>
            <h2 id="cluster-pair-heading">Pair a server</h2>
            <p>
              Create a code on the other server while it is standalone. Connect using its private HTTPS address, then authorize with that server’s
              account. Settings sync needs separate approval.
            </p>
          </div>
          <form className="cluster-settings-form cluster-pair-form" onSubmit={pair}>
            <p>Confirm your account here to connect. The other server’s password is requested after the connection succeeds.</p>
            {pairingAccess.data?.available ? null : (
              <div className="cluster-pair-access">
                <output>
                  {pairingAccess.isFetching
                    ? 'Checking secure connection…'
                    : pairingAccess.data && !pairingAccess.data.available
                      ? pairingAccess.data.message
                      : 'Secure pairing could not be checked. Update this server or refresh the connection.'}
                </output>
                <Button type="button" variant="outline" disabled={pairingAccess.isFetching || busy} onClick={() => void pairingAccess.refetch()}>
                  Refresh connection
                </Button>
              </div>
            )}
            <Input
              disabled={busy}
              id="cluster-server-address"
              className="cluster-settings-control"
              label="Server address"
              type="url"
              value={url}
              onChange={(event) => updatePairAddress(event.target.value)}
              placeholder="https://orbis.home.arpa"
              required
              autoComplete="off"
            />
            <fieldset className="cluster-settings-nearby" disabled={busy}>
              <legend className="visually-hidden">Optional nearby server search</legend>
              <NearbyServers
                onSelect={(origin) => {
                  updatePairAddress(origin);
                }}
              />
            </fieldset>
            <Input
              disabled={busy}
              id="cluster-pair-code"
              className="cluster-settings-control"
              label="Pairing code"
              value={code}
              onChange={(event) => {
                setRemoteConnection(null);
                remoteScope.current = null;
                setCode(event.target.value);
              }}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={24}
              required
              placeholder="Code from the other server"
            />
            <Input
              disabled={busy}
              id="cluster-server-label"
              className="cluster-settings-control"
              label={
                <>
                  Server name <span>(optional)</span>
                </>
              }
              value={serverName}
              onChange={(event) => {
                setRemoteConnection(null);
                remoteScope.current = null;
                setServerName(event.target.value);
              }}
              autoComplete="off"
              maxLength={60}
              placeholder="e.g. Atlas"
            />
            <ClusterPairingCertificate
              mode={certificateMode}
              https={addressIsHttps}
              busy={busy}
              certificate={peerCertificate}
              fileName={peerCertificateName}
              confirmed={confirmPeerCertificate}
              onMode={(value) => {
                clearPairingTrust();
                setCertificateMode(value);
                setPairError('');
              }}
              onFile={(file) => void loadPeerCertificate(file)}
              onConfirm={setConfirmPeerCertificate}
            />
            <Input
              disabled={busy || !pairingAccess.data?.available}
              id="cluster-pair-password"
              className="cluster-settings-control"
              label="This server’s account password"
              type="password"
              value={pairPassword}
              onChange={(event) => setPairPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            <Input
              disabled={busy || !pairingAccess.data?.available}
              id="cluster-pair-totp"
              className="cluster-settings-control"
              label={
                <>
                  Authentication code <span>(if enabled)</span>
                </>
              }
              type="text"
              value={pairTotp}
              onChange={(event) => setPairTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
            />
            {pairError ? <InlineFeedback className="cluster-pair-error">{pairError}</InlineFeedback> : null}
            <div className="cluster-pair-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setUrl('');
                  setCode('');
                  setServerName('');
                  setPairError('');
                  clearPairingTrust();
                  setAllowInsecureLan(false);
                }}
              >
                Clear
              </Button>
              <Button
                type="submit"
                intent="primary"
                disabled={busy || !pairingAccess.data?.available || !url.trim() || !code.trim() || !pairPassword}
              >
                <IconPlus size={18} aria-hidden="true" />
                Connect
              </Button>
            </div>
          </form>
        </section>
      ) : null}
      {canManage ? (
        <p className="cluster-settings-state">This is an admin server. Generate joining codes on the other server before it belongs to a cluster.</p>
      ) : null}
      {cluster.data?.role === 'standalone' ? (
        <section className="cluster-settings-section" aria-labelledby="cluster-invite-heading">
          <div>
            <h2 id="cluster-invite-heading">Join another cluster</h2>
            <p>
              Create a one-use code for the admin server. Pairing needs this server’s account approval before it grants access to apps, status and
              updates.
            </p>
          </div>
          <div className="cluster-settings-form">
            <Button
              ref={inviteTrigger}
              type="button"
              disabled={busy}
              onClick={() => {
                setInviteError('');
                setInviteOpen(true);
              }}
            >
              Generate pairing code
            </Button>
            {invitation ? (
              <div className="cluster-invitation">
                <label htmlFor="cluster-invitation-code">Pairing code</label>
                <textarea
                  id="cluster-invitation-code"
                  ref={invitationField}
                  readOnly
                  rows={1}
                  value={expiresIn > 0 ? invitation.code : 'Expired'}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-describedby="cluster-invitation-expiry"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span id="cluster-invitation-expiry">
                  {expiresIn > 0
                    ? `Expires in ${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, '0')}`
                    : 'Create a new code to continue.'}
                </span>
                <Button variant="outline" disabled={expiresIn <= 0} onClick={() => void copyInvitation()}>
                  <IconCopy size={17} aria-hidden="true" />
                  Copy code
                </Button>
                {copyMessage && expiresIn > 0 ? (
                  <output className="cluster-copy-message" aria-live="polite">
                    {copyMessage}
                  </output>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      <section className="cluster-settings-section" aria-labelledby="cluster-servers-heading">
        <div>
          <h2 id="cluster-servers-heading">Servers</h2>
          <p>
            {member
              ? 'The admin server controls cluster membership.'
              : 'Removing a server revokes cluster access. Its apps and data stay on that server.'}
          </p>
        </div>
        <ul className="cluster-settings-servers">
          {cluster.data?.servers.map((server) => (
            <li key={server.id}>
              <IconServer size={22} aria-hidden="true" />
              <div>
                <strong>{server.local ? preferences.serverName : server.name}</strong>
                <span>
                  {server.role === 'admin' ? 'Admin server' : 'Member server'}
                  {server.local ? ' · This server' : ''}
                </span>
                <span title={server.url}>{server.url}</span>
                {server.url.toLowerCase().startsWith('http://') ? <span className="cluster-server-http">HTTP · Unencrypted private LAN</span> : null}
                {typeof server.certificateSha256 === 'string' && /^[a-f0-9]{64}$/.test(server.certificateSha256) ? (
                  <span className="cluster-server-certificate">
                    Approved HTTPS certificate · <code>{displayCertificateFingerprint(server.certificateSha256)}</code>
                  </span>
                ) : null}
              </div>
              {canManage && !server.local ? (
                <Button
                  variant="outline"
                  intent="danger"
                  disabled={busy}
                  onClick={() => {
                    setRemoveFailed(false);
                    setRemoveId(server.id);
                  }}
                >
                  <IconTrash className="orbis-remove-icon" size={18} aria-hidden="true" />
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <section className="cluster-settings-section" aria-labelledby="cluster-nearby-heading">
        <div>
          <h2 id="cluster-nearby-heading">Nearby servers</h2>
          <p>Control whether nearby Orbis servers can find this server’s private HTTPS address.</p>
        </div>
        <NearbyVisibility disabled={busy} />
      </section>
      <ClusterInvitationDialog
        open={inviteOpen}
        busy={busy}
        error={inviteError}
        opener={inviteTrigger}
        onClose={closeInvite}
        onGenerate={createInvite}
      />
      <ClusterSyncSettings />
      {remoteConnection ? (
        <ClusterRemoteAccountDialog
          key={remoteConnection.pendingId}
          connection={remoteConnection}
          onClose={() => {
            setRemoteConnection(null);
            remoteScope.current = null;
          }}
          onPaired={() => {
            remoteScope.current?.commit(() => {
              setRemoteConnection(null);
              remoteScope.current = null;
              setCode('');
              setUrl('');
              setServerName('');
              clearPairingTrust();
              setCertificateMode('system');
              setAllowInsecureLan(false);
              setMessage('Server paired. It is now available in the server selector.');
              void cluster.refetch();
            });
          }}
        />
      ) : null}
      <Dialog
        open={removeId !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setRemoveId(null);
            setRemoveFailed(false);
          }
        }}
      >
        <DialogContent
          size="sm"
          className="cluster-remove-dialog"
          onFocusCapture={(event) => {
            const target = event.target;
            if (target instanceof HTMLElement && target.matches(':focus-visible'))
              target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
          }}
        >
          <DialogHeader>
            <DialogTitle>{removeId === 'membership' ? 'Leave this cluster?' : `Remove ${serverToRemove?.name ?? 'server'}?`}</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {removeId === 'membership'
              ? member
                ? 'The admin server will lose access to this server. Your apps and data stay here.'
                : 'This server will become standalone so it can create a joining code. Your apps and data stay here.'
              : 'Cluster access to this server will be revoked. Its apps and data will stay on that server.'}
          </DialogDescription>
          {removeFailed && removeId !== 'membership' ? (
            <div className="cluster-remove-recovery" role="alert">
              <p>The server did not confirm removal. Try again when it is reachable, or forget it here.</p>
              <p>
                Forgetting only removes this admin server’s record. If the other server still trusts this admin, leave the cluster in that server’s
                settings to revoke access.
              </p>
              <Button
                variant="outline"
                intent="danger"
                disabled={busy}
                onClick={() =>
                  void run(async (scope) => {
                    await scope.accept(clusterRequest(`/servers/${encodeURIComponent(removeId ?? '')}?forget=true`, 'DELETE'), () => {
                      setRemoveId(null);
                      setRemoveFailed(false);
                    });
                  }, 'Server forgotten here. Revoke access on the other server separately.')
                }
              >
                Forget unreachable server
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setRemoveId(null);
                setRemoveFailed(false);
              }}
            >
              Cancel
            </Button>
            <Button
              intent="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  async (scope) => {
                    try {
                      await clusterRequest(removeId === 'membership' ? '/membership' : `/servers/${encodeURIComponent(removeId ?? '')}`, 'DELETE');
                    } catch (error) {
                      scope.commit(() => {
                        if (removeId !== 'membership') setRemoveFailed(true);
                      });
                      throw error;
                    }
                    scope.commit(() => {
                      setRemoveId(null);
                      setRemoveFailed(false);
                    });
                  },
                  removeId === 'membership' ? 'Left the cluster.' : 'Server removed.',
                )
              }
            >
              {removeId !== 'membership' ? <IconTrash className="orbis-remove-icon" size={18} aria-hidden="true" /> : null}
              {removeId === 'membership' ? 'Leave cluster' : 'Remove server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
