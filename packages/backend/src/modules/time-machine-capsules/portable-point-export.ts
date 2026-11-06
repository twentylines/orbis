import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConflictException } from '@nestjs/common';
import type { Request } from 'express';
import type { TimeMachineService } from '../system-backups/time-machine.service';
import { exportCapsule, capsuleLimits, type CapsuleSource } from './capsule';
import { capsuleDirectorySeal, sameCapsuleSeal } from './verified-source';

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
    if (
      ![2, 3].includes(value.point.version) ||
      !value.point.archiveSha256 ||
      !value.point.metadataSha256 ||
      (value.point.version === 2 && !value.point.runtimeCipherSha256)
    )
      throw new ConflictException('The capture archive could not be prepared or verified. Existing server data was preserved.');
    const dir = path.join(dataDir, 'backups', 'time-machine', 'points', pointId);
    const metadataStat = await fs.lstat(path.join(dir, 'metadata.orbis'));
    const entries: CapsuleSource[] = [
      {
        name: value.point.version === 3 ? 'core.orbis' : 'backup.orbis',
        bytes: value.point.archiveBytes,
        sha256: value.point.archiveSha256,
        source: value.source,
      },
    ];
    if (value.point.version === 2) {
      if (!value.point.runtimeCipherSha256) throw new ConflictException('The capture runtime could not be verified.');
      entries.push({
        name: 'runtime.orbis',
        bytes: value.point.runtimeBytes,
        sha256: value.point.runtimeCipherSha256,
        file: path.join(dir, 'runtime.orbis'),
      });
    }
    if (value.point.version === 3) {
      await capsuleDirectorySeal(dir);
      const file = path.join(dir, 'capture-draft.orbis');
      const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.mode & 0o077 ||
          before.uid !== process.getuid?.() ||
          before.size < 52 ||
          before.size > capsuleLimits.manifestBytes + 52
        )
          throw new ConflictException('The capture draft could not be verified.');
        const digest = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false, signal: value.signal })) digest.update(chunk);
        if (!sameCapsuleSeal(before, await handle.stat()) || !sameCapsuleSeal(before, await fs.lstat(file)))
          throw new ConflictException('The capture draft changed.');
        entries.push({ name: 'capture-draft.orbis', bytes: before.size, sha256: digest.digest('hex'), file });
      } finally {
        await handle.close();
      }
    }
    entries.push({ name: 'metadata.orbis', bytes: metadataStat.size, sha256: value.point.metadataSha256, file: path.join(dir, 'metadata.orbis') });
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
      ...(value.point.version === 3 ? { sourceOwnerId: ownerId } : {}),
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
