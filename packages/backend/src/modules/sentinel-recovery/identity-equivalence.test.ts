import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  describeRecoveryIdentity,
  describeRecoveryIdentityContent,
  describeRecoveryEffectiveIdentityContent,
  readRecoveryIdentity,
  type RecoveryIdentity,
} from './identity';

const base64 = (text: string) => Buffer.from(text).toString('base64url');
const passwordHash = `$argon2id$v=19$m=4096,t=2,p=1$${Buffer.from('synthetic-salt').toString('base64').replace(/=+$/, '')}$${Buffer.from('synthetic-hash').toString('base64').replace(/=+$/, '')}`;
const identity = (): RecoveryIdentity => ({
  schema: 'orbis.sentinel-identity.v1',
  revision: 'a'.repeat(64),
  accountId: 1,
  username: 'operator',
  operator: true,
  passwordHash,
  totpEnabled: false,
  totpSecret: null,
  requireTotpAfterPasskey: false,
  userHandle: base64('synthetic-handle'),
  realm: { origin: 'https://orbis.example', rpID: 'orbis.example' },
  credentials: [{ id: base64('synthetic-id'), publicKey: base64('synthetic-public-key'), counter: 3, rpID: 'orbis.example' }],
});
const encoded = (text: string) => {
  const bytes = Buffer.from(text);
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
};
function proof(value: unknown) {
  const input = encoded(JSON.stringify(value));
  return describeRecoveryIdentityContent(input.bytes, input.digest);
}
const failure = 'The protected recovery identity could not be verified.';

describe('effective Root counter content proof', () => {
  it('authenticates the full identity with monotonic floors while describing the original bytes', () => {
    const original = identity();
    const source = encoded(JSON.stringify(original));
    const key = original.credentials[0];
    if (!key) throw new Error('Missing fixture key');
    const effective = describeRecoveryEffectiveIdentityContent(source.bytes, source.digest, { [key.id]: 7 });
    const updated = proof({ ...original, credentials: [{ ...key, counter: 7 }] });
    expect(effective.contentSha256).toBe(updated.contentSha256);
    expect(effective.description).toEqual(describeRecoveryIdentity(source.bytes, source.digest));
    expect(effective.description.credentials[key.id]).toBe(3);
    expect(effective.contentSha256).not.toBe(proof(original).contentSha256);
    expect(effective.contentSha256).not.toBe(proof({ ...original, username: 'changed', credentials: [{ ...key, counter: 7 }] }).contentSha256);
    expect(original.credentials[0]?.counter).toBe(3);
  });
  it('rejects missing/extra key domains, rollback and unbounded or ambiguous counters', () => {
    const original = identity();
    const source = encoded(JSON.stringify(original));
    const key = original.credentials[0];
    if (!key) throw new Error('Missing fixture key');
    for (const floors of [
      null,
      [],
      {},
      { [key.id]: 2 },
      { [key.id]: 4, extra: 4 },
      { [key.id]: 0x100000000 },
      { [key.id]: 3.5 },
      { [key.id]: '4' },
      { [key.id]: Number.NaN },
    ]) {
      expect(() => describeRecoveryEffectiveIdentityContent(source.bytes, source.digest, floors)).toThrow(failure);
    }
  });
});

describe('independent recovery identity content proof', () => {
  it('binds the exact source digest and omits only revision from its domain-separated content digest', () => {
    const value = identity();
    const source = encoded(JSON.stringify(value));
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'orbis.sentinel-identity-content.v1',
          [
            value.schema,
            value.accountId,
            value.username,
            value.operator,
            value.passwordHash,
            value.totpEnabled,
            value.totpSecret,
            value.requireTotpAfterPasskey,
            value.userHandle,
            [value.realm.origin, value.realm.rpID],
            value.credentials.map((key) => [key.id, key.publicKey, key.counter, key.rpID]),
          ],
        ]),
      )
      .digest('hex');
    const result = describeRecoveryIdentityContent(source.bytes, source.digest);
    expect(result).toEqual({
      schema: 'orbis.sentinel-identity-content.v1',
      identitySha256: source.digest,
      contentSha256: expected,
      description: describeRecoveryIdentity(source.bytes, source.digest),
    });
    const updated = proof({ ...value, revision: 'b'.repeat(64) });
    expect(updated.contentSha256).toBe(result.contentSha256);
    expect(updated.identitySha256).not.toBe(result.identitySha256);
    expect(updated.description.revision).toBe('b'.repeat(64));
    const serialized = JSON.stringify(result);
    for (const secret of [value.username, value.passwordHash, value.userHandle, value.credentials[0]?.publicKey]) {
      if (secret) expect(serialized).not.toContain(secret);
    }
    expect(() => describeRecoveryIdentityContent(source.bytes, 'f'.repeat(64))).toThrow(failure);
  });

  it('normalizes object property order and whitespace while preserving credential array order', () => {
    const value = identity();
    const first = proof(value);
    const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(value).reverse());
    reordered.realm = Object.fromEntries(Object.entries(value.realm).reverse());
    reordered.credentials = value.credentials.map((key) => Object.fromEntries(Object.entries(key).reverse()));
    const text = encoded(JSON.stringify(reordered, null, 2));
    expect(describeRecoveryIdentityContent(text.bytes, text.digest).contentSha256).toBe(first.contentSha256);
    const secondKey = { ...value.credentials[0], id: base64('second-id') };
    const keys = [value.credentials[0], secondKey];
    expect(proof({ ...value, credentials: keys }).contentSha256).not.toBe(proof({ ...value, credentials: [...keys].reverse() }).contentSha256);
  });

  it.each([
    ['account', { accountId: 2 }],
    ['username', { username: 'other' }],
    ['password', { passwordHash: passwordHash.replace('t=2', 't=3') }],
    ['totp', { totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' }],
    ['passkey policy', { requireTotpAfterPasskey: true }],
    ['handle', { userHandle: base64('other-handle') }],
    ['realm', { realm: { origin: 'https://other.example', rpID: 'other.example' } }],
    ['key membership', { credentials: [] }],
    ['key id', { credentials: [{ ...identity().credentials[0], id: base64('other-id') }] }],
    ['public key', { credentials: [{ ...identity().credentials[0], publicKey: base64('other-public-key') }] }],
    ['counter', { credentials: [{ ...identity().credentials[0], counter: 4 }] }],
    ['key rpID', { credentials: [{ ...identity().credentials[0], rpID: 'other.example' }] }],
  ])('includes %s content rather than trusting matching public metadata', (_name, changes) => {
    expect(proof({ ...identity(), ...changes }).contentSha256).not.toBe(proof(identity()).contentSha256);
  });

  it.each([
    ['schema', { schema: 'other' }],
    ['role', { operator: false }],
    ['extra field', { authorityOverride: true }],
    ['unsafe account', { accountId: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe counter', { credentials: [{ ...identity().credentials[0], counter: 0x1_0000_0000 }] }],
    ['unpaired username surrogate', { username: '\ud800' }],
    ['unpaired property surrogate', { '\udc00': true }],
  ])('refuses malformed %s content before issuing a proof', (_name, changes) => {
    expect(() => proof({ ...identity(), ...changes })).toThrow(failure);
  });

  it.each([
    ['top-level field', (text: string) => text.replace('"accountId":1', '"accountId":1,"accountId":2')],
    ['escaped equivalent key', (text: string) => text.replace('"accountId":1', '"accountId":1,"account\\u0049d":1')],
    [
      'realm field',
      (text: string) => text.replace('"origin":"https://orbis.example"', '"origin":"https://orbis.example","origin":"https://orbis.example"'),
    ],
    ['credential field', (text: string) => text.replace('"counter":3', '"counter":3,"counter":3')],
    ['prototype field', (text: string) => text.replace('"accountId":1', '"__proto__":{},"__proto__":{},"accountId":1')],
  ])('rejects duplicate %s even when the effective last value would validate', (_name, change) => {
    const input = encoded(change(JSON.stringify(identity())));
    expect(() => describeRecoveryIdentityContent(input.bytes, input.digest)).toThrow(failure);
    expect(() => readRecoveryIdentity(input.bytes, input.digest)).toThrow(failure);
    expect(() => describeRecoveryIdentity(input.bytes, input.digest)).toThrow(failure);
  });

  it.each([
    ['BOM', '\ufeff'],
    ['trailing JSON', 'true'],
    ['non-JSON whitespace', '\u00a0'],
  ])('rejects %s ambiguity', (kind, extra) => {
    const input = encoded(kind === 'BOM' ? extra + JSON.stringify(identity()) : JSON.stringify(identity()) + extra);
    expect(() => describeRecoveryIdentityContent(input.bytes, input.digest)).toThrow(failure);
  });

  it('rejects malformed encodings, recursive structures and non-finite numbers with generic errors', () => {
    const inputs = [
      Buffer.from([0xff]),
      Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.from(`${'['.repeat(40)}0${']'.repeat(40)}`),
      Buffer.from(JSON.stringify(identity()).replace('"accountId":1', '"accountId":1e999')),
      Buffer.from(JSON.stringify(identity()).replace('"accountId":1', '"accountId":01')),
      Buffer.from(JSON.stringify(identity()).replace('"accountId":1', '"accountId":NaN')),
      Buffer.from(JSON.stringify(identity()).replace('"accountId":1', '"accountId":1.0')),
      Buffer.from(JSON.stringify(identity()).replace('"accountId":1', '"accountId":1e0')),
      Buffer.from(JSON.stringify(identity()).replace('"accountId":1', '"accountId":9007199254740990.9')),
      Buffer.from(JSON.stringify(identity()).replace('"counter":3', '"counter":-0')),
      Buffer.from(JSON.stringify(identity()).replace('"operator":true', '"operator":true,')),
      Buffer.from(JSON.stringify(identity()).replace('"username":"operator"', '"username":"\\q"')),
    ];
    for (const bytes of inputs) {
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(() => describeRecoveryIdentityContent(bytes, digest)).toThrow(failure);
    }
    // A valid Unicode scalar pair is preserved, not normalized into another account name.
    expect(proof({ ...identity(), username: '\ud83c\udf0c' }).contentSha256).not.toBe(proof(identity()).contentSha256);
  });
});
