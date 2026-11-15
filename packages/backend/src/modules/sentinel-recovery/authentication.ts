import { isIP } from 'node:net';
import { verify as verifyPassword } from 'argon2';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { TotpAuthenticator } from '../auth/utils/totp-authenticator';
import { exactRecoveryObject, readRecoveryIdentity, recoveryBase64, type RecoveryIdentity } from './identity';

export type RecoveryAuthenticationResult =
  | { schema: 'orbis.sentinel-authentication.v1'; verified: false }
  | {
      schema: 'orbis.sentinel-authentication.v1';
      verified: true;
      accountId: number;
      revision: string;
      identitySha256: string;
      challenge: string;
      method: 'password' | 'passkey';
      verifiedAtMs: number;
      totpStep: number | null;
      credential: { id: string; previousCounter: number; newCounter: number } | null;
    };

function assertion(value: unknown): value is AuthenticationResponseJSON {
  if (!exactRecoveryObject(value, ['id', 'rawId', 'type', 'response', 'clientExtensionResults'], ['authenticatorAttachment'])) return false;
  if (value.type !== 'public-key' || !recoveryBase64(value.id) || value.rawId !== value.id) return false;
  if (!exactRecoveryObject(value.response, ['clientDataJSON', 'authenticatorData', 'signature'], ['userHandle'])) return false;
  if (
    !recoveryBase64(value.response.clientDataJSON, 8192) ||
    !recoveryBase64(value.response.authenticatorData, 8192) ||
    !recoveryBase64(value.response.signature)
  )
    return false;
  if (!(value.response.userHandle == null || recoveryBase64(value.response.userHandle))) return false;
  if (!value.clientExtensionResults || typeof value.clientExtensionResults !== 'object' || Array.isArray(value.clientExtensionResults)) return false;
  const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value.response.clientDataJSON, 'base64url')));
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const client = data as Record<string, unknown>;
  return (
    typeof client.type === 'string' &&
    typeof client.challenge === 'string' &&
    typeof client.origin === 'string' &&
    (client.crossOrigin === undefined || client.crossOrigin === false)
  );
}

function totp(identity: RecoveryIdentity, raw: unknown, method: 'password' | 'passkey', now: number): number | null | false {
  if (!identity.totpEnabled || (method === 'passkey' && !identity.requireTotpAfterPasskey)) return null;
  if (typeof raw !== 'string' || !/^[0-9]{6}$/.test(raw) || !identity.totpSecret) return false;
  const verifier = TotpAuthenticator.clone();
  verifier.options = { epoch: now, window: 0 };
  return verifier.check(raw, identity.totpSecret) ? Math.floor(now / 30_000) : false;
}

/** Root must separately consume the challenge, counters and identity revision before issuing a session or action grant. */
export async function verifyRecoveryCredentials(input: {
  identityBytes: Uint8Array;
  expectedIdentitySha256: string;
  challenge: string;
  request: unknown;
}): Promise<RecoveryAuthenticationResult> {
  const { expectedIdentitySha256, challenge } = input;
  const identity = readRecoveryIdentity(input.identityBytes, expectedIdentitySha256);
  const failure = { schema: 'orbis.sentinel-authentication.v1', verified: false } as const;
  if (!recoveryBase64(challenge, 43) || Buffer.from(challenge, 'base64url').length !== 32) return failure;
  let credential: Extract<RecoveryAuthenticationResult, { verified: true }>['credential'] = null;
  try {
    const body = JSON.stringify(input.request);
    if (!body || Buffer.byteLength(body) > 32768) return failure;
    const request: unknown = JSON.parse(body);
    const method = exactRecoveryObject(request, ['method'], ['username', 'password', 'response', 'totpCode']) ? request.method : undefined;
    if (method === 'password') {
      if (!exactRecoveryObject(request, ['method', 'username', 'password'], ['totpCode'])) return failure;
      if (
        typeof request.username !== 'string' ||
        request.username.length > 254 ||
        typeof request.password !== 'string' ||
        Buffer.byteLength(request.password) > 4096
      )
        return failure;
      const valid = await verifyPassword(identity.passwordHash, request.password);
      if (!valid || request.username.trim().toLowerCase() !== identity.username) return failure;
    } else if (method === 'passkey') {
      if (!exactRecoveryObject(request, ['method', 'response'], ['totpCode']) || !assertion(request.response)) return failure;
      const origin = new URL(identity.realm.origin);
      if (origin.hostname !== 'localhost' && (origin.protocol !== 'https:' || isIP(origin.hostname))) return failure;
      const response = request.response;
      const stored = identity.credentials.find((key) => key.id === response.id && key.rpID === identity.realm.rpID);
      if (!stored || (response.response.userHandle != null && response.response.userHandle !== identity.userHandle)) return failure;
      const checked = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: identity.realm.origin,
        expectedRPID: identity.realm.rpID,
        requireUserVerification: true,
        credential: { id: stored.id, publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')), counter: stored.counter },
      });
      if (!checked.verified) return failure;
      credential = { id: stored.id, previousCounter: stored.counter, newCounter: checked.authenticationInfo.newCounter };
    } else return failure;
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now <= 0) return failure;
    const step = totp(identity, request.totpCode, method, now);
    if (step === false) return failure;
    return {
      schema: 'orbis.sentinel-authentication.v1',
      verified: true,
      accountId: identity.accountId,
      revision: identity.revision,
      identitySha256: expectedIdentitySha256,
      challenge,
      method,
      verifiedAtMs: now,
      totpStep: step,
      credential,
    };
  } catch {
    return failure;
  }
}
