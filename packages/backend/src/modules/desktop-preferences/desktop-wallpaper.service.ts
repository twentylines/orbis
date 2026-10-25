import { ConfigurationService } from '@/core/config/configuration.service';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { imageDimensionsFromData } from 'image-dimensions';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { DesktopPreferencesService } from './desktop-preferences.service';

export const WALLPAPER_LIMIT = 32 * 1024 * 1024;
const TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

function metadata(data: Buffer, hash = createHash('sha256').update(data).digest('hex')) {
  let size: ReturnType<typeof imageDimensionsFromData>;
  try {
    size = imageDimensionsFromData(data);
  } catch {
    throw new BadRequestException('Choose a readable PNG, JPEG or WebP image.');
  }
  if (!data.length || data.length > WALLPAPER_LIMIT || !size || !(size.type in TYPES)) {
    throw new BadRequestException('Choose a PNG, JPEG or WebP image up to 32 MB.');
  }
  if (![size.width, size.height].every((value) => Number.isInteger(value) && value > 0 && value <= 16384) || size.width * size.height > 64_000_000) {
    throw new BadRequestException('Use an image up to 64 megapixels, with neither side larger than 16,384 pixels.');
  }
  return {
    hash,
    width: size.width,
    height: size.height,
    mime: TYPES[size.type as keyof typeof TYPES],
  };
}

@Injectable()
export class DesktopWallpaperService {
  private readonly operations = new Map<number, Promise<unknown>>();

  constructor(
    private readonly config: ConfigurationService,
    private readonly preferences: DesktopPreferencesService,
  ) {}

  private async file(userId: number, create = false) {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new BadRequestException('Invalid account.');
    const base = path.resolve(this.config.get('directories').dataDir);
    const state = path.join(base, 'state');
    const directory = path.join(state, 'wallpapers');
    for (const folder of [state, directory]) {
      if (create)
        await fs.mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const details = await fs.lstat(folder);
      if (
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        (folder === directory ? details.uid !== process.getuid?.() || details.mode & 0o077 : details.mode & 0o002)
      ) {
        throw new BadRequestException('Wallpaper storage needs a permissions review.');
      }
    }
    return path.join(directory, `${userId}.image`);
  }

  private async readFile(file: string) {
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ELOOP') throw new BadRequestException('Stored wallpaper needs a permissions review.');
      throw error;
    });
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.nlink !== 1 || details.uid !== process.getuid?.() || details.mode & 0o077 || details.size > WALLPAPER_LIMIT) {
        throw new BadRequestException('Stored wallpaper needs a permissions review.');
      }
      const data = Buffer.alloc(details.size + 1);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== details.size) throw new BadRequestException('Wallpaper changed while it was being read. Try again.');
      return data.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  private async existing(file: string) {
    try {
      return await this.readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async read(userId: number, version?: string) {
    if (version !== undefined && !/^[a-f0-9]{64}$/.test(version)) throw new NotFoundException('Wallpaper not found.');
    try {
      const file = await this.file(userId);
      for (const candidate of [file, `${file}.saved`]) {
        const data = await this.existing(candidate);
        if (!data) continue;
        const hash = createHash('sha256').update(data).digest('hex');
        if (version !== undefined && version !== hash) continue;
        return { ...metadata(data, hash), data };
      }
      throw new NotFoundException('Wallpaper not found.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException('Wallpaper not found.');
      throw error;
    }
  }

  async info(userId: number) {
    try {
      const { data: _data, ...info } = await this.read(userId);
      return { available: true, ...info };
    } catch (error) {
      if (error instanceof NotFoundException) return { available: false };
      throw error;
    }
  }

  private async serial<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    const pending = (this.operations.get(userId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.operations.set(userId, pending);
    try {
      return await pending;
    } finally {
      if (this.operations.get(userId) === pending) this.operations.delete(userId);
    }
  }

  upload(userId: number, data: Buffer) {
    const info = metadata(data);
    return this.serial(userId, async () => {
      const file = await this.file(userId, true);
      const previous = await this.existing(file);
      await this.existing(`${file}.saved`);
      const selected = (await this.preferences.read(userId)).appearance?.wallpaperImage;
      // Retain the selected image if navigation interrupts upload before preferences save.
      if (previous && (!selected || createHash('sha256').update(previous).digest('hex') === selected)) {
        await this.replace(`${file}.saved`, previous);
      }
      await this.replace(file, data);
      return info;
    });
  }

  private async replace(file: string, data: Buffer) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  remove(userId: number) {
    return this.serial(userId, async () => {
      try {
        const file = await this.file(userId);
        const current = await this.existing(file);
        const saved = await this.existing(`${file}.saved`);
        if (current) await fs.unlink(file);
        if (saved) await fs.unlink(`${file}.saved`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return { removed: true };
    });
  }
}
