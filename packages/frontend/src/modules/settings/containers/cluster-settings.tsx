import { useEffect, useState, type FormEvent } from 'react';
import { IconCopy, IconPlus, IconServer } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { clusterRequest, useCluster } from '@/desktop/cluster';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useAppContext } from '@/context/app-context';
import './cluster-settings.css';

type Invitation = { code: string; expiresAt: string };

export function ClusterSettings() {
  const { user } = useAppContext();
  const cluster = useCluster();
  const { preferences } = useDesktopPreferences();
  const [clusterName, setClusterName] = useState(cluster.data?.name ?? '');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [serverName, setServerName] = useState('');
  const [allowInsecureLan, setAllowInsecureLan] = useState(false);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
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
    if (!invitation) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [invitation]);
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await action();
      await cluster.refetch();
      setMessage(success);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'The request failed. Try again.');
    } finally {
      setBusy(false);
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
      cluster.data?.role === 'standalone' ? 'Cluster created. This server is the admin.' : 'Cluster name saved.',
    );
  };
  const pair = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await clusterRequest('/pair', 'POST', {
        url: url.trim(),
        code: code.trim(),
        ...(serverName.trim() ? { name: serverName.trim() } : {}),
        allowInsecureLan,
      });
      setCode('');
      setUrl('');
      setServerName('');
    }, 'Server paired. It is now available in the server selector.');
  };
  const createInvite = () =>
    void run(async () => {
      const next = await clusterRequest<Invitation>('/invite', 'POST');
      setNow(Date.now());
      setInvitation(next);
    }, 'Pairing code created. Enter it on the admin server.');
  const expiresIn = invitation ? Math.max(0, Math.ceil((new Date(invitation.expiresAt).getTime() - now) / 1000)) : 0;
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
                value={clusterName}
                onChange={(event) => setClusterName(event.target.value)}
                maxLength={60}
                required
                autoComplete="off"
                placeholder="My homelab"
              />
              <Button type="submit" disabled={busy || !clusterName.trim()} intent="primary">
                {canManage ? 'Save name' : 'Create cluster'}
              </Button>
            </div>
          </form>
        )}
      </section>
      {canManage ? (
        <section className="cluster-settings-section" aria-labelledby="cluster-pair-heading">
          <div>
            <h2 id="cluster-pair-heading">Pair a server</h2>
            <p>Open Settings → Cluster on the other server, create a pairing code, then enter its address and code here.</p>
          </div>
          <form className="cluster-settings-form" onSubmit={pair}>
            <label htmlFor="cluster-server-address">Server address</label>
            <input
              id="cluster-server-address"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://orbis.example.com"
              required
              autoComplete="off"
            />
            <label htmlFor="cluster-pair-code">Pairing code</label>
            <input
              id="cluster-pair-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={80}
              required
              placeholder="Code from the other server"
            />
            <label htmlFor="cluster-server-label">
              Server name <span>(optional)</span>
            </label>
            <input
              id="cluster-server-label"
              value={serverName}
              onChange={(event) => setServerName(event.target.value)}
              autoComplete="off"
              maxLength={60}
              placeholder="e.g. Atlas"
            />
            <label className="cluster-settings-checkbox">
              <input type="checkbox" checked={allowInsecureLan} onChange={(event) => setAllowInsecureLan(event.target.checked)} />
              <span>
                Allow HTTP on my private LAN
                <span className="cluster-settings-help">
                  Use HTTPS when available. HTTP pairing sends the pairing code over your local network without encryption.
                </span>
              </span>
            </label>
            <Button type="submit" intent="primary" disabled={busy || !url.trim() || !code.trim()}>
              <IconPlus size={18} aria-hidden="true" />
              Pair server
            </Button>
          </form>
        </section>
      ) : null}
      {cluster.data?.role === 'standalone' ? (
        <section className="cluster-settings-section" aria-labelledby="cluster-invite-heading">
          <div>
            <h2 id="cluster-invite-heading">Join another cluster</h2>
            <p>Create a one-use code for the admin server. Pairing grants that server access to this server’s apps, status and updates.</p>
          </div>
          <div className="cluster-settings-form">
            <Button disabled={busy} onClick={createInvite}>
              Create pairing code
            </Button>
            {invitation ? (
              <div className="cluster-invitation">
                <span>Pairing code</span>
                <output aria-label="Pairing code">{expiresIn > 0 ? invitation.code : 'Expired'}</output>
                <span>
                  {expiresIn > 0
                    ? `Expires in ${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, '0')}`
                    : 'Create a new code to continue.'}
                </span>
                <Button
                  variant="outline"
                  disabled={expiresIn <= 0}
                  onClick={() =>
                    void run(async () => {
                      await navigator.clipboard.writeText(invitation.code);
                    }, 'Pairing code copied.')
                  }
                >
                  <IconCopy size={17} aria-hidden="true" />
                  Copy code
                </Button>
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
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
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
              ? 'The admin server will lose access to this server. Your apps and data stay here.'
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
                  void run(async () => {
                    await clusterRequest(`/servers/${encodeURIComponent(removeId ?? '')}?forget=true`, 'DELETE');
                    setRemoveId(null);
                    setRemoveFailed(false);
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
                  async () => {
                    try {
                      await clusterRequest(removeId === 'membership' ? '/membership' : `/servers/${encodeURIComponent(removeId ?? '')}`, 'DELETE');
                    } catch (error) {
                      if (removeId !== 'membership') setRemoveFailed(true);
                      throw error;
                    }
                    setRemoveId(null);
                    setRemoveFailed(false);
                  },
                  removeId === 'membership' ? 'Left the cluster.' : 'Server removed.',
                )
              }
            >
              {removeId === 'membership' ? 'Leave cluster' : 'Remove server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
