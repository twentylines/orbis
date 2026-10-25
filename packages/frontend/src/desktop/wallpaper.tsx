import { useUserContext } from '@/context/user-context';
import toast from 'react-hot-toast';
import { useDesktopPreferences } from './preferences';
import { WallpaperLayer } from './wallpaper-layer';

const unavailable = () =>
  toast.error('Your uploaded wallpaper could not be loaded. Replace it or choose another wallpaper in Appearance.', { id: 'wallpaper-unavailable' });

export function DesktopWallpaper() {
  const { preferences, wallpaperRevision } = useDesktopPreferences();
  const { isLoggedIn } = useUserContext();
  return (
    <WallpaperLayer
      choice={preferences}
      authenticated={isLoggedIn}
      revision={wallpaperRevision}
      onUnavailable={isLoggedIn ? unavailable : undefined}
    />
  );
}
