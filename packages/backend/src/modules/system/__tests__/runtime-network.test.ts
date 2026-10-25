import { describe, expect, it } from 'vitest';
import { parseRuntimeNetwork, runtimeNetworkRates } from '../runtime-network';

describe('runtime network counters', () => {
  it('reads receive and transmit byte columns without confusing packets or errors', () => {
    const counters = parseRuntimeNetwork(
      'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n eth0: 1000 4 0 0 0 0 0 0 3000 9 0 0 0 0 0 0\n lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
    );
    expect(counters.get('eth0')).toEqual({ iface: 'eth0', rx_bytes: 1000, tx_bytes: 3000 });
    expect(counters.get('lo')).toEqual({ iface: 'lo', rx_bytes: 0, tx_bytes: 0 });
  });

  it('rejects malformed and unsafe counters', () => {
    for (const row of [
      'eth0: 1 2 3',
      'eth0: -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
      'eth0: 9007199254740992 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
      'eth0: 1 0 0 0 0 0 0 0 NaN 0 0 0 0 0 0 0',
    ]) {
      expect(parseRuntimeNetwork(row).size).toBe(0);
    }
  });

  it('uses elapsed time and keeps counters separate for each direction', () => {
    const previous = { iface: 'eth0', at: 1000, rx_bytes: 1000, tx_bytes: 3000 };
    expect(runtimeNetworkRates(previous, { iface: 'eth0', at: 3000, rx_bytes: 5000, tx_bytes: 5000 })).toMatchObject({ rx_sec: 2000, tx_sec: 1000 });
    expect(runtimeNetworkRates(previous, { iface: 'eth0', at: 3000, rx_bytes: 1, tx_bytes: 5000 })).toMatchObject({ rx_sec: null, tx_sec: 1000 });
  });

  it('does not manufacture rates after an idle gap, clock reset or interface replacement', () => {
    const previous = { iface: 'eth0', at: 1000, rx_bytes: 1000, tx_bytes: 3000 };
    for (const before of [null, { ...previous, at: 40_000 }, { ...previous, at: 2000 }, { ...previous, iface: 'eth1' }]) {
      expect(runtimeNetworkRates(before, { iface: 'eth0', at: 2000, rx_bytes: 5000, tx_bytes: 5000 })).toMatchObject({ rx_sec: null, tx_sec: null });
    }
    expect(runtimeNetworkRates(previous, { iface: 'eth0', at: 32_000, rx_bytes: 5000, tx_bytes: 5000 })).toMatchObject({
      rx_sec: null,
      tx_sec: null,
    });
  });
});
