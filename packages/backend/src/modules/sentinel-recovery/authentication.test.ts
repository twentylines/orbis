import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { hash } from 'argon2';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TotpAuthenticator } from '../auth/utils/totp-authenticator';
import { verifyRecoveryCredentials, verifyRecoveryPasskeyCounter } from './authentication';
import { describeRecoveryIdentity, readRecoveryIdentity, RecoveryIdentityError, type RecoveryIdentity } from './identity';

const password = 'synthetic-recovery-password';
const challenge = randomBytes(32).toString('base64url');
const handle = randomBytes(24).toString('base64url');
const credentialId = randomBytes(24).toString('base64url');
const origin = 'https://orbis.example';
const rpID = 'orbis.example';
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = pair.publicKey.export({ format: 'jwk' });
if (!jwk.x || !jwk.y) throw new Error('Missing generated test public coordinates');
const publicKey = Buffer.from(
  isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]),
  ),
).toString('base64url');
let enrolledHash: string;

beforeAll(async () => {
  enrolledHash = await hash(password, { memoryCost: 4096, timeCost: 2, parallelism: 1 });
});
afterEach(() => vi.useRealTimers());

function identity(changes: Partial<RecoveryIdentity> = {}): RecoveryIdentity {
  return {
    schema: 'orbis.sentinel-identity.v1',
    revision: 'd'.repeat(64),
    accountId: 1,
    username: 'operator',
    operator: true,
    passwordHash: enrolledHash,
    totpEnabled: false,
    totpSecret: null,
    requireTotpAfterPasskey: false,
    userHandle: handle,
    realm: { origin, rpID },
    credentials: [{ id: credentialId, publicKey, counter: 3, rpID }],
    ...changes,
  };
}
function encoded(value: unknown = identity()) {
  const identityBytes = Buffer.from(JSON.stringify(value));
  return { identityBytes, expectedIdentitySha256: createHash('sha256').update(identityBytes).digest('hex') };
}
const passwordRequest = (changes = {}) => ({ method: 'password', username: 'operator', password, ...changes });
function passkey({
  flags = 5,
  counter = 4,
  realm = rpID,
  client = {},
}: {
  flags?: number;
  counter?: number;
  realm?: string;
  client?: Record<string, unknown>;
} = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false, ...client }));
  const auth = Buffer.alloc(37);
  createHash('sha256').update(realm).digest().copy(auth);
  auth[32] = flags;
  auth.writeUInt32BE(counter, 33);
  const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(clientDataJSON).digest()]), pair.privateKey);
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: auth.toString('base64url'),
      signature: signature.toString('base64url'),
      userHandle: handle,
    },
  };
}
const authenticate = (request: unknown, profile = identity()) => verifyRecoveryCredentials({ ...encoded(profile), challenge, request });

describe('counter-only worker proof', () => {
  it('verifies a genuine assertion without pretending that the account TOTP/session ceremony completed', async () => {
    const profile = identity({ totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP', requireTotpAfterPasskey: true });
    const result = await verifyRecoveryPasskeyCounter({ ...encoded(profile), challenge, request: { response: passkey() } });
    expect(result).toMatchObject({
      schema: 'orbis.sentinel-passkey-counter.v1',
      verified: true,
      challenge,
      credential: { id: credentialId, previousCounter: 3, newCounter: 4 },
    });
    expect(result).not.toHaveProperty('totpStep');
    expect(result).not.toHaveProperty('method');
    expect((await authenticate({ method: 'passkey', response: passkey() }, profile)).verified).toBe(false);
  });
  it('rejects signed wrong-nonce/realm/UV/counter and never accepts auth fields as a bypass', async () => {
    const input = encoded();
    for (const options of [
      { client: { challenge: randomBytes(32).toString('base64url') } },
      { client: { origin: 'https://other.example' } },
      { flags: 1 },
      { counter: 3 },
    ]) {
      expect((await verifyRecoveryPasskeyCounter({ ...input, challenge, request: { response: passkey(options) } })).verified).toBe(false);
    }
    for (const extra of [{ totpCode: '123456' }, { method: 'passkey' }, { password: 'not-a-counter-proof' }]) {
      expect((await verifyRecoveryPasskeyCounter({ ...input, challenge, request: { response: passkey(), ...extra } })).verified).toBe(false);
    }
  });
  it('handles fresh zero-counter signatures but leaves nonce consumption and latest-floor checking to Root', async () => {
    const profile = identity({ credentials: [{ id: credentialId, publicKey, counter: 0, rpID }] });
    const result = await verifyRecoveryPasskeyCounter({ ...encoded(profile), challenge, request: { response: passkey({ counter: 0 }) } });
    expect(result).toMatchObject({ verified: true, credential: { previousCounter: 0, newCounter: 0 } });
    expect(profile.credentials[0]?.counter).toBe(0);
  });
});

describe('protected standalone recovery identity', () => {
  it('describes exact protected identity metadata without exporting either credential secret or an authentication claim', () => {
    const input = encoded(identity({ totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP', requireTotpAfterPasskey: true }));
    const description = describeRecoveryIdentity(input.identityBytes, input.expectedIdentitySha256);
    expect(description).toEqual({
      schema: 'orbis.sentinel-identity-description.v1',
      identitySha256: input.expectedIdentitySha256,
      revision: 'd'.repeat(64),
      accountId: 1,
      origin,
      totpEnabled: true,
      requireTotpAfterPasskey: true,
      credentials: { [credentialId]: 3 },
    });
    const body = JSON.stringify(description);
    for (const secret of [enrolledHash, 'JBSWY3DPEHPK3PXP', publicKey, handle, 'verified', 'token', 'grant']) expect(body).not.toContain(secret);
    input.identityBytes[0] = 0x20;
    expect(() => describeRecoveryIdentity(input.identityBytes, input.expectedIdentitySha256)).toThrow(RecoveryIdentityError);
  });

  it('does not advertise passkeys from a different recovery realm', () => {
    const input = encoded(identity({ credentials: [{ id: credentialId, publicKey, counter: 3, rpID: 'other.example' }] }));
    expect(describeRecoveryIdentity(input.identityBytes, input.expectedIdentitySha256).credentials).toEqual({});
  });

  it('binds actual identity bytes to the independently supplied protected digest', () => {
    const input = encoded();
    expect(readRecoveryIdentity(input.identityBytes, input.expectedIdentitySha256)).toEqual(identity());
    input.identityBytes[0] = 0x20;
    expect(() => readRecoveryIdentity(input.identityBytes, input.expectedIdentitySha256)).toThrow(RecoveryIdentityError);
  });

  it.each([
    ['schema', { schema: 'other' }],
    ['role', { operator: false }],
    ['account', { accountId: 0 }],
    ['username', { username: ' Operator ' }],
    ['control text', { username: 'operator\n' }],
    ['revision', { revision: 'changed' }],
    ['missing factor', { totpEnabled: true, totpSecret: null }],
    ['stale secret', { totpEnabled: false, totpSecret: 'JBSWY3DPEHPK3PXP' }],
    ['unbounded hash cost', { passwordHash: '$argon2id$v=19$m=1048576,t=3,p=4$c3ludGhldGljLWZpeHR1cmU$c3ludGhldGljLWZpeHR1cmU' }],
    ['unknown key', { roleOverride: true }],
    ['credentials', { credentials: Array.from({ length: 11 }, () => identity().credentials[0]) }],
    ['duplicate credentials', { credentials: [identity().credentials[0], identity().credentials[0]] }],
    ['missing handle', { userHandle: null }],
    ['origin path', { realm: { origin: `${origin}/another`, rpID } }],
    ['rp mismatch', { realm: { origin, rpID: 'elsewhere.example' } }],
  ])('rejects a malformed %s enrollment before using its credentials', (_name, changes) => {
    const input = encoded({ ...identity(), ...changes });
    expect(() => readRecoveryIdentity(input.identityBytes, input.expectedIdentitySha256)).toThrow(
      'The protected recovery identity could not be verified.',
    );
  });

  it('rejects oversized, malformed and invalid UTF-8 profiles', () => {
    for (const bytes of [Buffer.alloc(65537), Buffer.from('{'), Buffer.from([0xff])]) {
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(() => readRecoveryIdentity(bytes, digest)).toThrow(RecoveryIdentityError);
    }
  });
});

describe('standalone recovery credential verification', () => {
  it('uses actual Argon2 verification without a database or Orbis session and returns only a bound observation', async () => {
    const result = await authenticate(passwordRequest({ username: ' Operator ' }));
    expect(result).toMatchObject({
      verified: true,
      accountId: 1,
      challenge,
      method: 'password',
      revision: 'd'.repeat(64),
      credential: null,
      totpStep: null,
    });
    expect(result).not.toHaveProperty('sessionId');
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|synthetic-recovery-password|totpSecret|publicKey/);
  });

  it.each([
    passwordRequest({ password: 'wrong' }),
    passwordRequest({ username: 'unknown' }),
    passwordRequest({ disableTotp: true }),
    passwordRequest({ password: 'x'.repeat(4097) }),
    { method: 'none' },
    { method: 'password' },
    null,
  ])('returns the same nonsecret failure for invalid input %#', async (request) => {
    expect(await authenticate(request)).toEqual({ schema: 'orbis.sentinel-authentication.v1', verified: false });
  });

  it('requires the enrolled second factor for passwords and reports the step for root replay fencing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const profile = identity({ totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' });
    const otp = TotpAuthenticator.clone();
    otp.options = { epoch: Date.now(), window: 0 };
    expect((await authenticate(passwordRequest(), profile)).verified).toBe(false);
    const result = await authenticate(passwordRequest({ totpCode: otp.generate(profile.totpSecret ?? '') }), profile);
    expect(result).toMatchObject({ verified: true, totpStep: Math.floor(Date.now() / 30_000) });
    vi.setSystemTime(Date.now() + 30_000);
    expect((await authenticate(passwordRequest({ totpCode: otp.generate(profile.totpSecret ?? '') }), profile)).verified).toBe(false);
  });

  it('verifies an actual ES256 assertion with required user verification and the bound counter', async () => {
    const result = await authenticate({ method: 'passkey', response: passkey() });
    expect(result).toMatchObject({
      verified: true,
      method: 'passkey',
      challenge,
      credential: { id: credentialId, previousCounter: 3, newCounter: 4 },
    });
  });

  it.each([
    ['challenge', { client: { challenge: randomBytes(32).toString('base64url') } }],
    ['origin', { client: { origin: 'https://elsewhere.example' } }],
    ['type', { client: { type: 'webauthn.create' } }],
    ['iframe', { client: { crossOrigin: true } }],
    ['malformed iframe flag', { client: { crossOrigin: 'false' } }],
    ['rpID hash', { realm: 'elsewhere.example' }],
    ['user verification', { flags: 1 }],
    ['user presence', { flags: 4 }],
    ['counter replay', { counter: 3 }],
  ])('rejects a cryptographically signed but invalid %s assertion', async (_name, options) => {
    expect((await authenticate({ method: 'passkey', response: passkey(options) })).verified).toBe(false);
  });

  it('rejects altered signatures, credential IDs, raw IDs and account handles', async () => {
    for (const mutate of [
      (value: ReturnType<typeof passkey>) => {
        value.response.signature = randomBytes(70).toString('base64url');
      },
      (value: ReturnType<typeof passkey>) => {
        value.id = randomBytes(24).toString('base64url');
        value.rawId = value.id;
      },
      (value: ReturnType<typeof passkey>) => {
        value.rawId = randomBytes(24).toString('base64url');
      },
      (value: ReturnType<typeof passkey>) => {
        value.response.userHandle = randomBytes(24).toString('base64url');
      },
    ]) {
      const response = passkey();
      mutate(response);
      expect((await authenticate({ method: 'passkey', response })).verified).toBe(false);
    }
  });

  it('honors the enrolled TOTP-after-passkey policy without allowing the request to disable it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const profile = identity({ totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP', requireTotpAfterPasskey: true });
    expect((await authenticate({ method: 'passkey', response: passkey() }, profile)).verified).toBe(false);
    expect((await authenticate({ method: 'passkey', response: passkey(), requireTotpAfterPasskey: false }, profile)).verified).toBe(false);
    const otp = TotpAuthenticator.clone();
    otp.options = { epoch: Date.now(), window: 0 };
    expect((await authenticate({ method: 'passkey', response: passkey(), totpCode: otp.generate(profile.totpSecret ?? '') }, profile)).verified).toBe(
      true,
    );
    expect((await authenticate({ method: 'passkey', response: passkey() }, { ...profile, requireTotpAfterPasskey: false })).verified).toBe(true);
  });

  it('does not silently mutate the enrolled counter or consume a root challenge', async () => {
    const profile = identity();
    const response = { method: 'passkey', response: passkey() };
    expect((await authenticate(response, profile)).verified).toBe(true);
    expect((await authenticate(response, profile)).verified).toBe(true);
    expect(profile.credentials[0]?.counter).toBe(3);
  });

  it('withholds unbounded requests and invalid root challenges', async () => {
    expect((await authenticate({ ...passwordRequest(), extra: 'x'.repeat(33000) })).verified).toBe(false);
    const result = await verifyRecoveryCredentials({ ...encoded(), challenge: 'short', request: passwordRequest() });
    expect(result.verified).toBe(false);
  });
});
