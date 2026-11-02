import fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { readTimeMachineStorage } from './time-machine-storage';
import { TimeMachineController } from './time-machine.controller';
import { timeMachineLimits } from '@runtipi/common/schemas/time-machine';

afterEach(() => vi.restoreAllMocks());

it('reports measured filesystem capacity separately from recorded retained bytes', async () => {
  vi.spyOn(fs, 'statfs').mockResolvedValue({ bsize: 4096n, blocks: 1000n, bfree: 300n, bavail: 250n } as never);
  const points = [
    { version: 2, archiveBytes: 100, runtimeBytes: 50, assetBytes: 20 },
    { version: 1, archiveBytes: 30 },
  ];
  expect(await readTimeMachineStorage('/data', async () => points as never)).toEqual({
    version: 1,
    totalBytes: 4_096_000,
    usedBytes: 2_867_200,
    availableBytes: 1_024_000,
    retainedBytes: 200,
    retainedLimitBytes: timeMachineLimits.bytes,
  });
});

it('refuses invalid, unsafe or unavailable filesystem and retained readings', async () => {
  const stat = vi.spyOn(fs, 'statfs');
  stat.mockResolvedValueOnce({ bsize: 1n, blocks: 1n, bfree: 1n, bavail: 2n } as never);
  await expect(readTimeMachineStorage('/data', async () => [])).rejects.toMatchObject({ response: { code: 'storage-unavailable' } });
  stat.mockResolvedValueOnce({ bsize: 4096n, blocks: BigInt(Number.MAX_SAFE_INTEGER), bfree: 0n, bavail: 0n } as never);
  await expect(readTimeMachineStorage('/data', async () => [])).rejects.toMatchObject({ response: { code: 'storage-unavailable' } });
  stat.mockRejectedValueOnce(new Error('unavailable'));
  await expect(readTimeMachineStorage('/data', async () => [])).rejects.toMatchObject({ response: { code: 'storage-unavailable' } });
});

it('reads a real filesystem without creating a Time Machine directory', async () => {
  const result = await readTimeMachineStorage(process.cwd(), async () => []);
  expect(result.totalBytes).toBeGreaterThan(0);
  expect(result.usedBytes + result.availableBytes).toBeLessThanOrEqual(result.totalBytes);
  expect(result.retainedBytes).toBe(0);
});

it('uses the nearest existing backup filesystem before the data root', async () => {
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const stat = vi.spyOn(fs, 'statfs');
  stat.mockRejectedValueOnce(missing).mockResolvedValueOnce({ bsize: 1n, blocks: 100n, bfree: 20n, bavail: 15n } as never);
  const result = await readTimeMachineStorage('/data', async () => []);
  expect(stat.mock.calls.map(([directory]) => directory)).toEqual(['/data/backups/time-machine', '/data/backups']);
  expect(result.availableBytes).toBe(15);
});

it('requires an operator session and forbids caching the response', () => {
  const storage = vi.fn();
  const controller = new TimeMachineController({ storage } as never);
  const response = { setHeader: vi.fn() } as unknown as Response;
  expect(() => controller.storage({ authMethod: 'session', user: { id: 1, operator: false } } as Request, response)).toThrow();
  expect(storage).not.toHaveBeenCalled();
  controller.storage({ authMethod: 'session', user: { id: 1, operator: true } } as Request, response);
  expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(storage).toHaveBeenCalledOnce();
});
