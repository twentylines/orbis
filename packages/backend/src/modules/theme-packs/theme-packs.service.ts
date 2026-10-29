import { ConfigurationService } from '@/core/config/configuration.service';
import { APP_DIR } from '@/common/constants';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { imageDimensionsFromData } from 'image-dimensions';
import {
  themePackIdSchema,
  themePackVersionSchema,
  themePackStateSchema,
  type ThemePackManifest,
  type ThemePackState,
} from '@runtipi/common/schemas/theme-pack';
import { bundledThemePacks } from './theme-pack-catalogue';

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const digest = (manifest: ThemePackManifest) => hash(JSON.stringify(manifest));
const emptyState = (): ThemePackState => ({ formatVersion: 1, installed: [], selected: null });
const sameVersion = (first: { id: string; version: string }, second: { id: string; version: string }) =>
  first.id === second.id && first.version === second.version;

export function validateThemeAsset(manifest: ThemePackManifest, data: Buffer) {
  const asset = manifest.assets[0];
  let dimensions: ReturnType<typeof imageDimensionsFromData>;
  try {
    dimensions = imageDimensionsFromData(data);
  } catch {
    dimensions = undefined;
  }
  if (
    !asset ||
    data.length !== asset.bytes ||
    data.length > 4_194_304 ||
    hash(data) !== asset.sha256 ||
    dimensions?.type !== 'webp' ||
    dimensions.width !== asset.width ||
    dimensions.height !== asset.height
  ) {
    throw new BadRequestException('Theme photograph did not pass integrity checks.');
  }
  return asset;
}

@Injectable()
export class ThemePacksService {
  private readonly operations = new Map<number, Promise<unknown>>();
  constructor(private readonly config: ConfigurationService) {}

  private async directory(userId: number, segments: string[] = [], create = false) {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new BadRequestException('Invalid account.');
    const base = path.resolve(this.config.get('directories').dataDir);
    let folder = base;
    for (const [index, segment] of ['state', 'theme-packs', String(userId), ...segments].entries()) {
      folder = path.join(folder, segment);
      if (create)
        await fs.mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const details = await fs.lstat(folder);
      if (
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        (index === 0 ? details.mode & 0o002 : details.mode & 0o077) ||
        (index > 0 && details.uid !== process.getuid?.())
      )
        throw new BadRequestException('Theme storage needs a permissions review.');
    }
    return folder;
  }

  private async readPrivate(file: string, limit: number, bundled = false) {
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const details = await handle.stat();
      if (
        !details.isFile() ||
        details.nlink !== 1 ||
        (!bundled && (details.mode & 0o077 || details.uid !== process.getuid?.())) ||
        details.size > limit
      )
        throw new BadRequestException('Theme storage needs a permissions review.');
      const data = Buffer.alloc(details.size + 1);
      let offset = 0;
      while (offset < data.length) {
        const result = await handle.read(data, offset, data.length - offset, null);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset !== details.size) throw new BadRequestException('Theme storage changed. Refresh and try again.');
      return data.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  private async read(userId: number): Promise<ThemePackState> {
    try {
      const folder = await this.directory(userId);
      const parsed = themePackStateSchema.assert(JSON.parse((await this.readPrivate(path.join(folder, 'registry.json'), 131_072)).toString()));
      for (const record of parsed.installed.flatMap((item) => [item, ...(item.previous ? [item.previous] : [])])) {
        if (
          record.digest !== digest(record.manifest) ||
          !bundledThemePacks.some((pack) => sameVersion(pack, record.manifest) && digest(pack) === record.digest)
        )
          throw new BadRequestException('Saved theme version did not pass integrity checks.');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Saved themes could not be validated.');
    }
  }

  private async write(userId: number, state: ThemePackState) {
    themePackStateSchema.assert(state);
    const folder = await this.directory(userId, [], true);
    const temporary = path.join(folder, `.registry-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, path.join(folder, 'registry.json'));
    } finally {
      await fs.rm(temporary, { force: true });
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

  async snapshot(userId: number) {
    return { catalogue: bundledThemePacks, state: await this.read(userId) };
  }

  private manifest(id: string, version?: string) {
    if (!themePackIdSchema.allows(id) || (version !== undefined && !themePackVersionSchema.allows(version)))
      throw new BadRequestException('Invalid theme version.');
    const pack = bundledThemePacks.filter((item) => item.id === id && (version === undefined || item.version === version)).at(-1);
    if (!pack) throw new NotFoundException('This theme version is unavailable.');
    return pack;
  }

  private async bundledAsset(manifest: ThemePackManifest) {
    const asset = manifest.assets[0];
    if (!asset) throw new BadRequestException('Theme photograph is missing.');
    const roots =
      process.env.NODE_ENV === 'production'
        ? [path.join(APP_DIR, 'assets', 'frontend', 'wallpapers')]
        : [path.resolve('packages/frontend/public/wallpapers'), path.resolve('../frontend/public/wallpapers')];
    for (const root of roots) {
      try {
        const file = path.join(root, asset.path);
        const data = await this.readPrivate(file, asset.bytes, true);
        validateThemeAsset(manifest, data);
        return data;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new NotFoundException('Bundled theme photograph is unavailable.');
  }

  private async stage(userId: number, manifest: ThemePackManifest) {
    const data = await this.bundledAsset(manifest);
    const folder = await this.directory(userId, [manifest.id], true);
    const temporaryName = `.install-${randomUUID()}`;
    const temporary = await this.directory(userId, [manifest.id, temporaryName], true);
    const target = path.join(folder, manifest.version);
    try {
      const image = await fs.open(path.join(temporary, manifest.wallpaper), 'wx', 0o600);
      try {
        await image.writeFile(data);
        await image.sync();
      } finally {
        await image.close();
      }
      validateThemeAsset(manifest, await this.readPrivate(path.join(temporary, manifest.wallpaper), 4_194_304));
      try {
        await this.directory(userId, [manifest.id, manifest.version]);
        validateThemeAsset(manifest, await this.readPrivate(path.join(target, manifest.wallpaper), 4_194_304));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.rename(temporary, target);
      }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  install(userId: number, id: string, version?: string, update = false) {
    const manifest = this.manifest(id, version);
    return this.serial(userId, async () => {
      const state = await this.read(userId);
      const old = state.installed.find((item) => item.manifest.id === id);
      if (update && !old) throw new NotFoundException('Install this theme first.');
      if (old && sameVersion(old.manifest, manifest)) return this.snapshot(userId);
      if (!old && state.installed.length >= 12) throw new BadRequestException('Remove a theme before installing another.');
      await this.stage(userId, manifest);
      const now = new Date().toISOString();
      const record = {
        manifest,
        digest: digest(manifest),
        installedAt: old?.installedAt ?? now,
        updatedAt: now,
        previous: old ? { manifest: old.manifest, digest: old.digest } : null,
      };
      state.installed = [...state.installed.filter((item) => item.manifest.id !== id), record];
      if (state.selected?.id === id) state.selected = { id, version: manifest.version };
      await this.write(userId, state);
      if (old?.previous && old.previous.manifest.version !== manifest.version) {
        const obsolete = await this.directory(userId, [id, old.previous.manifest.version]);
        await fs.rm(obsolete, { recursive: true });
      }
      return this.snapshot(userId);
    });
  }

  select(userId: number, reference: { id: string; version: string } | null) {
    return this.serial(userId, async () => {
      const state = await this.read(userId);
      if (reference) {
        const installed = state.installed.find((item) => sameVersion(item.manifest, reference));
        if (!installed) throw new NotFoundException('Install this theme version before applying it.');
        await this.asset(userId, reference.id, reference.version, installed.manifest.wallpaper);
      }
      state.selected = reference;
      await this.write(userId, state);
      return this.snapshot(userId);
    });
  }

  rollback(userId: number, id: string) {
    this.manifest(id);
    return this.serial(userId, async () => {
      const state = await this.read(userId);
      const record = state.installed.find((item) => item.manifest.id === id);
      if (!record?.previous) throw new BadRequestException('No earlier installed version is available.');
      const previous = record.previous;
      const folder = await this.directory(userId, [id, previous.manifest.version]);
      validateThemeAsset(previous.manifest, await this.readPrivate(path.join(folder, previous.manifest.wallpaper), 4_194_304));
      record.previous = { manifest: record.manifest, digest: record.digest };
      record.manifest = previous.manifest;
      record.digest = previous.digest;
      record.updatedAt = new Date().toISOString();
      if (state.selected?.id === id) state.selected.version = record.manifest.version;
      await this.write(userId, state);
      return this.snapshot(userId);
    });
  }

  remove(userId: number, id: string) {
    this.manifest(id);
    return this.serial(userId, async () => {
      const state = await this.read(userId);
      const installed = state.installed.find((item) => item.manifest.id === id);
      if (!installed) throw new NotFoundException('This theme is not installed.');
      state.installed = state.installed.filter((item) => item.manifest.id !== id);
      if (state.selected?.id === id) state.selected = null;
      // Persist the built-in fallback before removing any bytes used by this account.
      await this.write(userId, state);
      const folder = await this.directory(userId, [id]);
      await fs.rm(folder, { recursive: true });
      return this.snapshot(userId);
    });
  }

  async asset(userId: number, id: string, version: string, sha256: string) {
    this.manifest(id, version);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new NotFoundException('Theme photograph not found.');
    const state = await this.read(userId);
    const record = state.installed.find((item) => sameVersion(item.manifest, { id, version }));
    if (!record || record.manifest.wallpaper !== sha256) throw new NotFoundException('Theme photograph not found.');
    const folder = await this.directory(userId, [id, version]);
    const data = await this.readPrivate(path.join(folder, sha256), 4_194_304);
    validateThemeAsset(record.manifest, data);
    return { data, hash: sha256, mime: 'image/webp' };
  }
}
