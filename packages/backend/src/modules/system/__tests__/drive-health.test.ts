import type { DriveHealthSample } from '@runtipi/common/schemas/drive-health';
import { describe, expect, it, vi } from 'vitest';
import { DriveHealthService, parseDriveHealth } from '../drive-health.service';
import { readHostSocket } from '../host-socket';

vi.mock('../host-socket', () => ({ readHostSocket: vi.fn() }));

const drive = () => ({
  id: `drive:${'a'.repeat(24)}`,
  device: '/dev/sda',
  model: 'Storage drive',
  firmware: '1.0',
  protocol: 'ATA',
  capacityBytes: 2e12,
  health: 'passed',
  reasons: [],
  sampledAt: new Date().toISOString(),
  temperature: 39,
  powerOnHours: 6000,
  percentageUsed: null,
  availableSpare: null,
  spareThreshold: null,
  reallocatedSectors: 0,
  pendingSectors: 0,
  uncorrectableSectors: 0,
  mediaErrors: null,
  errorCount: 0,
  unsafeShutdowns: null,
  bytesRead: null,
  bytesWritten: null,
  selfTest: { supported: true, running: false, remainingPercent: null, shortMinutes: 2, extendedMinutes: 240 },
  tests: [],
  errors: [],
  attributes: [],
  history: [],
});
const sample = () => ({
  available: true,
  sampledAt: new Date().toISOString(),
  stale: false,
  limited: false,
  historyAvailable: true,
  drives: [drive()],
});

describe('physical drive health boundary', () => {
  it('shares active reads and refreshes immediately after invalidation', async () => {
    const first = parseDriveHealth(sample());
    const current = parseDriveHealth({ ...sample(), drives: [{ ...drive(), selfTest: { ...drive().selfTest, running: true } }] });
    const read = vi.mocked(readHostSocket).mockReset().mockResolvedValueOnce(first).mockResolvedValueOnce(current);
    const service = new DriveHealthService();
    const pending = service.read();
    expect(service.read()).toBe(pending);
    expect(await pending).toBe(first);
    expect(await service.read()).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    service.invalidate();
    expect(await service.read()).toBe(current);
    expect(await service.read()).toBe(current);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('prevents an old in-flight read from restoring invalidated readings', async () => {
    let finishOld!: (value: DriveHealthSample) => void;
    let finishCurrent!: (value: DriveHealthSample) => void;
    const first = parseDriveHealth(sample());
    const current = parseDriveHealth({ ...sample(), drives: [{ ...drive(), selfTest: { ...drive().selfTest, running: true } }] });
    const read = vi
      .mocked(readHostSocket)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCurrent = resolve;
          }),
      );
    const service = new DriveHealthService();
    const old = service.read();
    service.invalidate();
    const fresh = service.read();
    finishOld(first);
    await old;
    expect(service.read()).toBe(fresh);
    finishCurrent(current);
    expect(await fresh).toBe(current);
    expect(await service.read()).toBe(current);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('preserves measured zeros and unavailable values without claiming synthetic wear', () => {
    expect(parseDriveHealth(sample())).toMatchObject({ drives: [{ pendingSectors: 0, percentageUsed: null, mediaErrors: null, temperature: 39 }] });
  });
  it('returns explicit missing-host support rather than healthy empty data', () => {
    expect(parseDriveHealth({ available: false, reason: 'Install smartmontools on the host.' })).toMatchObject({ available: false });
  });
  it('rejects duplicate, oversized and invalid identities', () => {
    expect(() => parseDriveHealth({ ...sample(), drives: [drive(), drive()] })).toThrow();
    expect(() => parseDriveHealth({ ...sample(), drives: Array.from({ length: 33 }, drive) })).toThrow();
    expect(() => parseDriveHealth({ ...sample(), drives: [{ ...drive(), id: '/dev/private' }] })).toThrow();
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9'])('rejects invalid media counters %s', (mediaErrors) => {
    expect(() => parseDriveHealth({ ...sample(), drives: [{ ...drive(), mediaErrors }] })).toThrow();
  });
  it('does not accept invalid progress, text, flags or future samples', () => {
    for (const patch of [
      { selfTest: { ...drive().selfTest, remainingPercent: 101 } },
      { model: 'private\ncontrol' },
      { selfTest: { ...drive().selfTest, supported: 'yes' } },
      { sampledAt: '2099-01-01T00:00:00Z' },
    ])
      expect(() => parseDriveHealth({ ...sample(), drives: [{ ...drive(), ...patch }] })).toThrow();
  });
  it('marks old samples stale and strips unselected source fields', () => {
    const result = parseDriveHealth({ ...sample(), sampledAt: '2020-01-01T00:00:00Z', drives: [{ ...drive(), serial_number: 'not-for-response' }] });
    expect(result).toMatchObject({ stale: true });
    expect(JSON.stringify(result)).not.toContain('not-for-response');
  });
});
