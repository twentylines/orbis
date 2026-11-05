import fs from 'node:fs/promises';
import path from 'node:path';
import { ConflictException } from '@nestjs/common';
import type { Request } from 'express';
import type { TimeMachineService } from '../system-backups/time-machine.service';
import { exportCapsule, type CapsuleSource } from './capsule';

type Credentials = { password: string; totpCode?: string };

export async function exportPortablePoint(options: {
  machine: Pick<TimeMachineService, 'withPortablePoint'>;
  dataDir: string;
  pointId: string;
  ownerId: number;
  request: Request;
  credentials: Credentials;
  passphrase: string;
  destination: string;
  signal: AbortSignal;
  progress?: (complete: number, total: number) => void;
  admitBytes?: (bytes: number) => void | Promise<void>;
}) {
  const { machine, dataDir, pointId, ownerId, request, credentials, passphrase, destination, signal, progress, admitBytes } = options;
  return machine.withPortablePoint(pointId, ownerId, request, credentials, signal, async (value) => {
    if (value.point.version !== 2 || !value.point.archiveSha256 || !value.point.runtimeCipherSha256 || !value.point.metadataSha256)
      throw new ConflictException('The capture archive could not be prepared or verified. Existing server data was preserved.');
    const dir = path.join(dataDir, 'backups', 'time-machine', 'points', pointId);
    const metadataStat = await fs.lstat(path.join(dir, 'metadata.orbis'));
    const entries: CapsuleSource[] = [
      { name: 'backup.orbis', bytes: value.point.archiveBytes, sha256: value.point.archiveSha256, source: value.source },
      { name: 'runtime.orbis', bytes: value.point.runtimeBytes, sha256: value.point.runtimeCipherSha256, file: path.join(dir, 'runtime.orbis') },
      { name: 'metadata.orbis', bytes: metadataStat.size, sha256: value.point.metadataSha256, file: path.join(dir, 'metadata.orbis') },
    ];
    const preview = value.metadata.preview;
    if (preview.available && preview.wallpaperAsset.available)
      entries.push({
        name: 'wallpaper.orbis',
        bytes: preview.wallpaperAsset.bytes + 52,
        sha256: preview.wallpaperAsset.cipherSha256,
        file: path.join(dir, 'wallpaper.orbis'),
      });
    if (preview.available && preview.appIcons)
      entries.push({
        name: 'icons.orbis',
        bytes: preview.appIcons.bytes + 52,
        sha256: preview.appIcons.cipherSha256,
        file: path.join(dir, 'icons.orbis'),
      });
    await admitBytes?.(entries.reduce((sum, item) => sum + item.bytes, 0));
    const result = await exportCapsule({
      destination,
      pointId,
      createdAt: value.point.createdAt,
      pointKey: value.pointKey,
      entries,
      passphrase,
      signal: value.signal,
      progress,
    });
    return {
      bytes: result.bytes,
      sha256: result.sha256,
      capsuleId: result.capsuleId,
      pointId,
      capturedAt: value.point.createdAt,
      orbisVersion: value.metadata.software.orbis,
    };
  });
}
