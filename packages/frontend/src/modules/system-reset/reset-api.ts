import { type } from 'arktype';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

export type ResetAccounts = 'keep' | 'remove';
export async function resetProofMethod(
  usePassword: boolean,
  browserReason: string | null,
  list: () => Promise<{ available: boolean; credentials: unknown[] }>,
  timeoutMs = 4000,
): Promise<'password' | 'passkey'> {
  if (usePassword || browserReason) return 'password';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      list(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return result?.available && Array.isArray(result.credentials) && result.credentials.length ? 'passkey' : 'password';
  } catch {
    return 'password';
  } finally {
    clearTimeout(timer);
  }
}
const acceptedSchema = type({ '+': 'reject', id: 'string.uuid', state: "'resetting'" });
export type AcceptedReset = typeof acceptedSchema.infer;
type PasswordProof = { method: 'password'; password: string; totpCode?: string };
type PasskeyProof = { method: 'passkey'; challengeId: string; response: AuthenticationResponseJSON; totpCode?: string };
export function validResetConfirmation(value: string) {
  return /^reset orbis$/i.test(value.trim());
}
export function resetPayload(accounts: ResetAccounts, confirmation: string, proof: PasswordProof | PasskeyProof) {
  if (!['keep', 'remove'].includes(accounts) || !validResetConfirmation(confirmation)) throw new Error('Type RESET ORBIS to confirm.');
  if (proof.method === 'password' && (!proof.password || proof.password.length > 1024)) throw new Error('Enter your current account password.');
  if (proof.totpCode !== undefined && !/^\d{6}$/.test(proof.totpCode)) throw new Error('Enter the six-digit authentication code.');
  return { accounts, confirmation: 'RESET ORBIS', ...proof };
}
async function request(path: '' | '/recover' | '/passkey-options', body: unknown, signal: AbortSignal) {
  const response = await fetch(`/api/system-reset${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(40000)]),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Reset status is unavailable. Check server status before retrying.');
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
      if (text.length > 16384) throw new Error('Reset response is unavailable. Check server status before retrying.');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'Wait a minute before trying again.'
        : response.status === 409
          ? 'Server state changed or needs recovery. Check its status before retrying.'
          : response.status === 401 || response.status === 403
            ? 'Sign in with an operator account before resetting Orbis.'
            : response.status === 400
              ? 'Reset was not confirmed. Check your password and authentication code, then try again.'
              : 'Reset could not start because the server reported an error. Check server status before retrying.',
    );
  return JSON.parse(text) as unknown;
}
export async function submitReset(
  accounts: ResetAccounts,
  confirmation: string,
  proof: PasswordProof | PasskeyProof,
  signal: AbortSignal,
  recovery = false,
): Promise<AcceptedReset> {
  return acceptedSchema.assert(await request(recovery ? '/recover' : '', resetPayload(accounts, confirmation, proof), signal));
}
export async function resetPasskeyOptions(accounts: ResetAccounts, signal: AbortSignal) {
  const value = await request('/passkey-options', { accounts }, signal);
  if (
    !value ||
    typeof value !== 'object' ||
    !('challengeId' in value) ||
    !('options' in value) ||
    !('expiresAt' in value) ||
    !('requiresTotp' in value) ||
    typeof value.challengeId !== 'string' ||
    !/^[-a-f0-9]{36}$/.test(value.challengeId) ||
    typeof value.expiresAt !== 'number' ||
    value.expiresAt <= Date.now() ||
    typeof value.requiresTotp !== 'boolean' ||
    !value.options ||
    typeof value.options !== 'object' ||
    !('challenge' in value.options) ||
    typeof value.options.challenge !== 'string'
  )
    throw new Error('The passkey request could not be verified. Try again.');
  return value as { challengeId: string; options: PublicKeyCredentialRequestOptionsJSON; expiresAt: number; requiresTotp: boolean };
}
