import { useUserContext } from '@/context/user-context';
import toast from 'react-hot-toast';
import { useRef } from 'react';
import { useDesktopPreferences } from './preferences';
import { WallpaperLayer } from './wallpaper-layer';

const unavailable = () =>
  toast.error('Your uploaded wallpaper could not be loaded. Replace it or choose another wallpaper in Appearance.', { id: 'wallpaper-unavailable' });

export function DesktopWallpaper() {
  const { preferences, wallpaperRevision, onboardingGeneration, revealWallpaper } = useDesktopPreferences();
  const { isLoggedIn, sessionEpoch } = useUserContext();
  const privacy = useRef({ sessionEpoch, key: 0 });
  if (privacy.current.sessionEpoch !== sessionEpoch) privacy.current = { sessionEpoch, key: privacy.current.key + 1 };
  return (
    <WallpaperLayer
      key={`${privacy.current.key}:${onboardingGeneration ?? 'none'}`}
      choice={preferences}
      authenticated={isLoggedIn}
      revision={wallpaperRevision}
      onUnavailable={isLoggedIn ? unavailable : undefined}
      automaticColours={preferences.appearance.wallpaperColours}
      onReveal={revealWallpaper}
    />
  );
}
