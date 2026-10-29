export type SourceCertificate = { pem: string; sha256: string; confirmed: boolean };
export const sourceCertificateLimit = 64 * 1024;

export async function readSourceCertificate(file: Pick<File, 'size' | 'text'>): Promise<SourceCertificate> {
  if (file.size === 0 || file.size > sourceCertificateLimit) throw new Error('Choose one public PEM certificate up to 64 KB.');
  const text = await file.text();
  if (text.length > sourceCertificateLimit) throw new Error('Choose one public PEM certificate up to 64 KB.');
  const match = /^\s*-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----\s*$/.exec(text);
  if (!match?.[1]) throw new Error('Choose one public certificate. Private keys, certificate bundles and other file contents are refused.');
  const encoded = match[1].replace(/[\r\n]/g, '');
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(encoded);
    if (btoa(binary) !== encoded) throw new Error('Noncanonical base64');
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length === 0 || bytes[0] !== 0x30) throw new Error('Invalid DER');
  } catch {
    throw new Error('The certificate encoding could not be read. Choose a PEM certificate from the source server.');
  }
  const sha256 = globalThis.crypto?.subtle
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
    : await inspectSourceCertificate(text);
  const lines = encoded.match(/.{1,64}/g)?.join('\n');
  return { pem: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`, sha256, confirmed: false };
}

export const displayCertificateFingerprint = (value: string) => value.toUpperCase().match(/.{2}/g)?.join(':') ?? '';

export function confirmedSourceCertificate(value: SourceCertificate | null) {
  if (!value) return {};
  if (!value.confirmed) throw new Error('Compare the certificate fingerprint on the source server, then confirm it before connecting.');
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Choose the source certificate again.');
  return { sourceCertificatePem: value.pem, sourceCertificateSha256: value.sha256, confirmSourceCertificate: true as const };
}

async function inspectSourceCertificate(certificatePem: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/system-backups/transfers/certificates/fingerprint', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certificatePem }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Could not inspect the public certificate. Check this server connection, then choose the certificate again.');
  }
  if (!response.ok || response.redirected)
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'Use an operator browser session through this server’s private connection to inspect the public certificate.'
        : response.status === 429
          ? 'Too many certificate inspections. Wait a minute before trying again.'
          : 'The public certificate could not be inspected. Use one current self-signed server certificate or local CA root.',
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The certificate fingerprint response was empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256) throw new Error('The certificate fingerprint response was invalid.');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 1 ||
      !('sha256' in value) ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    )
      throw new Error();
    return value.sha256;
  } catch {
    throw new Error('The certificate fingerprint response could not be verified. Choose the certificate again.');
  }
}
