import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

export function backupOperator(request: Request) {
  if (request.authMethod !== 'session' || request.user?.operator !== true)
    throw new ForbiddenException('An operator session is required for full backups.');
  return request.user.id;
}

export function backupCredentials(body: unknown, passphrase = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Confirm this action with your account password.');
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['password', 'totpCode', ...(passphrase ? ['passphrase'] : [])].includes(key)) ||
    typeof value.password !== 'string' ||
    !value.password ||
    value.password.length > 1024 ||
    (value.totpCode !== undefined && (typeof value.totpCode !== 'string' || !/^\d{6}$/.test(value.totpCode))) ||
    (passphrase && (typeof value.passphrase !== 'string' || value.passphrase.trim().length < 12 || value.passphrase.length > 1024))
  )
    throw new BadRequestException('Provide your password, authentication code if enabled, and a backup passphrase of at least 12 characters.');
  return { password: value.password, totpCode: value.totpCode as string | undefined, passphrase: value.passphrase as string };
}
