import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { IconCopy, IconDownload, IconExternalLink, IconLock } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { copyText } from '@/lib/clipboard';
import { readLocalCertificate, secureAccessOrigin, secureAccessEntryPath, hasHttpsConnection } from '@/desktop/secure-access';
import { SecureConnectionIndicator } from '@/components/secure-connection-indicator';
import { useWindowVisible } from '@/desktop/window-visibility';
import './secure-access.css';

export function SecureAccessSetup({
  protocol = typeof window === 'undefined' ? '' : window.location.protocol,
  secureContext = typeof window !== 'undefined' && window.isSecureContext,
}: {
  protocol?: string;
  secureContext?: boolean;
} = {}) {
  const { userSettings, user } = useAppContext();
  const visible = useWindowVisible();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const download = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const destination = secureAccessOrigin(userSettings.localDomain, userSettings.sslPort ?? 443);
  const secure = hasHttpsConnection(protocol, secureContext);
  useEffect(
    () => () => {
      download.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );
  useEffect(() => {
    if (!visible) {
      download.current?.abort();
      download.current = null;
      setDownloading(false);
    }
  }, [visible]);
  const downloadCertificate = async () => {
    if (!visible || download.current) return;
    const controller = new AbortController();
    download.current = controller;
    setDownloading(true);
    setError('');
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
    } catch {
      if (!controller.signal.aborted)
        setError('The public certificate is unavailable. Check the server’s local hostname and certificate setup, then try again.');
    } finally {
      if (download.current === controller) {
        download.current = null;
        if (!controller.signal.aborted) setDownloading(false);
      }
    }
  };
  if (secure) return <SecureConnectionIndicator protocol={protocol} secureContext={secureContext} />;
  return (
    <section className="secure-access-setup" aria-labelledby="https-setup-heading">
      <div className="settings-security-heading">
        <IconLock aria-hidden="true" />
        <h2 id="https-setup-heading">HTTPS</h2>
      </div>
      <p>
        Keep Orbis on your private LAN or VPN. HTTPS enables passkeys and secure server transfers without opening router ports or making this server
        public.
      </p>
      <ol className="secure-access-steps">
        <li>
          <h3>Private address</h3>
          {destination ? (
            <>
              <p>Make this hostname resolve to this server’s private LAN address using your router or local DNS.</p>
              <div className="secure-access-address">
                <strong>{destination}</strong>
                <Button
                  size="icon"
                  aria-label="Copy HTTPS address"
                  onClick={async () => {
                    if (!(await copyText(destination))) setError('Could not copy. Select the HTTPS address to copy it.');
                  }}
                >
                  <IconCopy size={18} aria-hidden="true" />
                </Button>
              </div>
            </>
          ) : (
            <p>
              {user.operator
                ? 'Set a local hostname first. Save it and apply the requested restart before downloading its certificate.'
                : 'Ask an operator to configure this server’s local hostname and certificate.'}
            </p>
          )}
          {user.operator ? (
            <Button asChild variant="outline">
              <Link to="/settings?tab=general&setting=local-domain">{destination ? 'Edit hostname' : 'Set hostname'}</Link>
            </Button>
          ) : null}
        </li>
        <li>
          <h3>Trust on this device</h3>
          <p>
            Download this server’s public certificate. Verify it came from this server, then import it using your device’s certificate settings. This
            manual step is required on each device; Orbis does not change device trust.
          </p>
          <Button disabled={!destination || downloading || !visible} aria-busy={downloading || undefined} onClick={() => void downloadCertificate()}>
            <IconDownload size={18} aria-hidden="true" />
            {downloading ? 'Downloading…' : 'Download certificate'}
          </Button>
        </li>
        <li>
          <h3>Open HTTPS</h3>
          <p>
            Once the hostname resolves privately and this device trusts the certificate, open the secure address and sign in. Keep this page open
            until it works.
          </p>
          {destination ? (
            <Button asChild intent="primary">
              <a href={destination + secureAccessEntryPath} target="_blank" rel="noopener noreferrer">
                Open HTTPS <IconExternalLink size={18} aria-hidden="true" />
              </a>
            </Button>
          ) : null}
        </li>
      </ol>
      {error ? (
        <p className="secure-access-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
