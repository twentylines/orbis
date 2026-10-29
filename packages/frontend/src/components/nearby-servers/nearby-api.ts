import { type } from 'arktype';

const nic = type({ id: 'string', address: 'string', prefixLength: 'number' });
const candidate = type({ id: 'string', origin: 'string', address: 'string', port: 'number', expiresAt: 'string', verified: 'false' });
const availableInterfaces = type({ available: 'true', interfaces: nic.array().atMostLength(32) });
const availableCandidates = type({ available: 'true', candidates: candidate.array().atMostLength(16) });
export type NearbyCandidate = typeof candidate.infer;
export type NearbyInterface = typeof nic.infer;
export const nearbyFallback = 'Nearby discovery is unavailable. Enter the server address manually.';

export function nearbyOrigin(value: string) {
  const url = new URL(value);
  if (
    value.length > 240 ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.port === '0'
  )
    throw new Error('Invalid nearby HTTPS address.');
  return url.origin;
}
export function parseNearby(value: unknown, kind: 'interfaces' | 'scan') {
  if (value && typeof value === 'object' && 'available' in value && value.available === false) return { available: false as const };
  if (kind === 'interfaces') {
    const result = availableInterfaces(value);
    if (
      result instanceof type.errors ||
      result.interfaces.some(
        (item) =>
          !/^[A-Za-z0-9_.-]{1,15}$/.test(item.id) ||
          item.address.length > 15 ||
          !Number.isInteger(item.prefixLength) ||
          item.prefixLength < 8 ||
          item.prefixLength > 30,
      )
    )
      throw new Error(nearbyFallback);
    return result;
  }
  const result = availableCandidates(value);
  if (
    result instanceof type.errors ||
    result.candidates.some(
      (item) =>
        !/^[a-f0-9]{32}$/.test(item.id) ||
        !Number.isInteger(item.port) ||
        item.port < 1 ||
        item.port > 65535 ||
        !Number.isFinite(Date.parse(item.expiresAt)),
    )
  )
    throw new Error(nearbyFallback);
  return { ...result, candidates: result.candidates.map((item) => ({ ...item, origin: nearbyOrigin(item.origin) })) };
}

async function request(action: 'interfaces' | 'scan' | 'advertise' | 'disable', body?: object, signal?: AbortSignal) {
  const response = await fetch(`/api/nearby-discovery/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(nearbyFallback);
  return response.json() as Promise<unknown>;
}
export async function nearbyInterfaces(signal?: AbortSignal) {
  return parseNearby(await request('interfaces', undefined, signal), 'interfaces');
}
export async function scanNearby(selected: string, signal?: AbortSignal) {
  return parseNearby(await request('scan', { interface: selected }, signal), 'scan');
}
export async function showNearby(selected: string, origin: string, signal?: AbortSignal) {
  const value = await request('advertise', { interface: selected, origin: nearbyOrigin(origin), leaseSeconds: 120 }, signal);
  if (!value || typeof value !== 'object' || !('available' in value) || value.available !== true) throw new Error(nearbyFallback);
}
export async function hideNearby(signal?: AbortSignal) {
  await request('disable', {}, signal);
}
