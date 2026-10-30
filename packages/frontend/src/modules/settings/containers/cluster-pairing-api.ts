export type ClusterFreshAuth = { password: string; totpCode?: string };
export type ClusterInvitation = { code: string; expiresAt: string };
export type ClusterPairRequest = ClusterFreshAuth & {
  url: string;
  code: string;
  name?: string;
  allowInsecureLan?: true;
  peerCertificatePem?: string;
  peerCertificateSha256?: string;
  confirmPeerCertificate?: true;
};
export type ClusterPairResult = { paired: true; id: string; name: string; certificateSha256?: string };

const responseLimit = 16 * 1024;
const safeMessages = new Set([
  'Provide only the requested pairing details.',
  'Use HTTPS for account pairing.',
  'Secure pairing needs a private HTTPS connection and trusted proxy setup on this server.',
  'The other server needs private HTTPS and trusted proxy setup before pairing.',
  'Update both servers and generate a new pairing code.',
  'Pairing code or authorization expired. Generate a new code on the other server.',
  'The other server could not authorize pairing. Check its password and authentication code.',
  'Pairing was not confirmed. Check cluster status on both servers before reconnecting.',
  'Cluster changed. Connect to the other server again.',
  'The pairing code could not be saved. Check server storage permissions and free space.',
  'Too many pairing attempts. Wait five minutes and generate a new code.',
  'Confirm pairing with your account password and authentication code if enabled.',
  'An operator account is required for pairing.',
  'This server already belongs to a cluster. Leave it before pairing.',
  'Create a cluster on its admin server first.',
  'A cluster supports up to 12 paired servers.',
  'This address is already paired.',
  'Enter the 24-character pairing code from the joining server.',
  'Use HTTPS, or explicitly allow HTTP on a trusted private LAN. Enter the server origin without a path.',
  'Pairing currently supports private LAN or VPN addresses. Loopback, link-local and public targets are refused.',
  'A confirmed peer certificate requires HTTPS.',
  'Upload one current public peer certificate and confirm its SHA-256 fingerprint on that server. Never upload a private key.',
  'The server name could not be resolved in time.',
  'The server name could not be resolved.',
  'The server address did not resolve.',
  'This server does not support the cluster protocol or is the admin server itself.',
  'Cluster membership changed while pairing. Leave the cluster on the joining server and try again.',
  'The paired server returned an invalid response.',
  'Cannot reach the paired server. Use a hostname matching its HTTPS certificate and check certificate trust and connection.',
]);
const genericMessage = 'The cluster pairing request did not finish. Check the server address and try again.';

export class ClusterPairingError extends Error {
  constructor(
    public readonly status: number,
    message = genericMessage,
  ) {
    super(message);
    this.name = 'ClusterPairingError';
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (size + value.byteLength > responseLimit) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function post(path: '/invite' | '/pair' | '/pairing/connect' | '/pairing/complete', body: object): Promise<unknown> {
  const fallback = path === '/invite' ? 'The pairing code could not be created. Try again and check this server’s status.' : genericMessage;
  let response: Response;
  try {
    response = await fetch(`/api/cluster${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ClusterPairingError(0, fallback);
  }
  if (response.redirected) throw new ClusterPairingError(response.status, fallback);
  let result: unknown;
  try {
    result = await readBoundedJson(response);
  } catch {
    throw new ClusterPairingError(response.status, fallback);
  }
  if (!response.ok) {
    const message = result && typeof result === 'object' && !Array.isArray(result) ? (result as { message?: unknown }).message : undefined;
    if (response.status === 429) throw new ClusterPairingError(429, 'Too many pairing attempts. Wait five minutes and generate a new code.');
    if (response.status === 403 && typeof message === 'string' && message.startsWith('Invalid request origin.'))
      throw new ClusterPairingError(403, 'This request was blocked by the server address check. Check your reverse proxy settings.');
    if (response.status === 400 && message === 'AUTH_ERROR_INVALID_PASSWORD')
      throw new ClusterPairingError(400, 'Check your account password and try again.');
    if (response.status === 400 && message === 'AUTH_ERROR_TOTP_INVALID_CODE')
      throw new ClusterPairingError(400, 'Enter a current six-digit authentication code and try again.');
    throw new ClusterPairingError(
      response.status,
      typeof message === 'string' && safeMessages.has(message)
        ? message
        : response.status === 401
          ? 'Confirm your account password and authentication code, then try again.'
          : response.status === 403
            ? 'Use an operator browser session on this server to manage pairing.'
            : path === '/invite'
              ? 'The pairing code could not be created. Try again and check this server’s status.'
              : genericMessage,
    );
  }
  return result;
}

export async function createClusterInvitation(credentials: ClusterFreshAuth): Promise<ClusterInvitation> {
  const result = await post('/invite', credentials);
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    typeof (result as ClusterInvitation).code !== 'string' ||
    !/^[A-F0-9]{24}$/.test((result as ClusterInvitation).code) ||
    typeof (result as ClusterInvitation).expiresAt !== 'string' ||
    !Number.isFinite(Date.parse((result as ClusterInvitation).expiresAt))
  )
    throw new ClusterPairingError(200);
  return result as ClusterInvitation;
}

export async function pairClusterServer(body: ClusterPairRequest): Promise<ClusterPairResult> {
  const result = await post('/pair', body);
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    (result as ClusterPairResult).paired !== true ||
    typeof (result as ClusterPairResult).id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test((result as ClusterPairResult).id) ||
    typeof (result as ClusterPairResult).name !== 'string' ||
    ((result as ClusterPairResult).certificateSha256 !== undefined && !/^[a-f0-9]{64}$/.test((result as ClusterPairResult).certificateSha256 ?? ''))
  )
    throw new ClusterPairingError(200);
  if (body.peerCertificateSha256 !== undefined && (result as ClusterPairResult).certificateSha256 !== body.peerCertificateSha256)
    throw new ClusterPairingError(200);
  return result as ClusterPairResult;
}

export type ClusterPairConnection = { pendingId: string; id: string; name: string; origin: string; totpRequired: boolean; expiresAt: string };
function requireSecureBrowser() {
  if (typeof location !== 'undefined' && location.protocol !== 'https:') throw new ClusterPairingError(400, 'Use HTTPS for account pairing.');
}
export async function connectClusterServer(body: ClusterPairRequest): Promise<ClusterPairConnection> {
  requireSecureBrowser();
  if (!body.url.startsWith('https://') || body.allowInsecureLan) throw new ClusterPairingError(400, 'Use HTTPS for account pairing.');
  const value = await post('/pairing/connect', body);
  const result = value as ClusterPairConnection | null;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !/^[a-f0-9]{64}$/.test(result.pendingId) ||
    !/^[a-f0-9-]{36}$/.test(result.id) ||
    typeof result.name !== 'string' ||
    !result.name.trim() ||
    result.name.length > 64 ||
    /\p{Cc}/u.test(result.name) ||
    result.origin !== body.url ||
    typeof result.totpRequired !== 'boolean' ||
    typeof result.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(result.expiresAt)) ||
    Date.parse(result.expiresAt) <= Date.now() ||
    Date.parse(result.expiresAt) > Date.now() + 120_000
  )
    throw new ClusterPairingError(200);
  return result;
}
export async function completeClusterPairing(body: { pendingId: string; password: string; totpCode?: string }): Promise<ClusterPairResult> {
  requireSecureBrowser();
  const value = await post('/pairing/complete', body);
  const result = value as ClusterPairResult | null;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.paired !== true ||
    typeof result.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(result.id) ||
    typeof result.name !== 'string'
  )
    throw new ClusterPairingError(200);
  return result;
}

export type ClusterPairingAccess = { available: true } | { available: false; message: string };
export async function clusterPairingAccess(): Promise<ClusterPairingAccess> {
  if (typeof location !== 'undefined' && location.protocol !== 'https:') return { available: false, message: 'Use HTTPS for account pairing.' };
  let response: Response;
  try {
    response = await fetch('/api/cluster/pairing/access', {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.redirected) throw new Error('Unavailable');
    const result = (await readBoundedJson(response)) as { available?: unknown; message?: unknown } | null;
    if (result?.available === true) return { available: true };
    if (result?.available === false && result.message === 'Secure pairing needs a private HTTPS connection and trusted proxy setup on this server.')
      return { available: false, message: result.message };
  } catch {
    /* Access failures do not expose a server or proxy response body. */
  }
  throw new ClusterPairingError(0, 'Secure pairing could not be checked. Update this server or refresh the connection.');
}
