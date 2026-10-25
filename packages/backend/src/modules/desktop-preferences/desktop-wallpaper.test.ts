import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { type INestApplication, type NestMiddleware } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ArkValidationPipe } from 'nestjs-arktype';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AuthGuard } from '../auth/auth.guard';
import { DesktopPreferencesController } from './desktop-preferences.controller';
import { DEFAULT_DESKTOP_PREFERENCES, DesktopPreferencesService } from './desktop-preferences.service';
import { DesktopWallpaperService, WALLPAPER_LIMIT } from './desktop-wallpaper.service';

const images = {
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64'),
  jpeg: Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiKKKKk8s//9k=',
    'base64',
  ),
  webp: Buffer.from('UklGRi4AAABXRUJQVlA4ICIAAABQAQCdASoCAAIAAUAmJZAABAAAAP70GFf/jf81/oT9wAAA', 'base64'),
};

describe('private desktop wallpaper HTTP and storage', () => {
  let root: string;
  let app: INestApplication;
  let service: DesktopWallpaperService;
  let config: ConfigurationService;
  const upload = (data = images.png, user = 'owner') =>
    request(app.getHttpServer())
      .post('/desktop-preferences/wallpaper')
      .set('Authorization', user)
      .attach('image', data, { filename: '../../outside.html', contentType: 'text/html' });
  const get = (version: string, user = 'owner') =>
    request(app.getHttpServer()).get(`/desktop-preferences/wallpaper?version=${version}`).set('Authorization', user);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-wallpaper-'));
    config = { get: () => ({ dataDir: root }) } as unknown as ConfigurationService;
    const module = await Test.createTestingModule({
      controllers: [DesktopPreferencesController],
      providers: [
        AuthGuard,
        DesktopWallpaperService,
        DesktopPreferencesService,
        { provide: ConfigurationService, useValue: config },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();
    service = module.get(DesktopWallpaperService);
    app = module.createNestApplication({ logger: false });
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'owner' || req.headers.authorization === 'session') req.user = { id: 7 };
      if (req.headers.authorization === 'other') req.user = { id: 8 };
      if (req.headers.authorization === 'session') req.authMethod = 'session';
      next();
    }) as NestMiddleware['use']);
    app.useGlobalPipes(new ArkValidationPipe());
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('requires authentication and rejects cross-origin session writes before storing an image', async () => {
    for (const method of ['get', 'post', 'delete'] as const) await request(app.getHttpServer())[method]('/desktop-preferences/wallpaper').expect(401);
    await request(app.getHttpServer()).get('/desktop-preferences/wallpaper/info').expect(401);
    await upload(images.png, 'session').expect(403);
    await request(app.getHttpServer())
      .post('/desktop-preferences/wallpaper')
      .set('Authorization', 'session')
      .set('Host', 'orbis.test')
      .set('Origin', 'http://other.test')
      .attach('image', images.png)
      .expect(403);
    expect(await fs.readdir(root)).toEqual([]);
    await request(app.getHttpServer())
      .post('/desktop-preferences/wallpaper')
      .set('Authorization', 'session')
      .set('Host', 'orbis.test')
      .set('Origin', 'http://orbis.test')
      .attach('image', images.png, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);
  });

  it.each(Object.entries(images))('detects %s bytes independently of filename and MIME, returning private inline images', async (kind, data) => {
    const saved = await upload(data);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ width: 2, height: 2, mime: `image/${kind}`, hash: createHash('sha256').update(data).digest('hex') });
    const response = await get(saved.body.hash).expect(200);
    expect(response.headers['content-type']).toBe(`image/${kind}`);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe('inline; filename="wallpaper"');
    expect(response.body).toEqual(data);
    expect((await fs.stat(path.join(root, 'state/wallpapers/7.image'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(root, 'state/wallpapers'))).mode & 0o777).toBe(0o700);
    expect((await new DesktopWallpaperService(config, new DesktopPreferencesService(config)).read(7, saved.body.hash)).data).toEqual(data);
  });

  it('isolates accounts and old versions, and deletes only the signed-in user image', async () => {
    await request(app.getHttpServer()).get('/desktop-preferences/wallpaper/info').set('Authorization', 'owner').expect(200, { available: false });
    const first = (await upload().expect(201)).body.hash;
    await get(first, 'other').expect(404);
    const other = (await upload(images.webp, 'other').expect(201)).body.hash;
    const second = (await upload(images.jpeg).expect(201)).body.hash;
    expect((await get(first).expect(200)).body).toEqual(images.png);
    await get(other).expect(404);
    await get(second, 'other').expect(404);
    await get('../7.image').expect(404);
    await request(app.getHttpServer()).delete('/desktop-preferences/wallpaper').set('Authorization', 'owner').expect(200, { removed: true });
    await request(app.getHttpServer()).delete('/desktop-preferences/wallpaper').set('Authorization', 'owner').expect(200);
    await get(second).expect(404);
    await get(other, 'other').expect(200);
    expect(await fs.readdir(path.join(root, 'state/wallpapers'))).toEqual(['8.image']);
  });

  it('rejects unsupported, empty, truncated and oversized images without replacing a saved wallpaper', async () => {
    const hash = (await upload().expect(201)).body.hash;
    for (const data of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('<html>photo</html>'),
      Buffer.from('GIF89a123456789'),
      Buffer.alloc(0),
      images.png.subarray(0, 12),
    ])
      await upload(data).expect(400);
    await upload(Buffer.alloc(WALLPAPER_LIMIT + 1)).expect(413);
    await request(app.getHttpServer()).post('/desktop-preferences/wallpaper').set('Authorization', 'owner').expect(400);
    await get(hash).expect(200);
    expect(await fs.readdir(path.join(root, 'state/wallpapers'))).toEqual(['7.image']);
  });

  it('rejects excessive pixel counts and invalid or excessive side lengths', async () => {
    for (const [width, height] of [
      [10000, 6500],
      [16385, 1],
      [1, 16385],
      [0, 2],
    ] as const) {
      const data = Buffer.from(images.png);
      data.writeUInt32BE(width, 16);
      data.writeUInt32BE(height, 20);
      await upload(data).expect(400);
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('rejects extra files and fields without replacing the saved image', async () => {
    const hash = (await upload().expect(201)).body.hash;
    await request(app.getHttpServer())
      .post('/desktop-preferences/wallpaper')
      .set('Authorization', 'owner')
      .attach('image', images.jpeg, { filename: 'first.jpg' })
      .attach('image', images.webp, { filename: 'second.webp' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/desktop-preferences/wallpaper')
      .set('Authorization', 'owner')
      .field('userId', '8')
      .attach('image', images.jpeg, { filename: 'photo.jpg' })
      .expect(400);
    await get(hash).expect(200);
  });

  it('refuses symlink, hardlink and readable-by-other-users files without modifying their targets', async () => {
    const hash = (await upload().expect(201)).body.hash;
    const file = path.join(root, 'state/wallpapers/7.image');
    const target = path.join(root, 'protected-image');
    await fs.writeFile(target, images.png, { mode: 0o600 });
    for (const kind of ['symlink', 'hardlink', 'permissions']) {
      await fs.rm(file);
      if (kind === 'symlink') await fs.symlink(target, file);
      else if (kind === 'hardlink') await fs.link(target, file);
      else await fs.writeFile(file, images.png, { mode: 0o644 });
      await get(hash).expect(400);
      await upload(images.jpeg).expect(400);
      await request(app.getHttpServer()).delete('/desktop-preferences/wallpaper').set('Authorization', 'owner').expect(400);
      expect(await fs.readFile(target)).toEqual(images.png);
    }
  });

  it('refuses a linked storage folder and never writes to its target', async () => {
    await fs.mkdir(path.join(root, 'state'));
    const target = path.join(root, 'unrelated');
    await fs.mkdir(target);
    await fs.symlink(target, path.join(root, 'state/wallpapers'));
    await upload().expect(400);
    expect(await fs.readdir(target)).toEqual([]);
  });

  it('accepts operator-group access on the configured state parent while keeping the wallpaper directory private', async () => {
    await fs.mkdir(path.join(root, 'state'), { mode: 0o775 });
    await fs.chmod(path.join(root, 'state'), 0o775);
    await upload().expect(201);
    expect((await fs.stat(path.join(root, 'state/wallpapers'))).mode & 0o777).toBe(0o700);
  });

  it('refuses a world-writable state parent before creating private image storage', async () => {
    await fs.mkdir(path.join(root, 'state'));
    await fs.chmod(path.join(root, 'state'), 0o777);
    await upload().expect(400);
    expect(await fs.readdir(path.join(root, 'state'))).toEqual([]);
  });

  it('retains the previous photo and removes temporary bytes if atomic replacement fails', async () => {
    const hash = (await upload().expect(201)).body.hash;
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('fixture I/O failure'), { code: 'EIO' }));
    await upload(images.jpeg).expect(500);
    rename.mockRestore();
    await get(hash).expect(200);
    expect(await fs.readdir(path.join(root, 'state/wallpapers'))).toEqual(['7.image']);
    await upload(images.webp).expect(201);
  });

  it('serializes simultaneous replacements and keeps one upload plus one recovery copy per account', async () => {
    const saved = await Promise.all([upload(images.png), upload(images.jpeg)]);
    expect(saved.map((response) => response.status)).toEqual([201, 201]);
    const current = await service.read(7);
    expect(saved.map((response) => response.body.hash)).toContain(current.hash);
    expect(await fs.readdir(path.join(root, 'state/wallpapers'))).toEqual(['7.image', '7.image.saved']);
  });

  it('keeps the selected photo readable when an upload is interrupted before preferences save, with bounded storage', async () => {
    const first = (await upload().expect(201)).body.hash;
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'owner')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, appearance: { wallpaperImage: first } })
      .expect(200);
    const second = (await upload(images.jpeg).expect(201)).body.hash;
    await get(first).expect(200);
    const third = (await upload(images.webp).expect(201)).body.hash;
    await get(first).expect(200);
    await get(second).expect(404);
    await get(third).expect(200);
    expect(await fs.readdir(path.join(root, 'state/wallpapers'))).toEqual(['7.image', '7.image.saved']);
    await request(app.getHttpServer()).delete('/desktop-preferences/wallpaper').set('Authorization', 'owner').expect(200);
    await get(first).expect(404);
    await get(third).expect(404);
  });

  it.each([
    { wallpaperImage: '/etc/passwd' },
    { wallpaperImage: 'https://example.test/photo' },
    { wallpaperBlur: 25 },
    { wallpaperDim: 71 },
    { wallpaperX: -1 },
    { accent: 'url(example)' },
    { textScale: 200 },
    { script: 'ignored?' },
  ])('rejects unsafe or out-of-range appearance preferences %#', async (appearance) => {
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'owner')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, appearance })
      .expect(400);
  });
});
