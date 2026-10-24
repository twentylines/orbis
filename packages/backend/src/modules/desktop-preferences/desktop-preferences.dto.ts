import { type } from 'arktype';
import { createArkDto } from 'nestjs-arktype';
import { appLaunchSchema, desktopAppearanceSchema, desktopWindowsSchema } from '@runtipi/common/schemas';

const widgetId = type.enumerated('applications', 'activity', 'storage', 'attention');
const widgetList = widgetId.array().narrow((items) => items.length <= 4 && new Set(items).size === items.length);
const workspace = type({
  order: widgetList,
  hidden: widgetList,
  wide: widgetList,
  'showAllApps?': 'boolean',
  'pinnedApps?': type('string > 2 & string <= 180')
    .array()
    .narrow((items) => items.length <= 512 && new Set(items).size === items.length && items.every((item) => /^[^:]+:[^:]+$/.test(item))),
})
  .onUndeclaredKey('delete')
  .narrow(({ order }) => order.length === 4);

export const desktopPreferencesSchema = type({
  serverName: 'string > 0 & string <= 40',
  preset: type.enumerated('frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'),
  'mode?': type.enumerated('light', 'dark', 'system'),
  density: type.enumerated('comfortable', 'compact'),
  'wallpaper?': type.enumerated('sandstone', 'tidal', 'canopy'),
  'wallpaperMode?': type.enumerated('theme', 'custom'),
  'wallpaperPreset?': type.enumerated('frost', 'graphite', 'forest', 'stone', 'ocean', 'blush', null),
  'workspace?': workspace,
  'windows?': desktopWindowsSchema,
  'appLaunch?': appLaunchSchema,
  'appearance?': desktopAppearanceSchema,
}).onUndeclaredKey('delete');

export class DesktopPreferencesDto extends createArkDto(desktopPreferencesSchema, { name: 'DesktopPreferencesDto', input: true }) {}
