import { BadRequestException } from '@nestjs/common';

export type RequestEncryption = 'source-account-password' | 'separate-passphrase';
export type IncomingRequestStatus =
  | 'awaiting-approval'
  | 'approving'
  | 'exporting'
  | 'ready'
  | 'sending'
  | 'complete'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'failed';
export type OutgoingRequestStatus =
  | 'awaiting-source-approval'
  | 'checking-approval'
  | 'source-exporting'
  | 'receiving'
  | 'complete'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'failed';
export const requestTerminal = new Set<string>(['complete', 'rejected', 'cancelled', 'expired', 'failed']);
export const requestId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const requestSecret = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function requestFields(body: unknown, allowed: readonly string[], maximum = 1024): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key)))
    throw new BadRequestException('Provide only the requested restore details.');
  try {
    if (Buffer.byteLength(JSON.stringify(body)) > maximum) throw new Error();
  } catch {
    throw new BadRequestException('The restore request is too large or invalid.');
  }
  return body as Record<string, unknown>;
}
