import type { AppLaunchRequest } from './app-window-state';

export type SearchAction = { path: string; launch?: AppLaunchRequest };

export function defaultSearchResult<T>(results: readonly T[]): T | undefined {
  return results[0];
}

export function activateSearchResult(result: SearchAction, openApp: (request: AppLaunchRequest) => boolean, close: (path?: string) => void) {
  if (result.launch) {
    if (openApp(result.launch)) close();
  } else close(result.path);
}
