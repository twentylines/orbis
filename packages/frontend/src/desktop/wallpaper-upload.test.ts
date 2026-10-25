/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { checkWallpaper, sendWallpaper, wallpaperRequestError } from './wallpaper-upload';
import { wallpaperFileLimit } from './wallpaper-cache';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64');
const originalImage = globalThis.Image;
const originalRequest = globalThis.XMLHttpRequest;
const requests: RequestFixture[] = [];
class RequestFixture {
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  status = 201;
  responseText = JSON.stringify({ hash: 'a'.repeat(64) });
  withCredentials = false;
  timeout = 0;
  method = '';
  url = '';
  form?: FormData;
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  constructor() {
    requests.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(form: FormData) {
    this.form = form;
  }
  abort() {
    this.onabort?.();
  }
}
afterEach(() => {
  globalThis.Image = originalImage;
  globalThis.XMLHttpRequest = originalRequest;
  requests.length = 0;
});
const transfer = (signal = new AbortController().signal, progress = (_value: number | null) => {}) => {
  globalThis.XMLHttpRequest = RequestFixture as unknown as typeof XMLHttpRequest;
  return sendWallpaper(new File([png], 'photo.png', { type: 'image/png' }), signal, progress);
};

describe('wallpaper upload', () => {
  test('sends one multipart image with session credentials and real upload progress', async () => {
    const progress: (number | null)[] = [];
    const result = transfer(undefined, (value) => progress.push(value));
    const request = requests[0] as RequestFixture;
    expect([request.method, request.url, request.withCredentials, request.timeout]).toEqual([
      'POST',
      '/api/desktop-preferences/wallpaper',
      true,
      120000,
    ]);
    const form = request.form as FormData;
    expect([...form.keys()]).toEqual(['image']);
    expect((form.get('image') as File).name).toBe('photo.png');
    expect(await (form.get('image') as File).arrayBuffer()).toEqual(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
    request.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    request.upload.onprogress?.({ lengthComputable: false, loaded: 60, total: 0 });
    request.onload?.();
    expect(await result).toBe('a'.repeat(64));
    expect(progress).toEqual([50, null]);
  });
  test.each([401, 404, 413, 500])('reports HTTP %s without claiming upload success', async (status) => {
    const result = transfer();
    const request = requests[0] as RequestFixture;
    request.status = status;
    request.responseText = '<html>error</html>';
    request.onload?.();
    await expect(result).rejects.toThrow(wallpaperRequestError(status));
  });
  test('retains an actionable storage error and rejects invalid success data', async () => {
    const result = transfer();
    const request = requests[0] as RequestFixture;
    request.status = 400;
    request.responseText = JSON.stringify({ message: 'Wallpaper storage needs a permissions review.' });
    request.onload?.();
    await expect(result).rejects.toThrow('Wallpaper storage needs a permissions review.');
    const invalid = transfer();
    (requests[1] as RequestFixture).responseText = '{}';
    requests[1]?.onload?.();
    await expect(invalid).rejects.toThrow('invalid wallpaper');
  });
  test('cancels the transfer and reports timeout or network failure', async () => {
    const controller = new AbortController();
    const canceled = transfer(controller.signal);
    controller.abort();
    await expect(canceled).rejects.toThrow('canceled');
    const timeout = transfer();
    requests[1]?.ontimeout?.();
    await expect(timeout).rejects.toThrow('timed out');
    const offline = transfer();
    requests[2]?.onerror?.();
    await expect(offline).rejects.toThrow('connection');
  });
  test('accepts larger bounded original images and validates both header and decoded dimensions', async () => {
    globalThis.Image = class {
      src = '';
      naturalWidth = 8000;
      naturalHeight = 8000;
      decode = async () => {};
    } as unknown as typeof Image;
    const data = Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)]);
    expect(await checkWallpaper(new File([data], 'large.png'), new AbortController().signal)).toBe('image/png');
    const excessive = Buffer.from(png);
    excessive.writeUInt32BE(8000, 16);
    excessive.writeUInt32BE(8001, 20);
    await expect(checkWallpaper(new File([excessive], 'too-large.png'), new AbortController().signal)).rejects.toThrow('64 megapixels');
    await expect(checkWallpaper(new File([new Uint8Array(wallpaperFileLimit + 1)], 'too-large.png'), new AbortController().signal)).rejects.toThrow(
      '32 MB',
    );
    globalThis.Image = class {
      src = '';
      naturalWidth = 16385;
      naturalHeight = 1;
      decode = async () => {};
    } as unknown as typeof Image;
    await expect(checkWallpaper(new File([png], 'bad.png'), new AbortController().signal)).rejects.toThrow('64 megapixels');
  });
});
