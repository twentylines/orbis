import { useLayoutEffect, type RefObject } from 'react';
import { wallpaperTextColour, type WallpaperPixels } from '@/desktop/wallpaper-contrast';

const pixels = new WeakMap<HTMLImageElement, { source: string; value: WallpaperPixels }>();
const colours = new Map<string, readonly [number, number, number, number]>();

function readColour(value: string): readonly [number, number, number, number] {
  const cached = colours.get(value);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [0, 0, 0, 0];
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  const colour = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255] as const;
  if (colours.size >= 64) colours.clear();
  colours.set(value, colour);
  return colour;
}

function readPixels(image: HTMLImageElement) {
  const source = image.currentSrc || image.src;
  const previous = pixels.get(image);
  if (previous?.source === source) return previous.value;
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, 96, 96);
  const value = {
    width: 96,
    height: 96,
    sourceWidth: image.naturalWidth,
    sourceHeight: image.naturalHeight,
    data: context.getImageData(0, 0, 96, 96).data,
  };
  pixels.set(image, { source, value });
  return value;
}

export function observeSessionWallpaperInk(element: HTMLDivElement) {
  let frame: number | null = null;
  let active = true;
  const update = () => {
    frame = null;
    if (!active) return;
    const title = element.querySelector<HTMLElement>('.orbis-startup-title');
    const image = element.querySelector<HTMLImageElement>('.desktop-wallpaper-layer img:last-of-type');
    if (!title) return;
    const fallback = element.dataset.desktopMode === 'light' ? '#000000' : '#ffffff';
    const apply = (colour: string) => {
      if (element.style.getPropertyValue('--orbis-session-ink') !== colour) element.style.setProperty('--orbis-session-ink', colour);
    };
    if (image && (!image.complete || !image.naturalWidth)) {
      apply(fallback);
      return;
    }
    try {
      const surfaceStyle = getComputedStyle(element);
      const background = readColour(surfaceStyle.getPropertyValue('--orbis-session-background') || surfaceStyle.backgroundColor);
      const underlay = element.dataset.desktopMode === 'light' ? [248, 250, 252] : [5, 8, 14];
      const base = background.slice(0, 3).map((channel, index) => channel * background[3] + (underlay[index] ?? 0) * (1 - background[3])) as [
        number,
        number,
        number,
      ];
      const shade = element.querySelector('.desktop-wallpaper-shade');
      const tint = shade ? readColour(getComputedStyle(shade).backgroundColor) : undefined;
      const dim = element.querySelector('.desktop-wallpaper-dim');
      const opacity = dim ? readColour(getComputedStyle(dim).backgroundColor)[3] : 0;
      const value = image ? readPixels(image) : { width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, data: new Uint8ClampedArray([...base, 255]) };
      if (!value) return apply(fallback);
      const imageStyle = image ? getComputedStyle(image) : null;
      const position = imageStyle?.objectPosition.split(/\s+/) ?? [];
      const imageBox = image?.getBoundingClientRect() ?? element.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const colour = wallpaperTextColour(
        {
          pixels: value,
          fit: imageStyle?.objectFit === 'contain' ? 'contain' : 'cover',
          x: Number.parseFloat(position[0] ?? '50'),
          y: Number.parseFloat(position[1] ?? '50'),
          dim: opacity,
          shade: tint,
        },
        imageBox,
        { left: titleBox.left - imageBox.left, top: titleBox.top - imageBox.top, width: titleBox.width, height: titleBox.height },
        base,
        false,
      );
      if (colour) apply(colour);
    } catch {
      // Cross-origin artwork may forbid canvas reads; the plain mode fallback remains available.
      apply(fallback);
    }
  };
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(update);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(element, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'style', 'class', 'data-desktop-mode', 'data-desktop-preset'],
  });
  const size = new ResizeObserver(schedule);
  const copy = element.querySelector('.orbis-startup-copy');
  if (copy) size.observe(copy);
  size.observe(element);
  element.addEventListener('load', schedule, true);
  window.addEventListener('resize', schedule);
  update();
  return () => {
    active = false;
    observer.disconnect();
    size.disconnect();
    element.removeEventListener('load', schedule, true);
    window.removeEventListener('resize', schedule);
    if (frame !== null) cancelAnimationFrame(frame);
    element.style.removeProperty('--orbis-session-ink');
  };
}

export function useSessionWallpaperInk(surface: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    if (enabled && surface.current) return observeSessionWallpaperInk(surface.current);
  }, [enabled, surface]);
}
