import { createHash, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { privateTransferAddress } from './transfer-transport';
import { sourceCertificate } from './transfer-certificates';

export function inspectPublicCertificate(body: unknown) {
  const refuse = () => {
    throw new BadRequestException('Choose one current self-signed public certificate or CA root up to 64 KB. Private keys and bundles are refused.');
  };
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'certificatePem')) return refuse();
  const pem = (body as { certificatePem?: unknown }).certificatePem;
  if (
    typeof pem !== 'string' ||
    Buffer.byteLength(pem) > 65536 ||
    !/^\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\s*$/.test(pem)
  )
    return refuse();
  try {
    const sha256 = createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
    // Reuse anchor validation without creating a peer or granting certificate trust.
    const certificate = sourceCertificate({ sourceCertificatePem: pem, sourceCertificateSha256: sha256, confirmSourceCertificate: true });
    if (!certificate) return refuse();
    return { sha256: certificate.sha256 };
  } catch {
    return refuse();
  }
}

export function assertPrivateCertificateInspection(request: Request, verifiedProxies: string[]) {
  const normalize = (value: string) => value.replace(/^::ffff:/i, '');
  const refuse = () => {
    throw new ForbiddenException('Public certificate inspection requires a private direct connection or this server’s verified managed ingress.');
  };
  const socket = normalize(request.socket.remoteAddress ?? '');
  if (!privateTransferAddress(socket)) return refuse();
  const counts = new Map<string, number>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count !== 1) || request.headers.forwarded !== undefined) return refuse();
  const forwarded = request.headers['x-forwarded-for'];
  const protocol = request.headers['x-forwarded-proto'];
  const host = request.headers['x-forwarded-host'];
  if (host !== undefined && (typeof host !== 'string' || host.toLowerCase() !== request.headers.host?.toLowerCase())) return refuse();
  const clientHeaders = ['x-real-ip', 'cf-connecting-ip', 'true-client-ip'];
  if (forwarded === undefined && protocol === undefined) {
    if (
      host !== undefined ||
      clientHeaders.some((name) => request.headers[name] !== undefined) ||
      normalize(request.ip ?? '') !== socket ||
      !['http', 'https'].includes(request.protocol)
    )
      return refuse();
    return;
  }
  const trusted = (value: string) =>
    privateTransferAddress(value) && verifiedProxies.some((proxy) => isIP(proxy) && normalize(proxy) === normalize(value));
  if (
    typeof forwarded !== 'string' ||
    forwarded.length > 1024 ||
    !['http', 'https'].includes(String(protocol)) ||
    request.protocol !== protocol ||
    counts.get('x-forwarded-for') !== 1 ||
    counts.get('x-forwarded-proto') !== 1 ||
    !trusted(socket)
  )
    return refuse();
  const chain = forwarded.split(',').map((value) => value.trim());
  if (
    !chain.length ||
    chain.length > 8 ||
    chain.some((value) => !isIP(value) || !privateTransferAddress(value)) ||
    normalize(request.ip ?? '') !== normalize(chain[0] ?? '') ||
    chain.slice(1).some((value) => !trusted(value))
  )
    return refuse();
  for (const name of clientHeaders) {
    const value = request.headers[name];
    if (value !== undefined && (typeof value !== 'string' || !isIP(value) || normalize(value) !== normalize(chain[0] ?? ''))) return refuse();
  }
}
