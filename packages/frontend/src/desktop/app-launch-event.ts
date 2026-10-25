import type { AppLaunchRequest } from './app-window-state';

export const appLaunchEvent = 'orbis-launch-app';

export function requestAppLaunch(request: AppLaunchRequest) {
  return !window.dispatchEvent(new CustomEvent(appLaunchEvent, { detail: request, cancelable: true }));
}
