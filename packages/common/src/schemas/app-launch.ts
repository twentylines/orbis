import { type } from 'arktype';
import { desktopWindowSchema } from './desktop-windows.js';

export const appOpeningMode = type.enumerated('window', 'tab');
const appOpening = type({
  'mode?': appOpeningMode,
  'bounds?': desktopWindowSchema.get('bounds'),
}).onUndeclaredKey('reject');

export const appLaunchSchema = type({
  mode: appOpeningMode,
  apps: type({ '[string]': appOpening }).narrow((apps) => {
    const keys = Object.keys(apps);
    return keys.length <= 512 && keys.every((key) => key.includes(':') && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,179}$/.test(key));
  }),
}).onUndeclaredKey('reject');

export type AppLaunchPreferences = typeof appLaunchSchema.infer;
export type AppOpeningMode = typeof appOpeningMode.infer;
export const defaultAppLaunch: AppLaunchPreferences = { mode: 'window', apps: {} };
