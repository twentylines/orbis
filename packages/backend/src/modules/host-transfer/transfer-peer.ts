import { isIP } from 'node:net';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { privateTransferAddress } from './transfer-transport';

const address = (value: string) => value.replace(/^::ffff:/i, '');
function trusted(addressValue: string, rules: string[]) {
  return privateTransferAddress(addressValue) && rules.some((rule) => isIP(rule) && address(rule) === addressValue);
}

export function assertPrivateTransferPeer(request: Request, trustedProxyIps: string[]) {
  const refuse = () => {
    throw new ForbiddenException('Transfer peers require a private LAN HTTPS connection through a configured trusted ingress.');
  };
  const socketAddress = address(request.socket.remoteAddress ?? '');
  if (!privateTransferAddress(socketAddress)) return refuse();
  const counts = new Map<string, number>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count > 1) || request.headers.forwarded !== undefined) return refuse();
  const forwarded = request.headers['x-forwarded-for'];
  const protocol = request.headers['x-forwarded-proto'];
  const directTls = (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted === true;
  if (forwarded === undefined && protocol === undefined) {
    if (!directTls || !request.secure || address(request.ip ?? '') !== socketAddress) return refuse();
    return;
  }
  if (
    typeof forwarded !== 'string' ||
    typeof protocol !== 'string' ||
    protocol !== 'https' ||
    counts.get('x-forwarded-for') !== 1 ||
    counts.get('x-forwarded-proto') !== 1 ||
    forwarded.length > 1024 ||
    !trusted(socketAddress, trustedProxyIps)
  )
    return refuse();
  const chain = forwarded.split(',').map((value) => value.trim());
  if (!chain.length || chain.length > 8 || chain.some((value) => !isIP(value) || !privateTransferAddress(value))) return refuse();
  const client = chain[0];
  if (!client || !request.secure || address(request.ip ?? '') !== address(client)) return refuse();
  if (chain.slice(1).some((hop) => !trusted(address(hop), trustedProxyIps))) return refuse();
  for (const header of ['x-real-ip', 'cf-connecting-ip', 'true-client-ip']) {
    const value = request.headers[header];
    if (value !== undefined && (typeof value !== 'string' || !isIP(value) || address(value) !== address(client))) return refuse();
  }
}
