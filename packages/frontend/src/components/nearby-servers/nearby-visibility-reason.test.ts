import { expect, test } from 'bun:test';
import { nearbyAdvertisingMessage, nearbyUnavailableCode, nearbyUnavailableMessage } from './nearby-visibility-reason';
test('bounded unavailable reason codes stay distinct and never reflect raw host diagnostics', () => {
  for (const value of ['/private/host/socket', 'bad-cert-body', { code: 'unsupported' }, undefined])
    expect(nearbyUnavailableCode(value)).toBeUndefined();
  expect(nearbyUnavailableMessage('host-unavailable')).toContain('host discovery service is unavailable');
  expect(nearbyUnavailableMessage('unsupported')).toContain('does not support');
  expect(nearbyUnavailableMessage('https-required')).toContain('private HTTPS hostname');
  expect(nearbyUnavailableMessage('interface-unavailable')).toContain('private LAN interface');
  expect(nearbyUnavailableMessage('host-unavailable')).not.toContain('HTTPS');
});
test('HTTP-capable address hints remain unverified and do not imply transport approval', () => {
  const hint = nearbyAdvertisingMessage({ enabled: true, hintVersion: 2, sharing: { kind: 'address' } });
  expect(hint).toContain('unverified private address');
  expect(hint).toContain('HTTPS is required before pairing or transfer');
  expect(nearbyAdvertisingMessage({ enabled: true, sharing: {} })).toContain('still require approval');
  expect(nearbyAdvertisingMessage({ enabled: true, hintVersion: 2, sharing: null })).not.toContain('requires a private HTTPS');
  expect(nearbyAdvertisingMessage({ enabled: true, sharing: null })).toContain('older host service');
  expect(nearbyAdvertisingMessage({ enabled: false, sharing: null })).toBe('Nearby discovery is off.');
});
