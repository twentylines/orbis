import { describe, expect, it } from 'vitest';
import { parseHostTelemetry } from '../host-telemetry.service';

const timestamp = '2026-10-18T06:00:00.000Z';
const now = Date.parse(timestamp);
const identity = '0123456789abcdef'.repeat(4);
const diskIdentity = 'fedcba9876543210'.repeat(4);

function sample() {
  return {
    available: true,
    stale: false,
    sampledAt: timestamp,
    filesystems: [{ mount: '/srv/data', filesystem: 'ext4', sizeBytes: 1000, usedBytes: 500, availableBytes: 400, readOnly: false }],
    network: [
      { interface: 'eth0', state: 'up', speedMbps: 1000, receivedBytes: 2000, transmittedBytes: 3000, rxBytesPerSecond: 100, txBytesPerSecond: 200 },
    ],
    disks: [
      { device: 'sda', readBytes: 51200, writtenBytes: 102400, readBytesPerSecond: 5120, writeBytesPerSecond: 10240, busyPercent: 10, inFlight: 1 },
    ],
    omitted: { filesystems: 0, network: 0, disks: 0 },
    unavailable: [],
  };
}

function withIdentity(section: 'network' | 'disks', historyId: unknown) {
  const value = sample();
  return { ...value, [section]: value[section].map((row) => ({ ...row, historyId })) };
}

const malformed: { label: string; value: unknown }[] = [
  { label: 'empty text', value: '' },
  { label: '63characters', value: 'a'.repeat(63) },
  { label: '65characters', value: 'a'.repeat(65) },
  { label: 'uppercase hex', value: 'A'.repeat(64) },
  { label: 'mixed-case hex', value: `${'a'.repeat(63)}F` },
  { label: 'nonhex text', value: 'g'.repeat(64) },
  { label: 'algorithm prefix', value: `sha256:${identity}` },
  { label: 'leading whitespace', value: ` ${identity}` },
  { label: 'trailing whitespace', value: `${identity} ` },
  { label: 'trailing newline', value: `${identity}\n` },
  { label: 'embedded control', value: `${'a'.repeat(31)}\0${'b'.repeat(32)}` },
  { label: 'zero-width character', value: `${'a'.repeat(31)}\u200d${'b'.repeat(32)}` },
  { label: 'fullwidth lookalikes', value: 'ａ'.repeat(64) },
  { label: 'null', value: null },
  { label: 'number', value: 42 },
  { label: 'boolean', value: true },
  { label: 'array', value: [identity] },
  { label: 'nested object', value: { historyId: identity } },
  { label: 'string wrapper', value: Object(identity) },
  { label: 'coercible object', value: { toString: () => identity } },
];

describe('optional opaque host history identity', () => {
  it('retains the complete old-helper payload without inventing capability', () => {
    const old = sample();
    const result = parseHostTelemetry(JSON.parse(JSON.stringify(old)), now);
    expect(result).toEqual(old);
    expect(result.available).toBe(true);
    if (result.available) {
      const network = result.network[0];
      const disk = result.disks[0];
      if (!network || !disk) throw new Error('The old-helper fixture must keep both device rows');
      expect(Object.hasOwn(network, 'historyId')).toBe(false);
      expect(Object.hasOwn(disk, 'historyId')).toBe(false);
    }
  });

  it('selects valid identities but never raw boot, MAC, serial or kernel metadata', () => {
    const old = sample();
    const boot = 'c5d77e28-2dcb-4c88-a4be-137f8e301f2a';
    const mac = 'de:ad:be:ef:12:34';
    const serial = 'private-disk-serial-A';
    const result = parseHostTelemetry(
      JSON.parse(
        JSON.stringify({
          ...old,
          bootId: boot,
          commands: ['private-helper-command'],
          filesystems: [{ ...old.filesystems[0], historyId: identity, source: 'private-source' }],
          network: [{ ...old.network[0], historyId: identity, bootId: boot, address: mac, ifindex: 2, privateNested: { mac } }],
          disks: [{ ...old.disks[0], historyId: diskIdentity, serial, diskseq: 4, bootId: boot, privateNested: { serial } }],
        }),
      ),
      now,
    );
    expect(result).toEqual({ ...old, network: [{ ...old.network[0], historyId: identity }], disks: [{ ...old.disks[0], historyId: diskIdentity }] });
    for (const value of [boot, mac, serial, 'private-helper-command', 'private-source']) expect(JSON.stringify(result)).not.toContain(value);
  });

  it('allows partial capability while retaining all current readings', () => {
    for (const section of ['network', 'disks'] as const) {
      const result = parseHostTelemetry(withIdentity(section, identity), now);
      expect(result).toEqual({ ...sample(), [section]: sample()[section].map((row) => ({ ...row, historyId: identity })) });
    }
  });

  it('treats an omitted JSON property as old-helper capability', () => {
    for (const section of ['network', 'disks'] as const) expect(parseHostTelemetry(withIdentity(section, undefined), now)).toEqual(sample());
  });

  describe.each(['network', 'disks'] as const)('%s identity validation', (section) => {
    it.each([identity, '0'.repeat(64), 'f'.repeat(64)])('preserves an exact lowercase64hex token %s', (token) => {
      const result = parseHostTelemetry(withIdentity(section, token), now);
      expect(result.available).toBe(true);
      if (result.available) expect(result[section][0]?.historyId).toBe(token);
    });

    it.each(malformed)('rejects $label without coercion', ({ value }) => {
      expect(() => parseHostTelemetry(withIdentity(section, value), now)).toThrow('Invalid host history identity');
    });
  });
});
