import { createHash } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { timeMachineRestoreBindingSchema, type TimeMachineRestoreBinding } from '@runtipi/common/schemas/time-machine-restore';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { PasskeyService } from '../auth/passkey.service';
import { backupCredentials } from './backup-access';
import { TimeMachineRestoreGrants, type RestoreGrantActor } from './time-machine-restore-grants';
import { BackupRestoreJournal } from './backup-restore-journal';
import { recordRetainedRestoreAdmission, revokeRetainedRestorePermit } from './time-machine-restore-admission';

const rejected = () => new ConflictException({ code: 'authorization-invalid', message: 'Verify this exact restore again before continuing.' });
const sameActor = (first: RestoreGrantActor, second: RestoreGrantActor) =>
  first.userId === second.userId && first.sessionBinding === second.sessionBinding && first.securityBinding === second.securityBinding;
const bindingDigest = (binding: TimeMachineRestoreBinding) => {
  timeMachineRestoreBindingSchema.assert(binding);
  return createHash('sha256')
    .update(
      `orbis-time-machine-activate-v1\n${binding.pointId}\n${binding.reviewId}\n${binding.archiveSha256}\n${binding.manifestSha256}\n${binding.machineId}`,
    )
    .digest('hex');
};

@Injectable()
export class TimeMachineRestoreAuthorization {
  private readonly grants = new TimeMachineRestoreGrants();
  constructor(
    private readonly auth: AuthService,
    private readonly passkeys: PasskeyService,
  ) {}

  async password(request: Request, binding: TimeMachineRestoreBinding, body: unknown) {
    bindingDigest(binding);
    const credentials = backupCredentials(body);
    const before = await this.auth.operatorActionContext(request);
    await this.auth.verifySensitiveAction(before.userId, credentials.password, credentials.totpCode);
    const after = await this.auth.operatorActionContext(request);
    if (!sameActor(before, after)) throw rejected();
    return this.grants.issue(binding, after);
  }

  async passkeyOptions(request: Request, binding: TimeMachineRestoreBinding) {
    return {
      version: 1 as const,
      method: 'passkey' as const,
      reviewId: binding.reviewId,
      ...(await this.passkeys.sensitiveOptions(request, bindingDigest(binding))),
    };
  }

  async passkey(request: Request, binding: TimeMachineRestoreBinding, body: unknown) {
    const proof = await this.passkeys.verifySensitive(request, bindingDigest(binding), body);
    const current = await this.auth.operatorActionContext(request);
    if (!sameActor(proof, current)) throw rejected();
    return this.grants.issue(binding, current);
  }

  async consume(request: Request, binding: TimeMachineRestoreBinding, grantId: string) {
    const actor = await this.auth.operatorActionContext(request);
    if (!this.grants.consume(grantId, binding, actor)) throw rejected();
  }

  async admit(request: Request, binding: TimeMachineRestoreBinding, grantId: string, importId: string, journal: BackupRestoreJournal) {
    const actor = await this.auth.operatorActionContext(request);
    if (!this.grants.consume(grantId, binding, actor)) throw rejected();
    const permit = await recordRetainedRestoreAdmission(journal, actor.userId, importId, binding, {
      sha256: createHash('sha256')
        .update(`orbis-time-machine-admission-actor-v1\n${actor.userId}\n${actor.sessionBinding}\n${actor.securityBinding}`)
        .digest('hex'),
      verify: async () => {
        if (!sameActor(actor, await this.auth.operatorActionContext(request))) throw rejected();
      },
    });
    try {
      if (!sameActor(actor, await this.auth.operatorActionContext(request))) throw rejected();
      return permit;
    } catch (error) {
      revokeRetainedRestorePermit(permit);
      throw error;
    }
  }
}
