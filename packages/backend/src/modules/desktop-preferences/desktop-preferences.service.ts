import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable } from '@nestjs/common';
import { type } from 'arktype';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { desktopPreferencesSchema } from './desktop-preferences.dto';

export type DesktopPreferences = typeof desktopPreferencesSchema.infer;
export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences & { workspace: NonNullable<DesktopPreferences['workspace']> } = {
  serverName: 'Hades',
  preset: 'frost',
  mode: 'light',
  density: 'comfortable',
  wallpaper: 'sandstone',
  workspace: {
    order: ['applications', 'activity', 'storage', 'attention'],
    hidden: [],
    wide: ['applications'],
    pinnedApps: [],
    showAllApps: false,
  },
};

@Injectable()
export class DesktopPreferencesService {
  constructor(private readonly config: ConfigurationService) {}

  private fileFor(userId: number) {
    const { dataDir } = this.config.get('directories');
    return path.join(dataDir, 'state', 'desktop', `${userId}.json`);
  }

  async read(userId: number): Promise<DesktopPreferences> {
    try {
      const raw = await fs.readFile(this.fileFor(userId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const result = desktopPreferencesSchema(parsed);
      return result instanceof type.errors
        ? DEFAULT_DESKTOP_PREFERENCES
        : {
            ...DEFAULT_DESKTOP_PREFERENCES,
            ...result,
            mode: result.mode ?? (result.preset === 'graphite' ? 'dark' : 'light'),
            workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, ...result.workspace },
          };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_DESKTOP_PREFERENCES;
      throw error;
    }
  }

  async write(userId: number, preferences: DesktopPreferences): Promise<DesktopPreferences> {
    const file = this.fileFor(userId);
    const value = {
      ...DEFAULT_DESKTOP_PREFERENCES,
      ...preferences,
      mode: preferences.mode ?? (preferences.preset === 'graphite' ? 'dark' : 'light'),
      workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, ...preferences.workspace },
    };
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return value;
  }
}
