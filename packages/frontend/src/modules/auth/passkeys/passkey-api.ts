import type { LoginDto } from '@/api-client';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

export type PasskeyCredential = { id: string; name: string; createdAt: number; lastUsedAt: number | null };
export type PasskeyAvailability = { available: boolean; reason?: string };
export type PasskeyPolicy = { requireTotpAfterPasskey: boolean; totpEnabled: boolean };
export type PasskeyList = PasskeyAvailability & { credentials: PasskeyCredential[]; policy: PasskeyPolicy };

class PasskeyRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, body?: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const response = await fetch(`/api/auth/passkeys${path}`, {
    method: body === undefined ? 'GET' : method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new PasskeyRequestError(response.status, typeof result?.message === 'string' ? result.message : '');
  return result as T;
}

export function browserPasskeyReason(): string | null {
  if (window.location.hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname))
    return 'Passkeys require an HTTPS hostname instead of an IP address. You can still sign in with your password.';
  if (!window.isSecureContext) return 'Passkeys need HTTPS on your usual Orbis address. You can still sign in with your password.';
  if (!window.PublicKeyCredential || !navigator.credentials) return 'This browser does not support passkeys. You can still use your password.';
  return null;
}

export const passkeyAvailabilityOptions = () => ({
  queryKey: ['auth', 'passkeys', 'availability'] as const,
  queryFn: () => request<PasskeyAvailability>('/availability'),
  staleTime: 60_000,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});
export const passkeyListOptions = () => ({
  queryKey: ['auth', 'passkeys', 'list'] as const,
  queryFn: () => request<PasskeyList>(''),
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

let client: Promise<typeof import('@simplewebauthn/browser')> | undefined;
const loadClient = () => {
  client ??= import('@simplewebauthn/browser').catch((error) => {
    client = undefined;
    throw error;
  });
  return client;
};
export const warmPasskeyClient = () => {
  if (!browserPasskeyReason())
    void loadClient().catch(() => {
      client = undefined;
    });
};
export const cancelPasskeyCeremony = () => {
  void client?.then(
    (module) => module.WebAuthnAbortService.cancelCeremony(),
    () => undefined,
  );
};

export async function signInWithPasskey(active: () => boolean, redirectUrl?: string): Promise<LoginDto> {
  const module = await loadClient();
  if (!active()) throw new DOMException('Request cancelled', 'AbortError');
  const { options } = await request<{ options: PublicKeyCredentialRequestOptionsJSON }>('/login/options', {});
  if (!active()) throw new DOMException('Request cancelled', 'AbortError');
  const response = await module.startAuthentication({ optionsJSON: options });
  if (!active()) throw new DOMException('Request cancelled', 'AbortError');
  return request<LoginDto>('/login/verify', { response, redirectUrl });
}

export async function addPasskey(input: { name: string; password: string; totpCode?: string }, active: () => boolean): Promise<void> {
  const module = await loadClient();
  if (!active()) throw new DOMException('Request cancelled', 'AbortError');
  const { options } = await request<{ options: PublicKeyCredentialCreationOptionsJSON }>('/register/options', input);
  if (!active()) throw new DOMException('Request cancelled', 'AbortError');
  const response = await module.startRegistration({ optionsJSON: options });
  if (!active()) throw new DOMException('Request cancelled', 'AbortError');
  await request('/register/verify', { response });
}
export const removePasskey = (input: { id: string; password: string; totpCode?: string }) => request('/remove', input);
export const updatePasskeyPolicy = (input: { requireTotpAfterPasskey: boolean; password: string; totpCode?: string }) =>
  request<PasskeyPolicy>('/policy', input, 'PUT');

export function passkeyErrorMessage(error: unknown): string {
  if (error instanceof PasskeyRequestError) {
    if (error.status === 401 || error.status === 403)
      return 'The request could not be verified. Check your password and account verification code, or sign in again.';
    if (error.status === 429) return 'Too many attempts. Wait a moment and try again.';
    if (error.message && !/^[A-Z_]+$/.test(error.message)) return error.message;
    return 'The passkey request could not be completed. Try again or use your password.';
  }
  const detail = error instanceof Error && error.cause ? error.cause : error;
  const name = detail && typeof detail === 'object' && 'name' in detail ? detail.name : null;
  if (['NotAllowedError', 'AbortError', 'TimeoutError'].includes(String(name)))
    return 'The passkey request was cancelled or timed out. Try again or use your password.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for this account. Try another device or password manager.';
  if (name === 'SecurityError') return 'Passkeys cannot be used at this address. Open Orbis at its HTTPS hostname, or use your password.';
  return 'The passkey request could not be completed. Try again or use your password.';
}
