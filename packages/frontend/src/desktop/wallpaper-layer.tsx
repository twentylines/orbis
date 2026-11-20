import { prefersReducedMotion } from './motion-setting';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { DesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import {
  resolveWallpaperKey,
  taggedWallpaperColours,
  wallpaperSources,
  type WallpaperChoice,
  type WallpaperPresentationColours,
} from './wallpaper-presets';
import { readWallpaperImage, rememberBrowserWallpaper, wallpaperCacheEvent } from './wallpaper-cache';
import { publicThemePackWallpaper, subscribeThemePackAppearance, themePackAppearanceSnapshot } from '@/modules/theme-packs/theme-pack-cache';
import './wallpaper.css';
import { setWallpaperTextSample } from './wallpaper-text';
import type { WallpaperPixels } from './wallpaper-contrast';
import { WallpaperTransition } from './wallpaper-transition';
import { selectWallpaperColours } from './wallpaper-palette';

const contrastPixels = new WeakMap<HTMLImageElement, WallpaperPixels>();

function imagePixels(image: HTMLImageElement): WallpaperPixels {
  const cached = contrastPixels.get(image);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || !image.naturalWidth || !image.naturalHeight) throw new Error('Wallpaper pixels are unavailable.');
  context.drawImage(image, 0, 0, 96, 96);
  const pixels = {
    width: 96,
    height: 96,
    sourceWidth: image.naturalWidth,
    sourceHeight: image.naturalHeight,
    data: context.getImageData(0, 0, 96, 96).data,
  };
  contrastPixels.set(image, pixels);
  return pixels;
}

const subscribeMotion = (changed: () => void) => {
  try {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  } catch {
    return () => undefined;
  }
};
const fullMotion = () => false;

function WallpaperImages({
  source,
  imageStyle,
  reduced,
  onError,
  onReady,
  prepare,
  onReveal,
}: {
  source: string;
  imageStyle: CSSProperties;
  reduced: boolean;
  onError?: () => void;
  onReady: (image: HTMLImageElement) => void;
  prepare: (image: HTMLImageElement) => boolean;
  onReveal: (image: HTMLImageElement) => void;
}) {
  const callbacks = useRef({ onReady, onError, prepare, onReveal });
  callbacks.current = { onReady, onError, prepare, onReveal };
  const render = useRef<(frames: ReturnType<WallpaperTransition['snapshot']>) => void>(() => undefined);
  const transition = useRef<WallpaperTransition | null>(null);
  if (!transition.current)
    transition.current = new WallpaperTransition(
      source,
      imageStyle,
      (frames) => render.current(frames),
      (image) => callbacks.current.onReady(image),
      () => callbacks.current.onError?.(),
      undefined,
      (image) => callbacks.current.onReveal(image),
    );
  const model = transition.current;
  const [frames, setFrames] = useState(() => model.snapshot());
  render.current = setFrames;
  const decoding = useRef(new WeakSet<HTMLImageElement>());
  const loaded = (id: number, image: HTMLImageElement) => {
    if (!model.needsDecode(id) || decoding.current.has(image)) return;
    decoding.current.add(image);
    const ready = () => {
      if (!model.needsDecode(id)) return;
      if (image.complete && image.naturalWidth > 0 && callbacks.current.prepare(image)) model.loaded(id);
      else model.error(id);
    };
    if (typeof image.decode === 'function') {
      void image.decode().then(ready, () => {
        if (image.crossOrigin === 'anonymous') model.error(id);
        else ready();
      });
    } else ready();
  };
  useLayoutEffect(() => {
    model.activate();
    return () => model.deactivate();
  }, [model]);
  useLayoutEffect(() => model.request(source, imageStyle, reduced), [model, source, imageStyle, reduced]);
  return frames.map((frame) => (
    <img
      key={frame.id}
      ref={(image) => {
        model.attach(frame.id, image);
        if (image?.complete && image.naturalWidth > 0) queueMicrotask(() => loaded(frame.id, image));
      }}
      src={frame.source}
      alt=""
      decoding="async"
      data-wallpaper-displayed={frame.displayed || undefined}
      style={{ ...frame.style, opacity: frame.opacity }}
      onLoad={(event) => loaded(frame.id, event.currentTarget)}
      onError={() => model.error(frame.id)}
    />
  ));
}

export function useWallpaperImage(hash: string | null, authenticated: boolean, revision: number, onUnavailable?: () => void) {
  const [custom, setCustom] = useState<{ hash: string; source: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!hash) return;
    let disposed = false;
    let generation = 0;
    const objectUrls: string[] = [];
    const controller = new AbortController();
    const load = async () => {
      const current = ++generation;
      setFailed(false);
      try {
        const image = await readWallpaperImage(hash, authenticated, revision, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
        if (disposed || generation !== current) return;
        if (!image) return setFailed(true);
        const source = URL.createObjectURL(image.blob);
        objectUrls.push(source);
        setCustom({ hash, source });
        if (!image.cached) void rememberBrowserWallpaper(hash, image.blob);
      } catch {
        if (disposed || generation !== current) return;
        setFailed(true);
        onUnavailable?.();
      }
    };
    const changed = () => void load();
    if (!authenticated) window.addEventListener(wallpaperCacheEvent, changed);
    void load();
    return () => {
      disposed = true;
      controller.abort();
      window.removeEventListener(wallpaperCacheEvent, changed);
      for (const source of objectUrls) URL.revokeObjectURL(source);
    };
  }, [hash, authenticated, revision, onUnavailable]);
  return {
    source: custom?.hash === hash ? custom.source : null,
    failed,
    unavailable: () => {
      setCustom(null);
      setFailed(true);
      onUnavailable?.();
    },
  };
}

export function WallpaperLayer({
  choice,
  authenticated = false,
  revision = 0,
  onUnavailable,
  automaticColours = false,
  onReveal,
}: {
  choice: WallpaperChoice & { appearance?: Partial<DesktopAppearance> };
  authenticated?: boolean;
  revision?: number;
  onUnavailable?: () => void;
  automaticColours?: boolean;
  onReveal?: (colours: WallpaperPresentationColours | null) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [revealedSource, setRevealedSource] = useState<string | null>(null);
  const preparedColours = useRef(new WeakMap<HTMLImageElement, WallpaperPresentationColours>());
  const systemReducedMotion = useSyncExternalStore(subscribeMotion, prefersReducedMotion, fullMotion);
  const themePack = useSyncExternalStore(subscribeThemePackAppearance, themePackAppearanceSnapshot, themePackAppearanceSnapshot);
  const value = {
    wallpaperImage: null,
    wallpaperFit: 'cover' as const,
    wallpaperX: 50,
    wallpaperY: 0,
    wallpaperDim: 0,
    wallpaperBlur: 0,
    motion: 'system' as const,
    lowEffects: false,
    ...choice.appearance,
  };
  const hash = choice.wallpaperMode === 'custom' ? value.wallpaperImage : null;
  const custom = useWallpaperImage(hash, authenticated, revision, onUnavailable);
  const protectedText = Boolean(
    hash || value.wallpaperFit !== 'cover' || value.wallpaperX !== 50 || value.wallpaperY !== 0 || value.wallpaperDim || value.wallpaperBlur,
  );
  const packSource =
    choice.wallpaperMode === 'theme' || (choice.wallpaperMode === undefined && !choice.wallpaperPreset && !value.wallpaperImage)
      ? themePack && publicThemePackWallpaper(themePack)
      : null;
  const fallback = packSource || wallpaperSources[resolveWallpaperKey(choice)];
  const source = hash ? (custom.source ?? revealedSource) : fallback;
  const surfaceSource = revealedSource ?? fallback;
  const prepare = useCallback(
    (image: HTMLImageElement) => {
      const current = image.getAttribute('src');
      if (!current) return false;
      if (!automaticColours || preparedColours.current.has(image)) return true;
      try {
        const colours = taggedWallpaperColours(current) ?? selectWallpaperColours(imagePixels(image).data);
        preparedColours.current.set(image, colours);
        return true;
      } catch {
        return false;
      }
    },
    [automaticColours],
  );
  const reveal = useCallback(
    (image: HTMLImageElement) => {
      const current = image.getAttribute('src');
      if (!current || current !== source) return;
      setRevealedSource(current);
      onReveal?.(automaticColours && prepare(image) ? (preparedColours.current.get(image) ?? null) : null);
    },
    [automaticColours, onReveal, prepare, source],
  );
  const publishContrast = useCallback(
    (image: HTMLImageElement) => {
      if (!layer.current?.parentElement?.classList.contains('desktop') || !image.naturalWidth || image.getAttribute('src') !== source) return;
      try {
        const pixels = imagePixels(image);
        setWallpaperTextSample({ pixels, fit: value.wallpaperFit, x: value.wallpaperX, y: value.wallpaperY, dim: value.wallpaperDim / 100 });
      } catch {
        // Cross-origin pack artwork can disallow sampling; retain the theme's readable fallback.
        setWallpaperTextSample(null);
      }
    },
    [source, value.wallpaperFit, value.wallpaperX, value.wallpaperY, value.wallpaperDim],
  );
  useEffect(() => {
    for (const image of layer.current?.querySelectorAll<HTMLImageElement>('img[data-wallpaper-displayed="true"]') ?? [])
      if (image.complete && image.naturalWidth > 0) {
        publishContrast(image);
        if (prepare(image)) reveal(image);
      }
  }, [prepare, publishContrast, reveal]);
  useEffect(() => {
    const desktop = layer.current?.parentElement?.classList.contains('desktop');
    return () => {
      if (desktop) setWallpaperTextSample(null);
    };
  }, []);
  useLayoutEffect(() => {
    const surface = layer.current?.parentElement;
    if (!surface) return;
    // iOS Safari extends the scrolling surface beneath its toolbar, beyond fixed images.
    const properties = {
      '--orbis-wallpaper-image': surfaceSource ? `url(${JSON.stringify(surfaceSource)})` : 'none',
      '--orbis-wallpaper-fit': value.wallpaperFit,
      '--orbis-wallpaper-position': `${value.wallpaperX}% ${value.wallpaperY}%`,
      '--orbis-wallpaper-dim': String(value.wallpaperDim / 100),
    };
    const previous = Object.keys(properties).map((property) => [property, surface.style.getPropertyValue(property)] as const);
    for (const [property, next] of Object.entries(properties)) surface.style.setProperty(property, next);
    return () => {
      for (const [property, before] of previous) {
        if (before) surface.style.setProperty(property, before);
        else surface.style.removeProperty(property);
      }
    };
  }, [surfaceSource, value.wallpaperFit, value.wallpaperX, value.wallpaperY, value.wallpaperDim]);
  return (
    <div
      ref={layer}
      className="desktop-wallpaper-layer"
      data-wallpaper-managed="true"
      aria-hidden="true"
      data-custom={Boolean(hash)}
      data-protect={protectedText}
      data-wallpaper-reduced={Boolean(systemReducedMotion) || value.motion === 'reduced' || value.lowEffects || undefined}
      data-wallpaper-state={hash ? (source ? 'ready' : custom.failed ? 'unavailable' : 'loading') : 'ready'}
      style={{ '--wallpaper-dim': value.wallpaperDim / 100 } as CSSProperties}
    >
      {source ? (
        <WallpaperImages
          source={source}
          reduced={Boolean(systemReducedMotion) || value.motion === 'reduced' || value.lowEffects}
          imageStyle={{
            objectFit: value.wallpaperFit,
            objectPosition: `${value.wallpaperX}% ${value.wallpaperY}%`,
            filter: value.lowEffects ? undefined : `blur(${value.wallpaperBlur}px)`,
            transform: value.wallpaperBlur && !value.lowEffects ? 'scale(1.08)' : undefined,
          }}
          onError={hash ? custom.unavailable : undefined}
          onReady={publishContrast}
          prepare={prepare}
          onReveal={reveal}
        />
      ) : null}
      <div className="desktop-wallpaper-shade" />
      <div className="desktop-wallpaper-dim" />
    </div>
  );
}
