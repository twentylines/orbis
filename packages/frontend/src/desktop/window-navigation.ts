import type { ShouldRevalidateFunctionArgs } from 'react-router';

export const WINDOW_MINIMIZED_PARAM = 'orbisWindow';
export const isWindowMinimized = (search: string) => new URLSearchParams(search).get(WINDOW_MINIMIZED_PARAM) === 'minimized';
export function windowSearch(search: string, minimized: boolean) {
  const params = new URLSearchParams(search);
  if (minimized) params.set(WINDOW_MINIMIZED_PARAM, 'minimized');
  else params.delete(WINDOW_MINIMIZED_PARAM);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function shouldRevalidateToolRoute({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search) {
    const before = new URLSearchParams(currentUrl.search);
    const after = new URLSearchParams(nextUrl.search);
    before.delete(WINDOW_MINIMIZED_PARAM);
    after.delete(WINDOW_MINIMIZED_PARAM);
    if (before.toString() === after.toString()) return false;
  }
  return defaultShouldRevalidate;
}
