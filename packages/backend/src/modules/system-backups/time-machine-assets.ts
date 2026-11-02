import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { imageDimensionsFromData } from 'image-dimensions';
import { timeMachineAssetLimit, type TimeMachinePreview, type TimeMachineWallpaperAsset } from '@runtipi/common/schemas/time-machine';
import { APP_DIR } from '@/common/constants';
import type { LocalBackupSnapshot } from './system-backups.service';

export const timeMachineBuiltinPhotographs = {
  frost: 'frost-v2.webp',
  graphite: 'graphite-v2.webp',
  forest: 'forest-v3.webp',
  stone: 'stone-v2.webp',
  ocean: 'ocean-v3.webp',
  blush: 'blush-v3.webp',
} as const;
const legacy = { sandstone: 'stone', tidal: 'ocean', canopy: 'forest' } as const;
const mimes = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
export type CapturedWallpaper = Omit<TimeMachineWallpaperAsset, 'available' | 'cipherSha256'> & { data: Buffer };

export function capturedWallpaper(data: Buffer, source: CapturedWallpaper['source'], expected?: string): CapturedWallpaper {
  const size = imageDimensionsFromData(data);
  const identity = createHash('sha256').update(data).digest('hex');
  if (
    !data.length ||
    data.length > timeMachineAssetLimit ||
    !size ||
    !(size.type in mimes) ||
    ![size.width, size.height].every((value) => Number.isInteger(value) && value > 0 && value <= 16_384) ||
    size.width * size.height > 64_000_000 ||
    (expected !== undefined && identity !== expected)
  )
    throw new Error('Historical wallpaper is unavailable.');
  return { data, identity, bytes: data.length, width: size.width, height: size.height, mime: mimes[size.type as keyof typeof mimes], source };
}
async function readWallpaper(file: string) {
  if ((await fs.realpath(path.dirname(file))) !== path.resolve(path.dirname(file))) throw new Error('Unsafe historical wallpaper.');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > timeMachineAssetLimit) throw new Error('Unsafe historical wallpaper.');
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.length !== stat.size || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs)
      throw new Error('Historical wallpaper changed.');
    return data;
  } finally {
    await handle.close();
  }
}

export async function snapshotWallpaper(
  snapshot: LocalBackupSnapshot,
  preview: TimeMachinePreview,
  ownerId: number,
  bundledRoots = process.env.NODE_ENV === 'production'
    ? [path.join(APP_DIR, 'assets', 'frontend', 'wallpapers')]
    : [path.resolve('packages/frontend/public/wallpapers'), path.resolve('../frontend/public/wallpapers')],
): Promise<CapturedWallpaper | null> {
  if (!preview.available) return null;
  const { desktop, theme } = preview;
  try {
    if (desktop.wallpaperMode === 'custom' && desktop.appearance.wallpaperImage) {
      for (const suffix of ['', '.saved']) {
        const name = `data/state/wallpapers/${ownerId}.image${suffix}`;
        if (!snapshot.files.some((file) => file.name === name)) continue;
        try {
          return capturedWallpaper(await readWallpaper(path.join(snapshot.content, name)), 'captured-custom', desktop.appearance.wallpaperImage);
        } catch {
          /* A saved generation may be the one referenced by captured preferences. */
        }
      }
      return null;
    }
    if (desktop.wallpaperMode === 'theme' && theme) {
      const name = `data/state/theme-packs/${ownerId}/${theme.id}/${theme.version}/${theme.wallpaper}`;
      if (!snapshot.files.some((file) => file.name === name)) return null;
      const image = capturedWallpaper(await readWallpaper(path.join(snapshot.content, name)), 'captured-theme', theme.wallpaper);
      const asset = theme.assets[0];
      return asset && image.mime === asset.mime && image.bytes === asset.bytes && image.width === asset.width && image.height === asset.height
        ? image
        : null;
    }
    const preset = desktop.wallpaperMode === 'theme' ? desktop.preset : (desktop.wallpaperPreset ?? legacy[desktop.wallpaper]);
    for (const root of bundledRoots) {
      try {
        return capturedWallpaper(await readWallpaper(path.join(root, timeMachineBuiltinPhotographs[preset])), 'captured-builtin');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
