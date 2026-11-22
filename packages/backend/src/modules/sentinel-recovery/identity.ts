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
  return identityDescription(identity, expectedSha256);
}

function identityDescription(identity: RecoveryIdentity, expectedSha256: string) {
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

export function describeRecoveryIdentityContent(bytes: Uint8Array, expectedSha256: string) {
  const identity = readRecoveryIdentity(bytes, expectedSha256);
  return {
    schema: 'orbis.sentinel-identity-content.v1' as const,
    identitySha256: expectedSha256,
    contentSha256: identityContentHash(identity),
    description: identityDescription(identity, expectedSha256),
  };
}

function identityContentHash(identity: RecoveryIdentity) {
  const content = [
    identity.schema,
    identity.accountId,
    identity.username,
    identity.operator,
    identity.passwordHash,
    identity.totpEnabled,
    identity.totpSecret,
    identity.requireTotpAfterPasskey,
    identity.userHandle,
    [identity.realm.origin, identity.realm.rpID],
    identity.credentials.map((key) => [key.id, key.publicKey, key.counter, key.rpID]),
  ];
  return createHash('sha256')
    .update(JSON.stringify(['orbis.sentinel-identity-content.v1', content]))
    .digest('hex');
}

/** Root supplies independently stored monotonic floors. Every other identity
 * field and the complete credential/key/RPID domain remain in the content hash.
 * The description still identifies the original immutable profile bytes.
 */
export function describeRecoveryEffectiveIdentityContent(bytes: Uint8Array, expectedSha256: string, floors: unknown) {
  const identity = readRecoveryIdentity(bytes, expectedSha256);
  if (
    !exactRecoveryObject(
      floors,
      identity.credentials.map((key) => key.id),
    )
  )
    throw new RecoveryIdentityError();
  const credentials = identity.credentials.map((key) => {
    const counter = floors[key.id];
    if (typeof counter !== 'number' || !Number.isInteger(counter) || counter < key.counter || counter > 0xffffffff) throw new RecoveryIdentityError();
    return { ...key, counter };
  });
  return {
    schema: 'orbis.sentinel-effective-identity-content.v1' as const,
    identitySha256: expectedSha256,
    contentSha256: identityContentHash({ ...identity, credentials }),
    description: identityDescription(identity, expectedSha256),
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

export function readProtectedRecoveryJson(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 65536) throw new RecoveryIdentityError();
  // Preserve a BOM so the JSON grammar rejects it instead of silently stripping it.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let offset = 0;
  let nodes = 0;
  const space = () => {
    while (offset < text.length && /[\x20\t\r\n]/.test(text[offset] ?? '')) offset++;
  };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      const char = text.charCodeAt(offset++);
      if (char === 34) {
        const value: unknown = JSON.parse(text.slice(start, offset));
        if (typeof value !== 'string') throw new RecoveryIdentityError();
        for (let index = 0; index < value.length; index++) {
          const code = value.charCodeAt(index);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++index);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new RecoveryIdentityError();
          } else if (code >= 0xdc00 && code <= 0xdfff) throw new RecoveryIdentityError();
        }
        return value;
      }
      if (char < 32) throw new RecoveryIdentityError();
      if (char === 92) {
        const escaped = text[offset++];
        if (escaped === 'u') {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(offset, offset + 4))) throw new RecoveryIdentityError();
          offset += 4;
        } else if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) throw new RecoveryIdentityError();
      }
    }
    throw new RecoveryIdentityError();
  };
  const value = (depth: number): unknown => {
    if (depth > 16 || ++nodes > 2048) throw new RecoveryIdentityError();
    space();
    if (text[offset] === '"') return string();
    if (text[offset] === '{') {
      offset++;
      const result: Record<string, unknown> = Object.create(null);
      space();
      if (text[offset] === '}') {
        offset++;
        return result;
      }
      while (offset < text.length) {
        space();
        if (text[offset] !== '"') throw new RecoveryIdentityError();
        const key = string();
        space();
        if (Object.hasOwn(result, key) || text[offset++] !== ':') throw new RecoveryIdentityError();
        result[key] = value(depth + 1);
        space();
        const end = text[offset++];
        if (end === '}') return result;
        if (end !== ',') throw new RecoveryIdentityError();
      }
      throw new RecoveryIdentityError();
    }
    if (text[offset] === '[') {
      offset++;
      const result: unknown[] = [];
      space();
      if (text[offset] === ']') {
        offset++;
        return result;
      }
      while (offset < text.length) {
        result.push(value(depth + 1));
        space();
        const end = text[offset++];
        if (end === ']') return result;
        if (end !== ',') throw new RecoveryIdentityError();
      }
      throw new RecoveryIdentityError();
    }
    for (const [literal, parsed] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return parsed;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(offset))?.[0];
    // Identity numeric fields are canonical safe integers, so another language
    // cannot round a fractional source into an apparently equivalent account.
    if (!number || !Number.isSafeInteger(Number(number)) || number !== String(Number(number))) throw new RecoveryIdentityError();
    offset += number.length;
    return Number(number);
  };
  const result = value(0);
  space();
  if (offset !== text.length) throw new RecoveryIdentityError();
  return result;
}

export function readRecoveryIdentity(bytes: Uint8Array, expectedSha256: string): RecoveryIdentity {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 65536 || !/^[a-f0-9]{64}$/.test(expectedSha256))
      throw new RecoveryIdentityError();
    const snapshot = Buffer.from(bytes);
    if (!timingSafeEqual(createHash('sha256').update(snapshot).digest(), Buffer.from(expectedSha256, 'hex'))) throw new RecoveryIdentityError();
    const value = readProtectedRecoveryJson(snapshot);
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
