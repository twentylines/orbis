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

async function post(path: '/invite' | '/pair', body: object): Promise<unknown> {
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
    throw new ClusterPairingError(0);
  }
  if (response.redirected) throw new ClusterPairingError(response.status);
  let result: unknown;
  try {
    result = await readBoundedJson(response);
  } catch {
    throw new ClusterPairingError(response.status);
  }
  if (!response.ok) {
    const message = result && typeof result === 'object' && !Array.isArray(result) ? (result as { message?: unknown }).message : undefined;
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
