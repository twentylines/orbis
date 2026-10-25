import { prefersReducedMotion } from './motion-setting';
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { DesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import { resolveWallpaperKey, wallpaperSources, type WallpaperChoice } from './wallpaper-presets';
import { readWallpaperImage, rememberBrowserWallpaper, wallpaperCacheEvent } from './wallpaper-cache';
import './wallpaper.css';

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
}: {
  source: string;
  imageStyle: CSSProperties;
  reduced: boolean;
  onError?: () => void;
}) {
  const [frames, setFrames] = useState([{ source, ready: false }]);
  useEffect(() => {
    setFrames((previous) =>
      previous.some((frame) => frame.source === source)
        ? previous.filter((frame) => frame.source === source)
        : [...previous.filter((frame) => frame.ready).slice(-1), { source, ready: false }],
    );
  }, [source]);
  return frames.map((frame) => (
    <img
      key={frame.source}
      src={frame.source}
      alt=""
      decoding="async"
      style={{ ...imageStyle, opacity: frame.ready ? 1 : 0, transitionDuration: reduced ? '0s' : undefined }}
      onLoad={(event) => {
        // Cached images need an initial computed opacity before the fade starts.
        if (!reduced) getComputedStyle(event.currentTarget).opacity;
        setFrames((previous) => {
          const ready = previous.map((item) => (item.source === frame.source ? { ...item, ready: true } : item));
          return reduced ? ready.filter((item) => item.source === source) : ready;
        });
      }}
      onError={frame.source === source ? onError : undefined}
      onTransitionEnd={(event) => {
        if (event.propertyName === 'opacity' && frame.source === source && frame.ready)
          setFrames((previous) => previous.filter((item) => item.source === source));
      }}
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
}: {
  choice: WallpaperChoice & { appearance?: Partial<DesktopAppearance> };
  authenticated?: boolean;
  revision?: number;
  onUnavailable?: () => void;
}) {
  const systemReducedMotion = useSyncExternalStore(subscribeMotion, prefersReducedMotion, fullMotion);
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
  const source = hash ? custom.source : wallpaperSources[resolveWallpaperKey(choice)];
  return (
    <div
      className="desktop-wallpaper-layer"
      aria-hidden="true"
      data-custom={Boolean(hash)}
      data-protect={protectedText}
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
        />
      ) : null}
      <div className="desktop-wallpaper-shade" />
      <div className="desktop-wallpaper-dim" />
    </div>
  );
}
