import { createHash } from 'node:crypto';
import { historicalIconLimits } from '@runtipi/common/schemas/time-machine-icons';
import type { TimeMachineMetadata } from '@runtipi/common/schemas/time-machine';
import { verifyAppIcons } from '../system-backups/time-machine-app-icons';
import { backupMetadataBytes } from '../system-backups/backup-crypto';
import type { CapsuleManifest } from './capsule';
import { readCapsuleEntry } from './verified-source';
const fail = () => new Error('The capsule preview did not pass verification.');
export async function verifyCapsulePreview(metadata: TimeMachineMetadata, manifest: CapsuleManifest, directory: string, signal: AbortSignal) {
  const asset = metadata.preview.available && metadata.preview.wallpaperAsset.available ? metadata.preview.wallpaperAsset : null;
  const wallpaper = manifest.entries.find((entry) => entry.name === 'wallpaper.orbis');
  if (
    Boolean(asset) !== Boolean(wallpaper) ||
    (asset && wallpaper && (wallpaper.bytes !== asset.bytes + 52 || wallpaper.sha256 !== asset.cipherSha256))
  )
    throw fail();
  if (asset && wallpaper) {
    const value = await backupMetadataBytes(
      await readCapsuleEntry(directory, wallpaper, signal, 32 * 1024 ** 2 + 52),
      manifest.pointKey,
      true,
      32 * 1024 ** 2,
    );
    try {
      if (value.length !== asset.bytes || createHash('sha256').update(value).digest('hex') !== asset.identity) throw fail();
    } finally {
      value.fill(0);
    }
  }
  const icons = metadata.preview.available ? metadata.preview.appIcons : undefined;
  const iconEntry = manifest.entries.find((entry) => entry.name === 'icons.orbis');
  if (
    Boolean(icons) !== Boolean(iconEntry) ||
    (icons && iconEntry && (icons.bytes + 52 !== iconEntry.bytes || icons.cipherSha256 !== iconEntry.sha256))
  )
    throw fail();
  if (icons && iconEntry) {
    const value = await backupMetadataBytes(
      await readCapsuleEntry(directory, iconEntry, signal, historicalIconLimits.bundleBytes + 52),
      manifest.pointKey,
      true,
      historicalIconLimits.bundleBytes,
    );
    try {
      verifyAppIcons(value, icons);
    } finally {
      value.fill(0);
    }
  }
}
