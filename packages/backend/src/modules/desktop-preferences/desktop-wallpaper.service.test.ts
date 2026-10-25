import { BadRequestException, NotFoundException } from '@nestjs/common';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { DesktopPreferencesService } from './desktop-preferences.service';
import { DesktopWallpaperService, WALLPAPER_LIMIT } from './desktop-wallpaper.service';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64');
describe('bounded original wallpaper storage', () => {
  let directory: string;
  let service: DesktopWallpaperService;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wallpaper-storage-'));
    service = new DesktopWallpaperService(
      { get: () => ({ dataDir: directory }) } as unknown as ConfigurationService,
      { read: async () => ({}) } as unknown as DesktopPreferencesService,
    );
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  it('retains original bytes above the former 8 MB limit with private file permissions', async () => {
    const data = Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)]);
    const result = await service.upload(7, data);
    expect(WALLPAPER_LIMIT).toBe(32 * 1024 * 1024);
    expect((await service.read(7, result.hash)).data.equals(data)).toBe(true);
    expect((await fs.stat(path.join(directory, 'state/wallpapers/7.image'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(directory, 'state/wallpapers'))).mode & 0o777).toBe(0o700);
    await expect(service.read(8, result.hash)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('accepts a 64 MP header and rejects a larger header or file before replacing the image', async () => {
    const data = Buffer.from(png);
    data.writeUInt32BE(8000, 16);
    data.writeUInt32BE(8000, 20);
    const saved = await service.upload(7, data);
    data.writeUInt32BE(8001, 20);
    expect(() => service.upload(7, data)).toThrow(BadRequestException);
    expect(() => service.upload(7, Buffer.alloc(WALLPAPER_LIMIT + 1))).toThrow(BadRequestException);
    expect((await service.read(7, saved.hash)).height).toBe(8000);
  });
  it('reports unsafe storage and never makes an account image world-readable', async () => {
    await service.upload(7, png);
    await fs.chmod(path.join(directory, 'state/wallpapers'), 0o755);
    await expect(service.info(7)).rejects.toThrow('permissions review');
    await expect(service.upload(7, png)).rejects.toThrow('permissions review');
    expect((await fs.stat(path.join(directory, 'state/wallpapers/7.image'))).mode & 0o777).toBe(0o600);
  });
});
