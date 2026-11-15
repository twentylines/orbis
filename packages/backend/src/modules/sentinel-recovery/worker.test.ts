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

  it.each(
    [
      [],
      ['--verify'],
      ['--capability', '/another/file'],
      ['--verify', 'short', 'short'],
      ['--verify', 'A'.repeat(64), randomBytes(32).toString('base64url')],
      ['--verify', 'a'.repeat(64), randomBytes(31).toString('base64url')],
      ['--profile', '/another/file'],
      ['--verify', 'a'.repeat(64), randomBytes(32).toString('base64url'), '--bypass'],
    ].map((args) => ({ args })),
  )('rejects unsupported arguments %# without printing input', ({ args }) => {
    expect(() => recoveryAuthenticationArguments(args)).toThrow('The protected recovery identity could not be verified.');
  });
});
