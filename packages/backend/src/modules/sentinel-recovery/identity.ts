import { createHash, timingSafeEqual } from 'node:crypto';

export type RecoveryCredential = { id: string; publicKey: string; counter: number; rpID: string };
export type RecoveryIdentity = {
  schema: 'orbis.sentinel-identity.v1';
  revision: string;
  accountId: number;
  username: string;
  operator: true;
  passwordHash: string;
  totpEnabled: boolean;
  totpSecret: string | null;
  requireTotpAfterPasskey: boolean;
  userHandle: string | null;
  realm: { origin: string; rpID: string };
  credentials: RecoveryCredential[];
};

export function describeRecoveryIdentity(bytes: Uint8Array, expectedSha256: string) {
  const identity = readRecoveryIdentity(bytes, expectedSha256);
  return {
    schema: 'orbis.sentinel-identity-description.v1' as const,
    identitySha256: expectedSha256,
    revision: identity.revision,
    accountId: identity.accountId,
    origin: identity.realm.origin,
    totpEnabled: identity.totpEnabled,
    requireTotpAfterPasskey: identity.requireTotpAfterPasskey,
    credentials: Object.fromEntries(identity.credentials.filter((key) => key.rpID === identity.realm.rpID).map((key) => [key.id, key.counter])),
  };
}

export class RecoveryIdentityError extends Error {
  constructor() {
    super('The protected recovery identity could not be verified.');
    this.name = 'RecoveryIdentityError';
  }
}

export function exactRecoveryObject(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

export function recoveryBase64(value: unknown, maximum = 2048): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}

function passwordHash(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  const match = /^\$argon2(?:id|i|d)\$v=(?:16|19)\$m=([1-9][0-9]*),t=([1-9][0-9]*),p=([1-9][0-9]*)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(value);
  if (!match) return false;
  const memory = Number(match[1]);
  const time = Number(match[2]);
  const parallelism = Number(match[3]);
  return (
    memory >= 1024 &&
    memory <= 262_144 &&
    time <= 10 &&
    parallelism <= 16 &&
    [match[4], match[5]].every(
      (part) =>
        typeof part === 'string' &&
        part.length >= 11 &&
        part.length <= 172 &&
        Buffer.from(part, 'base64').toString('base64').replace(/=+$/, '') === part,
    )
  );
}

function realm(value: unknown): value is RecoveryIdentity['realm'] {
  if (!exactRecoveryObject(value, ['origin', 'rpID']) || typeof value.origin !== 'string' || value.origin.length > 512) return false;
  try {
    const origin = new URL(value.origin);
    return (
      ['http:', 'https:'].includes(origin.protocol) &&
      value.origin === origin.origin &&
      !origin.username &&
      !origin.password &&
      value.rpID === origin.hostname
    );
  } catch {
    return false;
  }
}

function credential(value: unknown): value is RecoveryCredential {
  return (
    exactRecoveryObject(value, ['id', 'publicKey', 'counter', 'rpID']) &&
    recoveryBase64(value.id) &&
    recoveryBase64(value.publicKey) &&
    Number.isSafeInteger(value.counter) &&
    (value.counter as number) >= 0 &&
    (value.counter as number) <= 0xffff_ffff &&
    typeof value.rpID === 'string' &&
    value.rpID.length > 0 &&
    value.rpID.length <= 253 &&
    !/[\s/\\?#@]/.test(value.rpID) &&
    !value.rpID.includes('\0')
  );
}

export function readRecoveryIdentity(bytes: Uint8Array, expectedSha256: string): RecoveryIdentity {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 65536 || !/^[a-f0-9]{64}$/.test(expectedSha256))
      throw new RecoveryIdentityError();
    const snapshot = Buffer.from(bytes);
    if (!timingSafeEqual(createHash('sha256').update(snapshot).digest(), Buffer.from(expectedSha256, 'hex'))) throw new RecoveryIdentityError();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot));
    if (
      !exactRecoveryObject(value, [
        'schema',
        'revision',
        'accountId',
        'username',
        'operator',
        'passwordHash',
        'totpEnabled',
        'totpSecret',
        'requireTotpAfterPasskey',
        'userHandle',
        'realm',
        'credentials',
      ]) ||
      value.schema !== 'orbis.sentinel-identity.v1' ||
      typeof value.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.revision) ||
      !Number.isSafeInteger(value.accountId) ||
      (value.accountId as number) < 1 ||
      typeof value.username !== 'string' ||
      !value.username.length ||
      value.username.length > 254 ||
      value.username.split('').some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      value.username.trim().toLowerCase() !== value.username ||
      value.operator !== true ||
      !passwordHash(value.passwordHash) ||
      typeof value.totpEnabled !== 'boolean' ||
      typeof value.requireTotpAfterPasskey !== 'boolean' ||
      (value.totpEnabled ? typeof value.totpSecret !== 'string' || !/^[A-Z2-7]{16,128}$/.test(value.totpSecret) : value.totpSecret !== null) ||
      !(value.userHandle === null || recoveryBase64(value.userHandle)) ||
      !realm(value.realm) ||
      !Array.isArray(value.credentials) ||
      value.credentials.length > 10 ||
      !value.credentials.every(credential) ||
      (value.credentials.length > 0 && value.userHandle === null) ||
      new Set(value.credentials.map((key) => key.id)).size !== value.credentials.length
    )
      throw new RecoveryIdentityError();
    return value as RecoveryIdentity;
  } catch {
    throw new RecoveryIdentityError();
  }
}
