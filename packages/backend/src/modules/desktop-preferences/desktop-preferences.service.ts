import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable, type MessageEvent } from '@nestjs/common';
import { filter, map, Subject } from 'rxjs';
import { type } from 'arktype';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { desktopPreferencesSchema } from './desktop-preferences.dto';
import { normaliseDesktopAppearance } from '@runtipi/common/schemas';

export type DesktopPreferences = typeof desktopPreferencesSchema.infer;
export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences & { workspace: NonNullable<DesktopPreferences['workspace']> } = {
  serverName: 'Server',
  preset: 'frost',
  mode: 'light',
  density: 'comfortable',
  wallpaper: 'sandstone',
  windows: {},
  appearance: normaliseDesktopAppearance(),
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
  private readonly changes = new Subject<number>();
  constructor(private readonly config: ConfigurationService) {}

  changesFor(userId: number) {
    return this.changes.pipe(
      filter((changedUser) => changedUser === userId),
      map((): MessageEvent => ({ data: { changed: true } })),
    );
  }

  private onboardingFile(userId: number) {
    const { dataDir } = this.config.get('directories');
    return path.join(dataDir, 'state', 'onboarding', `${userId}.json`);
  }

  async onboarding(userId: number) {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.onboardingFile(userId), 'utf8'));
      return { complete: typeof value === 'object' && value !== null && 'version' in value && value.version === 1 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return { complete: false };
      throw error;
    }
  }

  async completeOnboarding(userId: number) {
    await this.writeState(this.onboardingFile(userId), { version: 1 });
    return { complete: true };
  }

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
            appearance: normaliseDesktopAppearance(result.appearance),
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
      appearance: normaliseDesktopAppearance(preferences.appearance),
    };
    await this.writeState(file, value);
    this.changes.next(userId);
    return value;
  }

  private async writeState(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
