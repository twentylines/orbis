import { isIP } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import { privateTransferAddress, transferOrigin } from '../host-transfer/transfer-transport';

export const discoveryUnavailable = () => ({
  available: false as const,
  reason: 'Nearby discovery is unavailable. Enter the server address manually.',
});
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid discovery response');
  return value as Record<string, unknown>;
};
export function discoveryBody(value: unknown, keys: string[]) {
  let body: Record<string, unknown>;
  try {
    body = record(value);
  } catch {
    throw new BadRequestException('Provide the nearby discovery fields.');
  }
  if (Object.keys(body).some((key) => !keys.includes(key))) throw new BadRequestException('Provide only the nearby discovery fields.');
  return body;
}
export function discoveryInterface(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,15}$/.test(value)) throw new BadRequestException('Choose one private LAN interface.');
  return value;
}
export function discoveryLease(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 30 || Number(value) > 300)
    throw new BadRequestException('Nearby visibility must last 30 to 300 seconds.');
  return value as number;
}
const timestamp = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error('Invalid discovery expiry');
  return value;
};
const origin = (value: unknown) => {
  const url = transferOrigin(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.origin.length > 240 || (url.port && Number(url.port) === 0) || (isIP(host) && !privateTransferAddress(host)))
    throw new Error('Invalid discovery origin');
  return url.origin;
};
const ipv4 = (value: unknown) => {
  if (typeof value !== 'string' || isIP(value) !== 4 || !privateTransferAddress(value)) throw new Error('Invalid LAN address');
  return value;
};

export function discoveryResponse(value: unknown, kind: 'status' | 'interfaces' | 'scan') {
  const data = record(value);
  if (data.available !== true) return discoveryUnavailable();
  if (kind === 'interfaces') {
    if (!Array.isArray(data.interfaces) || data.interfaces.length > 32) throw new Error('Invalid interface list');
    return {
      available: true as const,
      interfaces: data.interfaces.map((value) => {
        const item = record(value);
        if (
          !Number.isInteger(item.index) ||
          Number(item.index) < 1 ||
          !Number.isInteger(item.prefixLength) ||
          Number(item.prefixLength) < 8 ||
          Number(item.prefixLength) > 30
        )
          throw new Error('Invalid LAN interface');
        return { id: discoveryInterface(item.id), address: ipv4(item.address), prefixLength: Number(item.prefixLength) };
      }),
    };
  }
  if (kind === 'scan') {
    if (!Array.isArray(data.candidates) || data.candidates.length > 16) throw new Error('Invalid nearby list');
    return {
      available: true as const,
      candidates: data.candidates.map((value) => {
        const item = record(value);
        if (
          typeof item.id !== 'string' ||
          !/^[a-f0-9]{32}$/.test(item.id) ||
          item.verified !== false ||
          !Number.isInteger(item.port) ||
          Number(item.port) < 1 ||
          Number(item.port) > 65535
        )
          throw new Error('Invalid nearby candidate');
        const endpoint = origin(item.origin);
        const address = ipv4(item.address);
        const url = new URL(endpoint);
        if (Number(url.port || 443) !== Number(item.port) || (isIP(url.hostname) && url.hostname !== address))
          throw new Error('Invalid candidate endpoint');
        return { id: item.id, origin: endpoint, address, port: Number(item.port), expiresAt: timestamp(item.expiresAt), verified: false as const };
      }),
    };
  }
  const sharing = data.sharing === null ? null : record(data.sharing);
  return {
    available: true as const,
    sharing:
      sharing === null
        ? null
        : { origin: origin(sharing.origin), interface: discoveryInterface(sharing.interface), expiresAt: timestamp(sharing.expiresAt) },
  };
}
