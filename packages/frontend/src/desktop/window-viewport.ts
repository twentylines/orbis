import { useSyncExternalStore } from 'react';

export const DESKTOP_WINDOW_QUERY = '(min-width: 1100px) and (min-height: 640px)';

const subscribe = (notify: () => void) => {
  const media = window.matchMedia(DESKTOP_WINDOW_QUERY);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const snapshot = () => window.matchMedia(DESKTOP_WINDOW_QUERY).matches;

export const useDesktopWindows = () => useSyncExternalStore(subscribe, snapshot, () => false);

export function revealPageFocus(element: HTMLElement) {
  if (!element.closest('#desktop-content')) return;
  element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  const top = (document.querySelector('.desktop-system-bar')?.getBoundingClientRect().bottom ?? 0) + 8;
  const tray = document.querySelector('.orbis-app-tray:not([hidden]):not([aria-hidden="true"])');
  const bottom =
    Math.min(
      tray?.getBoundingClientRect().top ?? window.innerHeight,
      document.querySelector('.desktop-dock')?.getBoundingClientRect().top ?? window.innerHeight,
    ) - 8;
  const bounds = element.getBoundingClientRect();
  // Nearest scrolling can leave a tall control behind sticky chrome on short screens.
  if (bounds.height > bottom - top) return;
  const delta = bounds.top < top ? bounds.top - top : bounds.bottom > bottom ? bounds.bottom - bottom : 0;
  if (delta) window.scrollBy({ top: delta, behavior: 'instant' });
}
