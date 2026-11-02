import { describe, expect, it } from 'bun:test';
import { canMeasureNetwork, networkWarmup } from './network-rate-warmup';
const counters = { interface: 'eth0', receivedBytes: 100, transmittedBytes: 200, rxBytesPerSecond: null, txBytesPerSecond: null };
describe('network rate warmup', () => {
  it('requires both counters and both missing rates, without treating actual zero as missing', () => {
    expect(canMeasureNetwork(counters)).toBe(true);
    expect(canMeasureNetwork({ ...counters, receivedBytes: null })).toBe(false);
    expect(canMeasureNetwork({ ...counters, transmittedBytes: Number.NaN })).toBe(false);
    expect(canMeasureNetwork({ ...counters, rxBytesPerSecond: 0 })).toBe(false);
    expect(canMeasureNetwork(null)).toBe(false);
  });
  it('preserves one deadline across polls; resumes and new interfaces start new windows', () => {
    const first = networkWarmup(null, 'eth0', true, 1000);
    expect(first.deadline).toBe(31000);
    expect(networkWarmup(first, 'eth0', true, 11000)).toBe(first);
    const ready = networkWarmup(first, 'eth0', false, 12000);
    expect(ready.deadline).toBeNull();
    expect(networkWarmup(ready, 'eth0', true, 20000).deadline).toBe(50000);
    expect(networkWarmup(first, 'eth1', true, 30000).deadline).toBe(60000);
    expect(32000 >= (first.deadline ?? Number.POSITIVE_INFINITY)).toBe(true);
  });
});
