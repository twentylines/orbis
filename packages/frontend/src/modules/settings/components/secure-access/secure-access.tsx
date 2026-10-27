import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { IconCheck, IconCopy, IconDownload, IconExternalLink, IconLock, IconNetwork, IconWorld } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useAppContext } from '@/context/app-context';
import { copyText } from '@/lib/clipboard';
import { readLocalCertificate, secureAccessOrigin, publicSecureAccessOrigin, secureAccessEntryPath } from '@/desktop/secure-access';
import './secure-access.css';

export function SecureAccessSetup({ available, checking, onCheck }: { available: boolean; checking: boolean; onCheck: () => Promise<unknown> }) {
  const { userSettings, user } = useAppContext();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(() => params.get('secure_setup') === '1');
  const [method, setMethod] = useState<'local' | 'domain'>('local');
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const download = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const local = secureAccessOrigin(userSettings.localDomain, userSettings.sslPort ?? 443);
  const domain = publicSecureAccessOrigin(userSettings.domain, userSettings.sslPort ?? 443);
  const destination = method === 'local' ? local : domain;
  const secure = window.location.protocol === 'https:' && window.isSecureContext;
  const ready = secure && available;
  const chooseMethod = (next: 'local' | 'domain') => {
    download.current?.abort();
    setDownloading(false);
    setMethod(next);
    setError('');
    setMessage('');
  };

  useEffect(
    () => () => {
      download.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );
  useEffect(() => {
    if (message || error) feedback.current?.scrollIntoView({ block: 'nearest' });
  }, [message, error]);

  const close = () => {
    download.current?.abort();
    setDownloading(false);
    setOpen(false);
    setError('');
    setMessage('');
    if (params.has('secure_setup'))
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete('secure_setup');
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
  };

  const downloadCertificate = async () => {
    if (download.current && !download.current.signal.aborted) return;
    const controller = new AbortController();
    download.current = controller;
    setDownloading(true);
    setError('');
    setMessage('');
    try {
      const blob = await readLocalCertificate(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
      if (controller.signal.aborted) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl.current;
      link.download = 'orbis-local-certificate.pem';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setMessage('Certificate downloaded. Trust it on each device you use to open Orbis.');
    } catch {
      if (!controller.signal.aborted) setError('Could not download a public certificate. Check certificate setup on the server and try again.');
    } finally {
      if (download.current === controller) {
        download.current = null;
        if (!controller.signal.aborted) setDownloading(false);
      }
    }
  };

  return (
    <>
      <div className="secure-access-summary">
        <div>
          <IconLock size={20} aria-hidden="true" />
          <span>{ready ? 'Secure address ready for passkeys' : 'Use a secure hostname for passkeys'}</span>
        </div>
        <Button ref={opener} onClick={() => setOpen(true)}>
          {ready ? 'Secure access' : 'Set up HTTPS'}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else close();
        }}
      >
        <DialogContent size="md" className="secure-access-dialog" restoreFocusTo={opener}>
          <DialogHeader>
            <DialogTitle>Secure access</DialogTitle>
          </DialogHeader>
          <DialogDescription className="secure-access-body">
            {ready ? (
              <div className="secure-access-ready">
                <IconCheck size={26} aria-hidden="true" />
                <h3>Your secure address is ready</h3>
                <p>
                  This browser and server allow passkeys at <strong>{window.location.hostname}</strong>. Close this guide to add one.
                </p>
              </div>
            ) : (
              <>
                <p>Use HTTPS on your local network or VPN for passkeys. Your password stays available during setup.</p>
                <p className="secure-access-privacy">
                  Orbis can stay private. Neither option requires opening router ports or making the dashboard public.
                </p>
                <fieldset className="secure-access-methods" aria-label="HTTPS setup method">
                  <Button aria-pressed={method === 'local'} onClick={() => chooseMethod('local')}>
                    <IconNetwork size={22} aria-hidden="true" />
                    <strong>Local network</strong>
                    <span>Trust a local certificate on your devices.</span>
                  </Button>
                  <Button aria-pressed={method === 'domain'} onClick={() => chooseMethod('domain')}>
                    <IconWorld size={22} aria-hidden="true" />
                    <strong>Trusted certificate</strong>
                    <span>Use your domain with private access.</span>
                  </Button>
                </fieldset>
                <section key={method} className="secure-access-instructions" aria-label={method === 'local' ? 'Local network setup' : 'Domain setup'}>
                  {destination ? (
                    <>
                      <div className="secure-access-address">
                        <div>
                          <span>HTTPS address</span>
                          <strong>{destination}</strong>
                        </div>
                        <Button
                          size="icon"
                          aria-label="Copy HTTPS address"
                          onClick={async () =>
                            setMessage(
                              (await copyText(destination)) ? 'HTTPS address copied.' : 'Could not copy. Select the address above to copy it.',
                            )
                          }
                        >
                          <IconCopy size={18} aria-hidden="true" />
                        </Button>
                      </div>
                      <ol>
                        <li>
                          Make <strong>{new URL(destination).hostname}</strong> resolve to this server
                          {userSettings.internalIp ? (
                            <>
                              {' '}
                              at <strong>{userSettings.internalIp}</strong>
                            </>
                          ) : null}
                          , using your router or DNS server.
                        </li>
                        {method === 'local' ? (
                          <li>
                            Download the public certificate below and trust it on each device. This step needs your confirmation in the device’s
                            certificate settings.
                          </li>
                        ) : (
                          <li>
                            Use DNS verification for a trusted certificate. Cloudflare, or another supported DNS provider, verifies domain ownership
                            without receiving access to the dashboard. Keep this hostname pointed at your private server address.
                          </li>
                        )}
                        <li>Open the HTTPS address. Sign in there if asked; Orbis will bring you back to Security to check passkey availability.</li>
                      </ol>
                      <div className="secure-access-actions">
                        {method === 'local' ? (
                          <Button aria-disabled={downloading} aria-busy={downloading} onClick={() => void downloadCertificate()}>
                            <IconDownload size={18} aria-hidden="true" />
                            {downloading ? 'Downloading…' : 'Download certificate'}
                          </Button>
                        ) : null}
                        <Button asChild>
                          <a
                            href={
                              method === 'local'
                                ? 'https://runtipi.io/docs/guides/local-certificate'
                                : 'https://runtipi.io/docs/guides/dns-challenge-cloudflare'
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <IconExternalLink size={18} aria-hidden="true" />
                            {method === 'local' ? 'Device trust guide' : 'Private DNS certificate guide'}
                          </a>
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p>
                      {method === 'local'
                        ? 'No local hostname is configured yet.'
                        : 'Use a domain you own with DNS verification and local DNS. Private hostnames such as .local use the local network option.'}{' '}
                      {user.operator
                        ? 'Set it in server settings, save, then apply the requested restart before continuing.'
                        : 'Ask an operator to configure a secure hostname for this server.'}
                    </p>
                  )}
                  {message || error ? (
                    <div ref={feedback}>
                      {message ? <output aria-live="polite">{message}</output> : null}
                      {error ? (
                        <p className="secure-access-error" role="alert">
                          {error}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {user.operator ? (
                    <Button asChild variant="ghost">
                      <Link to="/settings?tab=settings">Edit server hostnames</Link>
                    </Button>
                  ) : null}
                </section>
                <p className="secure-access-note">The secure address opens in a new tab. Keep this page until it works on your device.</p>
              </>
            )}
            {secure && !ready ? (
              <Button disabled={checking} onClick={() => void onCheck()}>
                {checking ? 'Checking…' : 'Check passkey availability'}
              </Button>
            ) : null}
          </DialogDescription>
          <DialogFooter>
            <Button onClick={close}>{ready ? 'Done' : 'Close guide'}</Button>
            {!ready && destination ? (
              <Button asChild intent="primary">
                <a href={destination + secureAccessEntryPath} target="_blank" rel="noopener noreferrer" aria-label="Open HTTPS address">
                  Open HTTPS <IconExternalLink size={18} aria-hidden="true" />
                </a>
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
