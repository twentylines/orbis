import { useSyncExternalStore } from 'react';
import { prefersReducedMotion } from './motion-setting';

export const DESKTOP_WINDOW_QUERY = '(min-width: 1100px) and (min-height: 640px)';

const subscribe = (notify: () => void) => {
  const media = window.matchMedia(DESKTOP_WINDOW_QUERY);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const snapshot = () => window.matchMedia(DESKTOP_WINDOW_QUERY).matches;

export const useDesktopWindows = () => useSyncExternalStore(subscribe, snapshot, () => false);

export function revealPageFocus(element: HTMLElement) {
  if (!element.closest('#desktop-content') || element.dataset.pageFocusAlign === 'managed') return;
  if (element.dataset.pageFocusAlign === 'start') {
    element.scrollIntoView({ block: 'start', inline: 'nearest', behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
    return;
  }
  element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  const systemBarBottom = document.querySelector('.desktop-system-bar')?.getBoundingClientRect().bottom ?? 0;
  const heading = element.closest('.desktop-route-page')?.querySelector<HTMLElement>('.desktop-page-heading');
  const headingBottom =
    heading && !heading.contains(element) && getComputedStyle(heading).position === 'sticky' ? heading.getBoundingClientRect().bottom : 0;
  const top = Math.max(systemBarBottom, headingBottom) + 8;
  const bottom = (document.querySelector('.desktop-dock')?.getBoundingClientRect().top ?? window.innerHeight) - 8;
  const bounds = element.getBoundingClientRect();
  // Nearest scrolling can leave a tall control behind sticky chrome on short screens.
  if (bounds.height > bottom - top) return;
  const delta = bounds.top < top ? bounds.top - top : bounds.bottom > bottom ? bounds.bottom - bottom : 0;
  if (delta) window.scrollBy({ top: delta, behavior: 'instant' });
}
