import { type } from 'arktype';

export const desktopWindowIds = ['apps', 'app-store', 'monitor', 'updates', 'settings', 'tasks'] as const;
export type DesktopWindowId = (typeof desktopWindowIds)[number];

const bounds = type({
  x: '0 <= number.integer <= 16384',
  y: '0 <= number.integer <= 16384',
  width: '240 <= number.integer <= 8192',
  height: '200 <= number.integer <= 8192',
}).onUndeclaredKey('reject');
const restoreMode = type.enumerated('focused', 'floating', 'left', 'right');
export const desktopWindowSchema = type({
  mode: type.enumerated('focused', 'floating', 'maximized', 'left', 'right'),
  bounds,
  'restoreMode?': restoreMode,
}).onUndeclaredKey('reject');

export const desktopWindowsSchema = type({
  'apps?': desktopWindowSchema,
  'app-store?': desktopWindowSchema,
  'monitor?': desktopWindowSchema,
  'updates?': desktopWindowSchema,
  'settings?': desktopWindowSchema,
  'tasks?': desktopWindowSchema,
}).onUndeclaredKey('reject');

export type DesktopWindowState = typeof desktopWindowSchema.infer;
export type DesktopWindowBounds = DesktopWindowState['bounds'];
export type DesktopWindows = typeof desktopWindowsSchema.infer;
