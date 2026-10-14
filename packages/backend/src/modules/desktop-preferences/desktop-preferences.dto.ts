import { type } from 'arktype';
import { createArkDto } from 'nestjs-arktype';

export const desktopPreferencesSchema = type({
  serverName: 'string > 0 & string <= 40',
  preset: type.enumerated('frost', 'graphite', 'forest', 'stone'),
  density: type.enumerated('comfortable', 'compact'),
});

export class DesktopPreferencesDto extends createArkDto(desktopPreferencesSchema, { name: 'DesktopPreferencesDto', input: true }) {}
