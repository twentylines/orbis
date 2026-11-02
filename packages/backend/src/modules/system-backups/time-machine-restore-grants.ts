import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  timeMachineRestoreBindingSchema,
  type TimeMachineRestoreBinding,
  type TimeMachineRestoreGrant,
} from '@runtipi/common/schemas/time-machine-restore';

export type RestoreGrantActor = {
  userId: number;
  sessionBinding: string;
  securityBinding: string;
};
type PendingGrant = { binding: TimeMachineRestoreBinding; actor: RestoreGrantActor; issuedAt: number; expiresAt: number };
const validActor = (actor: RestoreGrantActor) =>
  actor &&
  Number.isSafeInteger(actor.userId) &&
  actor.userId > 0 &&
  Object.keys(actor).every((key) => ['userId', 'sessionBinding', 'securityBinding'].includes(key)) &&
  /^[a-f0-9]{64}$/.test(actor.sessionBinding) &&
  /^[a-f0-9]{64}$/.test(actor.securityBinding);
const equal = (first: string, second: string) => {
  const left = Buffer.from(first);
  const right = Buffer.from(second);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Only the authenticated restore service issues grants; this store never accepts credentials or browser-provided bindings.
export class TimeMachineRestoreGrants {
  private readonly pending = new Map<string, PendingGrant>();
  static readonly lifetime = 2 * 60_000;
  static readonly maximum = 128;

  constructor(private readonly now: () => number = Date.now) {}

  issue(binding: TimeMachineRestoreBinding, actor: RestoreGrantActor): TimeMachineRestoreGrant {
    if (!timeMachineRestoreBindingSchema.allows(binding) || !validActor(actor)) throw new Error('Restore authorization binding is invalid.');
    const now = this.now();
    for (const [id, value] of this.pending) if (value.expiresAt <= now || value.issuedAt > now) this.pending.delete(id);
    if (this.pending.size >= TimeMachineRestoreGrants.maximum) throw new Error('Restore authorization is busy. Try again shortly.');
    const grantId = randomUUID();
    const expiresAt = now + TimeMachineRestoreGrants.lifetime;
    this.pending.set(grantId, { binding: { ...binding }, actor: { ...actor }, issuedAt: now, expiresAt });
    return { version: 1, ...binding, grantId, expiresAt };
  }

  consume(grantId: string, binding: TimeMachineRestoreBinding, actor: RestoreGrantActor): boolean {
    const value = this.pending.get(grantId);
    this.pending.delete(grantId);
    const now = this.now();
    return Boolean(
      value &&
        timeMachineRestoreBindingSchema.allows(binding) &&
        validActor(actor) &&
        value.issuedAt <= now &&
        value.expiresAt > now &&
        value.actor.userId === actor.userId &&
        equal(value.actor.sessionBinding, actor.sessionBinding) &&
        equal(value.actor.securityBinding, actor.securityBinding) &&
        (['pointId', 'reviewId', 'archiveSha256', 'manifestSha256', 'machineId'] as const).every((key) => equal(value.binding[key], binding[key])),
    );
  }
}
