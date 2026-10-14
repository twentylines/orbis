import { type } from 'arktype';
import { createArkDto } from 'nestjs-arktype';

export const desktopPreferencesSchema = type({
  serverName: 'string > 0 & string <= 40',
  preset: type.enumerated('frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'),
  density: type.enumerated('comfortable', 'compact'),
  'wallpaper?': type.enumerated('sandstone', 'tidal', 'canopy'),
});

export class DesktopPreferencesDto extends createArkDto(desktopPreferencesSchema, { name: 'DesktopPreferencesDto', input: true }) {}
