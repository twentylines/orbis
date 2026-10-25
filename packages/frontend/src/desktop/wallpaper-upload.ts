import { imageDimensionsFromData } from 'image-dimensions';
import { wallpaperFileLimit } from './wallpaper-cache';

export function wallpaperRequestError(status: number, value?: unknown) {
  if (status === 401) return 'Session expired. Sign in again.';
  if (status === 413) return 'Choose an image up to 32 MB.';
  if (status === 404) return 'Wallpaper uploads are unavailable on this server. Update Orbis and try again.';
  return status < 500 && value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' && value.message.length <= 500
    ? value.message
    : 'The wallpaper could not be saved. Check the connection and try again.';
}

export async function checkWallpaper(file: File, signal: AbortSignal) {
  if (!file.size || file.size > wallpaperFileLimit) throw new Error('Choose an image up to 32 MB.');
  const dimensions = imageDimensionsFromData(new Uint8Array(await file.arrayBuffer()));
  if (!dimensions || !['png', 'jpeg', 'webp'].includes(dimensions.type)) throw new Error('Choose a readable PNG, JPEG or WebP image.');
  if (
    ![dimensions.width, dimensions.height].every((side) => Number.isInteger(side) && side > 0 && side <= 16384) ||
    dimensions.width * dimensions.height > 64_000_000
  ) {
    throw new Error('Use an image up to 64 megapixels, with neither side larger than 16,384 pixels.');
  }
  signal.throwIfAborted();
  const source = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = source;
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      image
        .decode()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', aborted));
    });
    signal.throwIfAborted();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth > 16384 ||
      image.naturalHeight > 16384 ||
      image.naturalWidth * image.naturalHeight > 64_000_000
    )
      throw new Error('Use an image up to 64 megapixels, with neither side larger than 16,384 pixels.');
    return `image/${dimensions.type}`;
  } finally {
    image.src = '';
    URL.revokeObjectURL(source);
  }
}

export function sendWallpaper(file: File, signal: AbortSignal, progress: (percent: number | null) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const finish = (error?: Error, hash?: string) => {
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(hash as string);
    };
    const aborted = () => request.abort();
    request.open('POST', '/api/desktop-preferences/wallpaper');
    request.withCredentials = true;
    request.timeout = 120000;
    request.upload.onprogress = (event) => progress(event.lengthComputable ? Math.min(100, Math.round((event.loaded / event.total) * 100)) : null);
    request.onerror = () => finish(new Error('The wallpaper could not be saved. Check the connection and try again.'));
    request.ontimeout = () => finish(new Error('Upload timed out. Check the connection and try again.'));
    request.onabort = () => finish(new Error('Upload canceled. Try again.'));
    request.onload = () => {
      let value: unknown;
      try {
        value = JSON.parse(request.responseText);
      } catch {
        value = null;
      }
      if (request.status < 200 || request.status >= 300) return finish(new Error(wallpaperRequestError(request.status, value)));
      if (!value || typeof value !== 'object' || !('hash' in value) || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) {
        return finish(new Error('The server returned an invalid wallpaper.'));
      }
      finish(undefined, value.hash);
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) {
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
      return;
    }
    const form = new FormData();
    form.append('image', file, file.name);
    request.send(form);
  });
}
