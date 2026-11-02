import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthService } from '../auth/auth.service';
import type { AccountSecurityService } from '../auth/account-security.service';

type Credentials = { password: string; totpCode?: string };
export async function authorizeBackupRestoreSession(
  auth: AuthService,
  security: AccountSecurityService | undefined,
  request: Request,
  ownerId: number,
  credentials: Credentials | undefined,
  expected?: { userId: number; sessionBinding: string; securityBinding: string; revision: number },
) {
  if (!security) throw new ForbiddenException('Account security is unavailable.');
  const actor = await auth.operatorActionContext(request);
  const policy = await security.read(ownerId);
  if (
    actor.userId !== ownerId ||
    (expected &&
      (expected.userId !== actor.userId ||
        expected.sessionBinding !== actor.sessionBinding ||
        expected.securityBinding !== actor.securityBinding ||
        expected.revision !== policy.revision))
  )
    throw new ForbiddenException('The operator session or security setting changed.');
  if (policy.requireRestoreAuthentication) {
    if (!credentials?.password) throw new ForbiddenException('Confirm this restore with your account password.');
    await auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const checked = await auth.operatorActionContext(request);
    const latest = await security.read(ownerId);
    if (
      checked.userId !== actor.userId ||
      checked.sessionBinding !== actor.sessionBinding ||
      checked.securityBinding !== actor.securityBinding ||
      latest.revision !== policy.revision
    )
      throw new ForbiddenException('The operator session or security setting changed.');
  }
  return { ...actor, revision: policy.revision };
}
