import { useReducedMotion } from '@/desktop/motion-preferences';
import { useUserContext } from '@/context/user-context';
import { useEffect, useState, type CSSProperties } from 'react';
import { useDesktopPreferences } from './preferences';
import { resolveWallpaperKey, wallpaperSources } from './wallpaper-presets';
import './wallpaper.css';

export const wallpaperUrl = (hash: string, revision = 0) => `/api/desktop-preferences/wallpaper?version=${hash}&refresh=${revision}`;

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

export function DesktopWallpaper() {
  const { preferences, wallpaperRevision } = useDesktopPreferences();
  const { isLoggedIn } = useUserContext();
  const systemReducedMotion = useReducedMotion();
  const value = preferences.appearance;
  const hash = isLoggedIn && preferences.wallpaperMode === 'custom' ? value.wallpaperImage : null;
  const customSource = hash ? wallpaperUrl(hash, wallpaperRevision) : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const protectedText = Boolean(
    hash || value.wallpaperFit !== 'cover' || value.wallpaperX !== 50 || value.wallpaperY !== 0 || value.wallpaperDim || value.wallpaperBlur,
  );
  const source = customSource && customSource !== failedSource ? customSource : wallpaperSources[resolveWallpaperKey(preferences)];
  return (
    <div
      className="desktop-wallpaper-layer"
      aria-hidden="true"
      data-custom={Boolean(hash)}
      data-protect={protectedText}
      style={{ '--wallpaper-dim': value.wallpaperDim / 100 } as CSSProperties}
    >
      <WallpaperImages
        source={source}
        reduced={Boolean(systemReducedMotion) || value.motion === 'reduced' || value.lowEffects}
        imageStyle={{
          objectFit: value.wallpaperFit,
          objectPosition: `${value.wallpaperX}% ${value.wallpaperY}%`,
          filter: value.lowEffects ? undefined : `blur(${value.wallpaperBlur}px)`,
          transform: value.wallpaperBlur && !value.lowEffects ? 'scale(1.08)' : undefined,
        }}
        onError={customSource && customSource !== failedSource ? () => setFailedSource(customSource) : undefined}
      />
      <div className="desktop-wallpaper-shade" />
      <div className="desktop-wallpaper-dim" />
    </div>
  );
}
