import { type } from 'arktype';
import { interfaceThemeIdentitySchema, interfaceThemeSettingsStateSchema, interfaceThemeSettingsValuesSchema } from './interface-theme.js';

const revision = type('0 <= number.integer <= 9007199254740991');
export const themeSettingsDocumentSchema = type({
  formatVersion: '1',
  revision,
  legacyMigration: type.enumerated('pending', 'complete'),
  settings: interfaceThemeSettingsStateSchema,
}).onUndeclaredKey('reject');
export type ThemeSettingsDocument = typeof themeSettingsDocumentSchema.infer;
export const themeSettingsUpdateSchema = type({
  expectedRevision: revision,
  theme: interfaceThemeIdentitySchema,
  values: interfaceThemeSettingsValuesSchema,
}).onUndeclaredKey('reject');
export type ThemeSettingsUpdate = typeof themeSettingsUpdateSchema.infer;
export const themeSettingsMigrationSchema = type({ expectedRevision: revision }).onUndeclaredKey('reject');
export const themeSettingsByteLimit = 131072;
