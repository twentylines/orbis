import { accountSecuritySchema, accountSecurityUpdateSchema } from '@runtipi/common/schemas/account-security';
import { type } from 'arktype';
import { boundedBody } from '@/modules/time-machine/time-machine-api';
import type { BackupCredentials } from '@/modules/system-backups/backup-api';

export const accountSecurityKey = (ownerId: number) => ['account-security', ownerId];
async function request(method: 'GET' | 'PUT', signal: AbortSignal, body?: unknown) {
  const response = await fetch('/api/account-security', {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? 'This security setting changed. Refresh before saving.'
        : response.status === 400 || response.status === 401 || response.status === 403
          ? 'Check your current account password and authentication code, if enabled.'
          : 'Account security could not be loaded or saved. Retry before continuing.',
    );
  const value = accountSecuritySchema(JSON.parse(new TextDecoder().decode(await boundedBody(response, 4096))));
  if (value instanceof type.errors) throw new Error('The account security response could not be verified.');
  return value;
}
export const readAccountSecurity = (signal: AbortSignal) => request('GET', signal);
export function saveAccountSecurity(update: unknown, credentials: Partial<BackupCredentials>, signal: AbortSignal) {
  if (!accountSecurityUpdateSchema.allows(update)) throw new Error('Review this account security setting before saving.');
  return request('PUT', signal, { ...update, ...credentials });
}
