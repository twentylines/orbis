import { type } from 'arktype';
import { createArkDto } from 'nestjs-arktype';

const widgetId = type.enumerated('applications', 'activity', 'storage', 'attention');
const widgetList = widgetId.array().narrow((items) => items.length <= 4 && new Set(items).size === items.length);
const workspace = type({
  order: widgetList,
  hidden: widgetList,
  wide: widgetList,
  'pinnedApps?': type('string > 2 & string <= 180')
    .array()
    .narrow((items) => items.length <= 12 && new Set(items).size === items.length && items.every((item) => /^[^:]+:[^:]+$/.test(item))),
}).narrow(({ order }) => order.length === 4);

export const desktopPreferencesSchema = type({
  serverName: 'string > 0 & string <= 40',
  preset: type.enumerated('frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'),
  density: type.enumerated('comfortable', 'compact'),
  'wallpaper?': type.enumerated('sandstone', 'tidal', 'canopy'),
  'workspace?': workspace,
});

export class DesktopPreferencesDto extends createArkDto(desktopPreferencesSchema, { name: 'DesktopPreferencesDto', input: true }) {}
