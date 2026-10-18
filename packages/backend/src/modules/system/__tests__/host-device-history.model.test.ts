import type { HostDisk, HostNetwork, HostTelemetry } from '@runtipi/common/schemas';
import { describe, expect, it } from 'vitest';
import {
  decodeHostHistory,
  encodeHostHistory,
  hostHistoryBucket,
  hostHistoryKey,
  hostHistoryPoint,
  hostHistorySample,
  hostHistoryTiers,
  mergeHostHistory,
  parseHostHistorySelection,
  type HostHistoryBucket,
  type HostHistorySample,
  type HostHistoryTier,
} from '../host-device-history.model';

const origin = Date.parse('2026-10-18T00:00:00.000Z');
const firstSource = 'a'.repeat(64);
const nextSource = 'b'.repeat(64);
const network = (overrides: Partial<HostNetwork> = {}): HostNetwork => ({
  interface: 'eth0',
  historyId: firstSource,
  state: 'up',
  speedMbps: 1000,
  receivedBytes: 5000,
  transmittedBytes: 2000,
  rxBytesPerSecond: 100,
  txBytesPerSecond: 20,
  ...overrides,
});
const disk = (overrides: Partial<HostDisk> = {}): HostDisk => ({
  device: 'nvme0n1',
  historyId: firstSource,
  readBytes: 5000,
  writtenBytes: 2000,
  readBytesPerSecond: 100,
  writeBytesPerSecond: 20,
  busyPercent: 40,
  inFlight: 1,
  ...overrides,
});
const reading = (at: number, interfaces: HostNetwork[] = [], disks: HostDisk[] = []): HostTelemetry => ({
  available: true,
  stale: false,
  sampledAt: new Date(at).toISOString(),
  filesystems: [],
  network: interfaces,
  disks,
  omitted: { filesystems: 0, network: 0, disks: 0 },
  unavailable: [],
});
const sample = (at: number, interfaces: HostNetwork[] = [], disks: HostDisk[] = []): HostHistorySample => {
  const result = hostHistorySample(reading(at, interfaces, disks), at);
  if (!result) throw new Error('Expected a current sample');
  return result;
};
const collect = (times: number[], values: (index: number) => { network?: HostNetwork[]; disks?: HostDisk[] }, seconds: HostHistoryTier = 60) => {
  let bucket: HostHistoryBucket | undefined;
  for (const [index, at] of times.entries()) {
    const value = values(index);
    const current = hostHistoryBucket(sample(at, value.network, value.disks), seconds);
    bucket = bucket ? mergeHostHistory(bucket, current) : current;
  }
  if (!bucket) throw new Error('Expected at least one sample');
  return bucket;
};
const onlyPoint = (bucket: HostHistoryBucket, key = 'network:eth0') => {
  const row = bucket.rows.get(key);
  if (!row) throw new Error(`Missing test row ${key}`);
  return hostHistoryPoint(row, bucket.seconds);
};
type RecordTuple = [number, number, number, number, number, number, number, unknown[][]];
const record = (): RecordTuple =>
  JSON.parse(
    encodeHostHistory(
      collect([origin + 2000, origin + 12000, origin + 22000], (index) => ({
        network: [network({ rxBytesPerSecond: [10, 40, 70][index] ?? 0, txBytesPerSecond: [null, 60, 90][index] ?? null })],
        disks: [disk({ busyPercent: [10, null, 90][index] ?? null })],
      })),
      4,
    ),
  );
const clone = <T>(value: T): T => structuredClone(value);

describe('measured host device history', () => {
  it('keeps directions independent and measures only available values', () => {
    const bucket = collect([origin + 2000, origin + 12000, origin + 22000], (index) => ({
      network: [network({ rxBytesPerSecond: [100, null, 700][index] ?? null, txBytesPerSecond: [null, 30, 90][index] ?? null })],
      disks: [
        disk({
          readBytesPerSecond: [300, 900, null][index] ?? null,
          writeBytesPerSecond: [10, null, null][index] ?? null,
          busyPercent: [0, null, 90][index] ?? null,
        }),
      ],
    }));
    expect(onlyPoint(bucket)).toMatchObject({
      at: new Date(origin + 2000).toISOString(),
      until: new Date(origin + 22000).toISOString(),
      intervalSeconds: 60,
      samples: 3,
      sourceId: firstSource,
      inbound: { average: 400, peak: 700, samples: 2 },
      outbound: { average: 60, peak: 90, samples: 2 },
      busy: { average: null, peak: null, samples: 0 },
    });
    expect(onlyPoint(bucket, 'disk:nvme0n1')).toMatchObject({
      inbound: { average: 600, peak: 900, samples: 2 },
      outbound: { average: 10, peak: 10, samples: 1 },
      busy: { average: 45, peak: 90, samples: 2 },
    });
  });
  it('weights unequal partial groups by actual readings rather than averaging their means', () => {
    const left = collect([origin + 2000, origin + 12000, origin + 22000], () => ({ network: [network({ rxBytesPerSecond: 10 })] }));
    const right = hostHistoryBucket(sample(origin + 42000, [network({ rxBytesPerSecond: 90 })]), 60);
    expect(onlyPoint(mergeHostHistory(left, right)).inbound).toEqual({ average: 30, peak: 90, samples: 4 });
    expect(onlyPoint(left).inbound).toEqual({ average: 10, peak: 10, samples: 3 });
    expect(onlyPoint(right).inbound).toEqual({ average: 90, peak: 90, samples: 1 });
  });
  it('retains finite large-rate means without unsafe intermediate totals', () => {
    const high = Number.MAX_SAFE_INTEGER;
    const bucket = collect([origin + 1000, origin + 11000, origin + 21000, origin + 31000], (index) => ({
      network: [network({ rxBytesPerSecond: index === 3 ? high - 400 : high })],
    }));
    expect(onlyPoint(bucket).inbound).toEqual({ average: high - 100, peak: high, samples: 4 });
    expect(Number.isSafeInteger(onlyPoint(bucket).inbound.average)).toBe(true);
  });
  it('does not turn missing counters into zero-rate readings', () => {
    const bucket = collect([origin + 1000, origin + 31000], () => ({ network: [network({ rxBytesPerSecond: null, txBytesPerSecond: null })] }));
    expect(onlyPoint(bucket)).toMatchObject({
      samples: 2,
      inbound: { average: null, peak: null, samples: 0 },
      outbound: { average: null, peak: null, samples: 0 },
    });
  });
  it('preserves device sample times when absent from earlier, intervening or later collections', () => {
    const bucket = collect([origin + 1000, origin + 11000, origin + 21000, origin + 41000, origin + 51000], (index) => ({
      network: index === 1 || index === 3 ? [network({ rxBytesPerSecond: index === 1 ? 20 : 80 })] : [],
    }));
    expect(bucket).toMatchObject({ firstAt: origin + 1000, lastAt: origin + 51000, samples: 5 });
    expect(onlyPoint(bucket)).toMatchObject({
      at: new Date(origin + 11000).toISOString(),
      until: new Date(origin + 41000).toISOString(),
      samples: 2,
      inbound: { average: 50, peak: 80, samples: 2 },
    });
  });
  it('hides an aggregate containing multiple generations even if the original generation returns', () => {
    const bucket = collect([origin + 2000, origin + 12000, origin + 22000], (index) => ({
      disks: [disk({ historyId: index === 1 ? nextSource : firstSource, readBytesPerSecond: 100 + index, busyPercent: 80 })],
    }));
    expect(onlyPoint(bucket, 'disk:nvme0n1')).toMatchObject({
      sourceId: null,
      samples: 3,
      inbound: { average: null, peak: null, samples: 0 },
      outbound: { average: null, peak: null, samples: 0 },
      busy: { average: null, peak: null, samples: 0 },
    });
  });
  it('retains distinguishable generations in separate aggregates', () => {
    const before = hostHistoryBucket(sample(origin + 2000, [network()]), 60);
    const after = hostHistoryBucket(sample(origin + 62000, [network({ historyId: nextSource })]), 60);
    expect(onlyPoint(before).sourceId).toBe(firstSource);
    expect(onlyPoint(after).sourceId).toBe(nextSource);
    expect(() => mergeHostHistory(before, after)).toThrow();
  });
  it.each(hostHistoryTiers)('uses half-open $seconds-second tier boundaries with actual timestamps', ({ seconds, retentionMs }) => {
    const boundary = origin + seconds * 1000;
    const before = hostHistoryBucket(sample(boundary - 1, [network()]), seconds);
    const after = hostHistoryBucket(sample(boundary, [network()]), seconds);
    expect(before.bucketAt).toBe(origin);
    expect(after.bucketAt).toBe(boundary);
    expect(before.firstAt).toBe(boundary - 1);
    expect(after.firstAt).toBe(boundary);
    expect(retentionMs / 1000).toBe({ 60: 3600, 300: 86400, 1800: 604800 }[seconds]);
    expect(() => mergeHostHistory(before, after)).toThrow();
  });
  it('rejects overlapping, duplicate, reverse-ordered and different-resolution merges', () => {
    const first = hostHistoryBucket(sample(origin + 1000, [network()]), 60);
    const next = hostHistoryBucket(sample(origin + 11000, [network()]), 60);
    const joined = mergeHostHistory(first, next);
    expect(() => mergeHostHistory(first, first)).toThrow();
    expect(() => mergeHostHistory(next, first)).toThrow();
    expect(() => mergeHostHistory(joined, next)).toThrow();
    expect(() => mergeHostHistory(first, hostHistoryBucket(sample(origin + 21000, [network()]), 300))).toThrow();
  });
  it('keeps the same logical name separate across device kinds', () => {
    const bucket = hostHistoryBucket(sample(origin, [network({ interface: 'shared' })], [disk({ device: 'shared' })]), 60);
    expect([...bucket.rows.keys()]).toEqual(['network:shared', 'disk:shared']);
    expect(onlyPoint(bucket, 'network:shared').busy.samples).toBe(0);
    expect(onlyPoint(bucket, 'disk:shared').busy.average).toBe(40);
  });
  it('rejects merging more than 64 distinct logical devices instead of returning an unbounded bucket', () => {
    const left = sample(
      origin + 1000,
      Array.from({ length: 32 }, (_, i) => network({ interface: `eth${i}` })),
      Array.from({ length: 32 }, (_, i) => disk({ device: `disk${i}` })),
    );
    const right = sample(origin + 11000, [network({ interface: 'replacement' })]);
    expect(() => mergeHostHistory(hostHistoryBucket(left, 60), hostHistoryBucket(right, 60))).toThrow();
  });
});

describe('history source and selection boundaries', () => {
  it('treats embedded colons as logical name content and accepts omitted selection', () => {
    expect(parseHostHistorySelection(undefined)).toBe(null);
    for (const selection of ['network:eth0:1', 'disk:dm-0', 'network:br0@if2', `network:${'x'.repeat(128)}`]) {
      const parsed = parseHostHistorySelection(selection);
      expect(parsed && hostHistoryKey(parsed)).toBe(selection);
    }
  });
  it.each([
    null,
    0,
    {},
    [],
    '',
    'network',
    ':eth0',
    'network:',
    'disk:.',
    'disk:..',
    'cpu:eth0',
    'Network:eth0',
    'disk:/dev/sda',
    'disk:../sda',
    'disk:a\\b',
    'network:eth 0',
    'network:eth\n0',
    'network:eth\u00000',
    'network:éth0',
    'network:%2fdev',
    `network:${'x'.repeat(129)}`,
  ])('rejects invalid or path-like selection %j', (value) => {
    expect(() => parseHostHistorySelection(value)).toThrow();
  });
  it('counts old helpers without inventing stable identities or retaining private host metadata', () => {
    expect(hostHistorySample(reading(origin, [network({ historyId: undefined })], [disk()]), origin)).toMatchObject({
      unidentified: 1,
      rows: [{ kind: 'disk', name: 'nvme0n1' }],
    });
    const withPrivateFields = { ...network(), hardwareSerial: 'PRIVATE-SERIAL', mac: '00:11:22:33:44:55', bootId: 'PRIVATE-BOOT' };
    expect(JSON.stringify(hostHistorySample(reading(origin, [withPrivateFields]), origin))).not.toMatch(
      /PRIVATE|00:11:22:33:44:55|speedMbps|receivedBytes|state/,
    );
  });
  it('skips unavailable, stale, invalid, old and implausibly future timestamps', () => {
    expect(hostHistorySample({ available: false, reason: 'offline' }, origin)).toBe(null);
    expect(hostHistorySample({ ...reading(origin), stale: true } as HostTelemetry, origin)).toBe(null);
    expect(hostHistorySample({ ...reading(origin), sampledAt: 'not a date' } as HostTelemetry, origin)).toBe(null);
    expect(hostHistorySample(reading(origin - 30001), origin)).toBe(null);
    expect(hostHistorySample(reading(origin + 5001), origin)).toBe(null);
    expect(hostHistorySample(reading(origin - 30000), origin)?.at).toBe(origin - 30000);
    expect(hostHistorySample(reading(origin + 5000), origin)?.at).toBe(origin + 5000);
  });
  it('bounds source lists and rejects duplicate names even when both lack history identities', () => {
    expect(() =>
      sample(
        origin,
        Array.from({ length: 33 }, (_, i) => network({ interface: `eth${i}` })),
      ),
    ).toThrow();
    expect(() =>
      sample(
        origin,
        [],
        Array.from({ length: 33 }, (_, i) => disk({ device: `disk${i}` })),
      ),
    ).toThrow();
    expect(() => sample(origin, [network(), network()])).toThrow();
    expect(() => sample(origin, [network({ historyId: undefined }), network({ historyId: undefined })])).toThrow();
    expect(
      sample(
        origin,
        Array.from({ length: 32 }, (_, i) => network({ interface: `eth${i}` })),
        Array.from({ length: 32 }, (_, i) => disk({ device: `disk${i}` })),
      ).rows,
    ).toHaveLength(64);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid measured rates %s', (value) => {
    expect(() => sample(origin, [network({ rxBytesPerSecond: value })])).toThrow();
    expect(() => sample(origin, [], [disk({ writeBytesPerSecond: value })])).toThrow();
  });
  it.each([-1, 100.01, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid busy percentages %s', (value) => {
    expect(() => sample(origin, [], [disk({ busyPercent: value })])).toThrow();
  });
  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'G'.repeat(64), 'A'.repeat(64), '00:11:22:33:44:55', '/sys/block/sda'])(
    'rejects malformed opaque source identity %j',
    (historyId) => {
      expect(() => sample(origin, [network({ historyId })])).toThrow();
    },
  );
});

describe('private journal device history codec', () => {
  it.each(hostHistoryTiers)('roundtrips $seconds-second measured aggregates with selected metadata only', ({ seconds }) => {
    const bucket = collect(
      [origin + 2000, origin + 12000, origin + 22000],
      (index) => ({
        network: [network({ interface: 'eth0:1', rxBytesPerSecond: index === 1 ? null : 10 + index })],
        disks: [disk({ busyPercent: index === 0 ? null : index * 20 })],
      }),
      seconds,
    );
    const withPrivateFields = { ...bucket, privateToken: 'PRIVATE-TOKEN' };
    const serialized = encodeHostHistory(withPrivateFields, 7);
    const decoded = decodeHostHistory(JSON.parse(serialized), origin + 30000);
    expect(decoded.evictedDevices).toBe(7);
    expect(encodeHostHistory(decoded.bucket, decoded.evictedDevices)).toBe(serialized);
    expect(onlyPoint(decoded.bucket, 'network:eth0:1')).toEqual(onlyPoint(bucket, 'network:eth0:1'));
    expect(serialized).not.toMatch(/PRIVATE|filesystems|receivedBytes|hardwareSerial|bootId|mac/);
  });
  it('roundtrips mixed-generation aggregates without reviving unavailable values', () => {
    const bucket = collect([origin + 2000, origin + 12000], (index) => ({ network: [network({ historyId: index ? nextSource : firstSource })] }));
    expect(onlyPoint(decodeHostHistory(JSON.parse(encodeHostHistory(bucket, 0)), origin + 30000).bucket)).toMatchObject({
      sourceId: null,
      samples: 2,
      inbound: { average: null, peak: null, samples: 0 },
    });
  });
  it('roundtrips empty collection without fabricating rows', () => {
    const result = decodeHostHistory(JSON.parse(encodeHostHistory(hostHistoryBucket(sample(origin + 1000), 60), 0)), origin + 30000);
    expect(result.bucket.rows.size).toBe(0);
    expect(result.bucket.samples).toBe(1);
  });
  it('rejects malformed tuple lengths, unsupported versions and excessive rows', () => {
    const valid = record();
    for (const bad of [null, {}, [], valid.slice(0, 7), [...valid, 'PRIVATE'], [2, ...valid.slice(1)]])
      expect(() => decodeHostHistory(bad, origin + 30000)).toThrow();
    const shortRow = clone(valid);
    shortRow[7][0]?.pop();
    const privateRow = clone(valid);
    privateRow[7][0]?.push('PRIVATE');
    const tooMany = clone(valid);
    tooMany[7] = Array.from({ length: 65 }, (_, i) => [0, `eth${i}`, firstSource, origin + 2000, origin + 22000, 3, 40, 70, 3, 75, 90, 2, 0, 0, 0]);
    for (const bad of [shortRow, privateRow, tooMany]) expect(() => decodeHostHistory(bad, origin + 30000)).toThrow();
  });
  it('rejects invalid resolution, unaligned or inverted bounds and unsafe count metadata', () => {
    const mutations: ((value: RecordTuple) => void)[] = [
      (v) => {
        v[1] = 10;
      },
      (v) => {
        v[2] += 1;
      },
      (v) => {
        v[3] = v[2] - 1;
      },
      (v) => {
        v[3] = v[2] + 60000;
      },
      (v) => {
        v[4] = v[3] - 1;
      },
      (v) => {
        v[4] = v[2] + 60000;
      },
      (v) => {
        v[5] = 0;
      },
      (v) => {
        v[5] = 32;
      },
      (v) => {
        v[5] = 1.5;
      },
      (v) => {
        v[6] = -1;
      },
      (v) => {
        v[6] = Number.MAX_SAFE_INTEGER + 1;
      },
      (v) => {
        v[3] = Number.POSITIVE_INFINITY;
      },
    ];
    for (const mutate of mutations) {
      const bad = record();
      mutate(bad);
      expect(() => decodeHostHistory(bad, origin + 30000)).toThrow();
    }
    expect(() => decodeHostHistory(record(), origin - 300001)).toThrow();
  });
  it('rejects multiple total samples measured at a single instant', () => {
    const value = record();
    value[4] = value[3];
    value[7] = [];
    expect(() => decodeHostHistory(value, origin + 30000)).toThrow();
  });
  it('rejects multiple device samples measured at a single instant', () => {
    const value = record();
    const row = value[7][0];
    if (row) row[4] = row[3];
    expect(() => decodeHostHistory(value, origin + 30000)).toThrow();
  });
  it('rejects one total sample spanning two distinct collection instants', () => {
    const value = record();
    value[5] = 1;
    value[7] = [];
    expect(() => decodeHostHistory(value, origin + 30000)).toThrow();
  });
  it('rejects one device sample spanning two distinct collection instants', () => {
    const value = record();
    const row = value[7][0];
    if (!row) throw new Error('Missing fixture row');
    row[5] = 1;
    for (const offset of [6, 9, 12]) {
      row[offset] = 0;
      row[offset + 1] = 0;
      row[offset + 2] = 0;
    }
    expect(() => decodeHostHistory(value, origin + 30000)).toThrow();
  });
  it('rejects counts exceeding the conservative minimum two-second collection span', () => {
    const value = record();
    value[4] = value[3] + 3999;
    value[7] = [];
    expect(() => decodeHostHistory(value, origin + 30000)).toThrow();
  });
  it('rejects malformed, duplicate and out-of-bucket identities', () => {
    const mutations: ((row: unknown[]) => void)[] = [
      (r) => {
        r[0] = 2;
      },
      (r) => {
        r[1] = '../private';
      },
      (r) => {
        r[1] = 'eth\n0';
      },
      (r) => {
        r[1] = 'x'.repeat(129);
      },
      (r) => {
        r[2] = 'private-serial';
      },
      (r) => {
        r[3] = origin + 1999;
      },
      (r) => {
        r[4] = origin + 22001;
      },
      (r) => {
        r[4] = origin + 1000;
      },
      (r) => {
        r[5] = 0;
      },
      (r) => {
        r[5] = 4;
      },
    ];
    for (const mutate of mutations) {
      const bad = record();
      const row = bad[7][0];
      if (!row) throw new Error('Missing fixture row');
      mutate(row);
      expect(() => decodeHostHistory(bad, origin + 30000)).toThrow();
    }
    const duplicate = record();
    const row = duplicate[7][0];
    if (!row) throw new Error('Missing fixture row');
    duplicate[7].push(clone(row));
    expect(() => decodeHostHistory(duplicate, origin + 30000)).toThrow();
  });
  it('rejects averages below the minimum implied by a nonnegative peak and reading count', () => {
    const value = record();
    const row = value[7].find((entry) => entry[0] === 0);
    if (!row) throw new Error('Missing fixture row');
    row[6] = 1;
    expect(() => decodeHostHistory(value, origin + 30000)).toThrow();
    row[6] = 70 / 3;
    expect(() => decodeHostHistory(value, origin + 30000)).not.toThrow();
  });
  it('rejects impossible aggregates and source-incompatible values', () => {
    const mutations: ((row: unknown[]) => void)[] = [
      (r) => {
        r[6] = -1;
      },
      (r) => {
        r[7] = Number.POSITIVE_INFINITY;
      },
      (r) => {
        r[8] = -1;
      },
      (r) => {
        r[8] = 1.5;
      },
      (r) => {
        r[8] = 4;
      },
      (r) => {
        r[6] = 71;
        r[7] = 70;
      },
      (r) => {
        r[8] = 0;
      },
      (r) => {
        r[8] = 1;
      },
      (r) => {
        r[2] = null;
      },
      (r) => {
        r[12] = 1;
        r[13] = 1;
        r[14] = 1;
      },
    ];
    for (const mutate of mutations) {
      const bad = record();
      const row = bad[7].find((entry) => entry[0] === 0);
      if (!row) throw new Error('Missing fixture row');
      mutate(row);
      expect(() => decodeHostHistory(bad, origin + 30000)).toThrow();
    }
    const busy = record();
    const row = busy[7].find((entry) => entry[0] === 1);
    if (!row) throw new Error('Missing disk fixture');
    row[13] = 101;
    expect(() => decodeHostHistory(busy, origin + 30000)).toThrow();
  });
});
