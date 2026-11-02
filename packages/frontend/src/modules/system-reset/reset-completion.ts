import { preferenceStorageKey } from '@/desktop/appearance-cache';
import { themePackCacheKey } from '@/modules/theme-packs/theme-pack-cache';
import { clearAcceptedReset } from '@/components/recovery-progress/operation-status';

export function resetCompletion(clearPreferences: () => void, navigate: () => void) {
  let navigating = false;
  return () => {
    if (navigating) return;
    navigating = true;
    try {
      clearPreferences();
    } catch {
      // Stored browser preferences must not prevent reopening setup.
    }
    try {
      navigate();
    } catch (failure) {
      navigating = false;
      throw failure;
    }
  };
}

export const openResetOnboarding = resetCompletion(
  () => {
    for (const key of [preferenceStorageKey, themePackCacheKey]) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Server preferences remain authoritative if storage is unavailable.
      }
    }
  },
  () => {
    window.location.replace('/');
    clearAcceptedReset();
  },
);
