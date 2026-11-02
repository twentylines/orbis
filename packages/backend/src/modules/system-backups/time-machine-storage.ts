import fs from 'node:fs/promises';
import path from 'node:path';
import { timeMachineLimits } from '@runtipi/common/schemas/time-machine';
import { timeMachineStorageSchema } from '@runtipi/common/schemas/time-machine-storage';
import { timeMachineConflict } from './time-machine-policy';
import type { StoredTimeMachinePoint } from './time-machine-store';

export async function readTimeMachineStorage(dataDirectory: string, points: () => Promise<StoredTimeMachinePoint[]>) {
  try {
    const filesystem = async () => {
      for (const directory of [path.join(dataDirectory, 'backups', 'time-machine'), path.join(dataDirectory, 'backups'), dataDirectory]) {
        try {
          return await fs.statfs(directory, { bigint: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || directory === dataDirectory) throw error;
        }
      }
      throw new Error('Filesystem status is unavailable');
    };
    const [space, saved] = await Promise.all([filesystem(), points()]);
    const { bsize, blocks, bfree, bavail } = space;
    if (bsize <= 0n || blocks <= 0n || bfree < 0n || bfree > blocks || bavail < 0n || bavail > bfree) throw new Error('Invalid filesystem status');
    const values = [blocks * bsize, (blocks - bfree) * bsize, bavail * bsize];
    const retained = saved.reduce(
      (total, point) => total + BigInt(point.archiveBytes) + BigInt(point.assetBytes ?? 0) + BigInt(point.version === 2 ? point.runtimeBytes : 0),
      0n,
    );
    if ([...values, retained].some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error('Filesystem status exceeds safe range');
    const [totalBytes, usedBytes, availableBytes] = values.map(Number);
    return timeMachineStorageSchema.assert({
      version: 1,
      totalBytes,
      usedBytes,
      availableBytes,
      retainedBytes: Number(retained),
      retainedLimitBytes: timeMachineLimits.bytes,
    });
  } catch {
    throw timeMachineConflict('storage-unavailable');
  }
}
