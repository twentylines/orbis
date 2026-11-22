import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { recoveryAuthenticationArguments, recoveryAuthenticationCapability, runRecoveryAuthenticationWorker } from './worker';

describe('independent recovery authentication worker protocol', () => {
  it('reports verification capability without reading credentials or granting a session', async () => {
    expect(await runRecoveryAuthenticationWorker(['--capability'])).toEqual(recoveryAuthenticationCapability);
    expect(recoveryAuthenticationCapability).toMatchObject({ databaseRequired: false, mutations: 'none', grantsAuthority: false });
  });

  it('accepts only a fixed action, protected identity digest and full-entropy challenge', () => {
    const challenge = randomBytes(32).toString('base64url');
    expect(recoveryAuthenticationArguments(['--verify', 'a'.repeat(64), challenge])).toEqual({
      mode: 'verify',
      identitySha256: 'a'.repeat(64),
      challenge,
    });
  });

  it('describes only the fixed protected profile without accepting a file path or a credential request', () => {
    expect(recoveryAuthenticationArguments(['--describe-identity', 'a'.repeat(64)])).toEqual({
      mode: 'describe-identity',
      identitySha256: 'a'.repeat(64),
    });
    expect(recoveryAuthenticationArguments(['--describe-content', 'a'.repeat(64)])).toEqual({
      mode: 'describe-content',
      identitySha256: 'a'.repeat(64),
    });
  });

  it('separates effective-content and counter-only modes from authentication', () => {
    const challenge = randomBytes(32).toString('base64url');
    expect(recoveryAuthenticationArguments(['--describe-effective-content', 'a'.repeat(64)])).toEqual({
      mode: 'describe-effective-content',
      identitySha256: 'a'.repeat(64),
    });
    expect(recoveryAuthenticationArguments(['--verify-counter', 'a'.repeat(64), challenge])).toEqual({
      mode: 'verify-counter',
      identitySha256: 'a'.repeat(64),
      challenge,
    });
    expect(recoveryAuthenticationCapability).toMatchObject({
      effectiveIdentityContentProof: 'orbis.sentinel-effective-identity-content.v1',
      passkeyCounterProof: 'orbis.sentinel-passkey-counter.v1',
      grantsAuthority: false,
    });
    expect(() => recoveryAuthenticationArguments(['--verify-counter', 'a'.repeat(64), 'short'])).toThrow();
    expect(() => recoveryAuthenticationArguments(['--describe-effective-content', 'a'.repeat(64), 'extra'])).toThrow();
  });

  it.each(
    [
      [],
      ['--verify'],
      ['--capability', '/another/file'],
      ['--verify', 'short', 'short'],
      ['--verify', 'A'.repeat(64), randomBytes(32).toString('base64url')],
      ['--verify', 'a'.repeat(64), randomBytes(31).toString('base64url')],
      ['--profile', '/another/file'],
      ['--describe-identity'],
      ['--describe-identity', 'A'.repeat(64)],
      ['--describe-identity', 'a'.repeat(64), '/another/file'],
      ['--describe-content'],
      ['--describe-content', 'A'.repeat(64)],
      ['--describe-content', 'a'.repeat(64), '/another/file'],
      ['--verify', 'a'.repeat(64), randomBytes(32).toString('base64url'), '--bypass'],
    ].map((args) => ({ args })),
  )('rejects unsupported arguments %# without printing input', ({ args }) => {
    expect(() => recoveryAuthenticationArguments(args)).toThrow('The protected recovery identity could not be verified.');
  });
});
