const applicationPath = /^\/(?:dashboard|apps|app-store|monitor|updates|settings|tasks)(?:[/?#]|$)/;

export function safeReturnTo(value: string | null): string | null {
  if (
    !value ||
    value.length > 2048 ||
    [...value].some((character) => character.charCodeAt(0) <= 32 || character === '\\') ||
    !applicationPath.test(value)
  )
    return null;
  try {
    const target = new URL(value, 'https://orbis.invalid');
    return target.origin === 'https://orbis.invalid' && applicationPath.test(target.pathname) ? target.pathname + target.search + target.hash : null;
  } catch {
    return null;
  }
}

export function secureAccessOrigin(hostname: unknown, sslPort: unknown = 443): string | null {
  if (typeof hostname !== 'string' || hostname.length > 253 || /[\s/:@?#\\%]/.test(hostname)) return null;
  if (typeof sslPort !== 'number' || !Number.isInteger(sslPort) || sslPort < 1 || sslPort > 65535) return null;
  try {
    const address = new URL(`https://${hostname}`);
    const host = address.hostname;
    if (!host.includes('.') || /^[\d.]+$/.test(host) || host.endsWith('.invalid')) return null;
    if (!host.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) return null;
    return `https://${host}${sslPort === 443 ? '' : `:${sslPort}`}`;
  } catch {
    return null;
  }
}

export const secureAccessPath = '/settings?tab=security&secure_setup=1';
export const secureAccessEntryPath = `/login?${new URLSearchParams({ return_to: secureAccessPath })}`;

export function publicSecureAccessOrigin(hostname: unknown, sslPort: unknown = 443): string | null {
  const origin = secureAccessOrigin(hostname, sslPort);
  if (!origin) return null;
  const host = new URL(origin).hostname;
  return /(?:^|\.)(?:local|localhost|lan|home|internal|test|invalid|example|onion)$/.test(host) || host === 'home.arpa' || host.endsWith('.home.arpa')
    ? null
    : origin;
}

export async function readLocalCertificate(signal: AbortSignal): Promise<Blob> {
  const response = await fetch('/api/system/certificate', { signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error('The local certificate is not available. Check certificate setup on the server, then try again.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The local certificate is unavailable.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65536) {
        await reader.cancel();
        throw new Error('The public certificate exceeds the download limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const certificate = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;
  const blocks = content.match(certificate);
  if (!blocks?.length || blocks.length > 16 || content.replace(certificate, '').trim() || /PRIVATE KEY/.test(content))
    throw new Error('The server did not return a usable public certificate. No file was downloaded.');
  return new Blob([content], { type: 'application/x-pem-file' });
}

export const httpsSettingsPath = '/settings?tab=https';
export const httpsSetupVisible = (protocol: string) => protocol === 'http:';
export const hasHttpsConnection = (protocol: string, secureContext: boolean) => protocol === 'https:' && secureContext;
