import { describe, expect, it } from 'vitest';
import { TimeMachineRestoreGrants } from './time-machine-restore-grants';

const binding = {
  pointId: '11111111-1111-4111-8111-111111111111',
  reviewId: '22222222-2222-4222-8222-222222222222',
  archiveSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  machineId: 'c'.repeat(64),
};
const actor = { userId: 17, sessionBinding: 'd'.repeat(64), securityBinding: 'e'.repeat(64) };

describe('one-use Time Machine restore grants', () => {
  it('consumes exactly once before asynchronous restore work can begin', () => {
    const grants = new TimeMachineRestoreGrants(() => 100);
    const grant = grants.issue(binding, actor);
    expect(grants.consume(grant.grantId, binding, actor)).toBe(true);
    expect(grants.consume(grant.grantId, binding, actor)).toBe(false);
  });
  it.each(['pointId', 'reviewId', 'archiveSha256', 'manifestSha256', 'machineId'] as const)(
    'rejects a different %s and consumes the failed attempt',
    (field) => {
      const grants = new TimeMachineRestoreGrants(() => 100);
      const grant = grants.issue(binding, actor);
      expect(grants.consume(grant.grantId, { ...binding, [field]: 'different' }, actor)).toBe(false);
      expect(grants.consume(grant.grantId, binding, actor)).toBe(false);
    },
  );
  it.each(['userId', 'sessionBinding', 'securityBinding'] as const)('rejects an account, session or policy change in %s', (field) => {
    const grants = new TimeMachineRestoreGrants(() => 100);
    const grant = grants.issue(binding, actor);
    expect(grants.consume(grant.grantId, binding, { ...actor, [field]: field === 'userId' ? 18 : 'different' })).toBe(false);
  });
  it('expires grants and refuses a clock rollback', () => {
    let now = 100;
    const grants = new TimeMachineRestoreGrants(() => now);
    const expired = grants.issue(binding, actor);
    now += TimeMachineRestoreGrants.lifetime;
    expect(grants.consume(expired.grantId, binding, actor)).toBe(false);
    const future = grants.issue(binding, actor);
    now--;
    expect(grants.consume(future.grantId, binding, actor)).toBe(false);
  });
  it('bounds pending grants and reclaims only expired entries', () => {
    let now = 100;
    const grants = new TimeMachineRestoreGrants(() => now);
    for (let count = 0; count < TimeMachineRestoreGrants.maximum; count++) grants.issue(binding, actor);
    expect(() => grants.issue(binding, actor)).toThrow('busy');
    now += TimeMachineRestoreGrants.lifetime;
    expect(grants.issue(binding, actor).expiresAt).toBe(now + TimeMachineRestoreGrants.lifetime);
  });
  it('copies server bindings so later caller mutation cannot retarget a grant', () => {
    const grants = new TimeMachineRestoreGrants(() => 100);
    const original = { ...binding };
    const principal = { ...actor };
    const grant = grants.issue(original, principal);
    original.manifestSha256 = 'changed';
    principal.securityBinding = 'changed';
    expect(grants.consume(grant.grantId, binding, actor)).toBe(true);
  });
  it('rejects malformed bindings and extra credential fields before storing them', () => {
    const grants = new TimeMachineRestoreGrants(() => 100);
    expect(() => grants.issue({ ...binding, machineId: 'invalid' }, actor)).toThrow('binding');
    expect(() => grants.issue(binding, { ...actor, userId: 0 })).toThrow('binding');
    expect(() => grants.issue(binding, { ...actor, password: 'not retained' } as typeof actor)).toThrow('binding');
  });
});
