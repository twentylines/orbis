import type { Request } from 'express';
import { expect, it } from 'vitest';
import { assertPrivateTransferPeer } from './transfer-peer';

const proxyRules = ['192.168.40.2', '172.20.0.3'];
function peer(overrides: Record<string, unknown> = {}): Request {
  return {
    socket: { remoteAddress: '192.168.40.2' },
    ip: '192.168.40.10',
    secure: true,
    rawHeaders: ['X-Forwarded-For', '192.168.40.10', 'X-Forwarded-Proto', 'https'],
    headers: { 'x-forwarded-for': '192.168.40.10', 'x-forwarded-proto': 'https' },
    ...overrides,
  } as unknown as Request;
}
it('accepts direct private TLS only from the actual encrypted socket', () => {
  expect(() =>
    assertPrivateTransferPeer(peer({ socket: { remoteAddress: '192.168.40.10', encrypted: true }, headers: {}, rawHeaders: [] }), []),
  ).not.toThrow();
  expect(() => assertPrivateTransferPeer(peer({ socket: { remoteAddress: '192.168.40.10' }, headers: {}, rawHeaders: [] }), [])).toThrow(
    'configured trusted ingress',
  );
});
it('accepts an explicit private trusted ingress and a fully private trusted proxy chain', () => {
  expect(() => assertPrivateTransferPeer(peer(), proxyRules)).not.toThrow();
  expect(() =>
    assertPrivateTransferPeer(
      peer({
        rawHeaders: ['X-Forwarded-For', '192.168.40.10, 172.20.0.3', 'X-Forwarded-Proto', 'https'],
        headers: { 'x-forwarded-for': '192.168.40.10, 172.20.0.3', 'x-forwarded-proto': 'https' },
      }),
      proxyRules,
    ),
  ).not.toThrow();
});
it.each([
  '192.168.40.10, 8.8.8.8',
  '192.168.40.10, 8.8.8.8, 172.20.0.3',
  '8.8.8.8',
  '192.168.40.10,,172.20.0.3',
  '192.168.40.10, unknown',
  '192.168.40.10, 127.0.0.1',
  '192.168.40.10, 169.254.1.1',
  '192.168.40.10, 192.168.99.99',
])('rejects spoofed, public, malformed or untrusted forwarded chains: %s', (chain) => {
  expect(() =>
    assertPrivateTransferPeer(
      peer({
        rawHeaders: ['X-Forwarded-For', chain, 'X-Forwarded-Proto', 'https'],
        headers: { 'x-forwarded-for': chain, 'x-forwarded-proto': 'https' },
      }),
      proxyRules,
    ),
  ).toThrow('configured trusted ingress');
});
it.each(
  [
    ['X-Forwarded-For', '192.168.40.10', 'X-Forwarded-For', '8.8.8.8', 'X-Forwarded-Proto', 'https'],
    ['X-Forwarded-For', '192.168.40.10', 'X-Forwarded-Proto', 'https', 'X-Forwarded-Proto', 'http'],
    ['X-Forwarded-For', '192.168.40.10', 'X-Forwarded-Proto', 'https', 'Content-Length', '52', 'Content-Length', '53'],
  ].map((rawHeaders) => ({ rawHeaders })),
)('rejects duplicate raw headers even when Express presents a seemingly valid joined value', ({ rawHeaders }) => {
  expect(() => assertPrivateTransferPeer(peer({ rawHeaders }), proxyRules)).toThrow('configured trusted ingress');
});
it.each([
  { forwarded: 'for=8.8.8.8;proto=https' },
  { 'x-forwarded-proto': 'https,http' },
  { 'x-forwarded-proto': ['https', 'http'] },
  { 'x-real-ip': '8.8.8.8' },
  { 'cf-connecting-ip': '8.8.8.8' },
  { 'true-client-ip': 'invalid' },
])('rejects ambiguous protocol or conflicting client identity headers: %j', (headers) => {
  expect(() =>
    assertPrivateTransferPeer(peer({ headers: { 'x-forwarded-for': '192.168.40.10', 'x-forwarded-proto': 'https', ...headers } }), proxyRules),
  ).toThrow('configured trusted ingress');
});
it('refuses an unconfigured proxy, public socket and effective client mismatch', () => {
  expect(() => assertPrivateTransferPeer(peer(), [])).toThrow('configured trusted ingress');
  expect(() => assertPrivateTransferPeer(peer({ socket: { remoteAddress: '8.8.8.8' } }), proxyRules)).toThrow('configured trusted ingress');
  expect(() => assertPrivateTransferPeer(peer({ ip: '192.168.40.11' }), proxyRules)).toThrow('configured trusted ingress');
});
it('never treats a CIDR or neighboring bridge container as a verified ingress identity', () => {
  expect(() => assertPrivateTransferPeer(peer(), ['192.168.40.0/24'])).toThrow('configured trusted ingress');
  expect(() => assertPrivateTransferPeer(peer({ socket: { remoteAddress: '192.168.40.3' } }), proxyRules)).toThrow('configured trusted ingress');
});
