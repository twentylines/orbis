import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable, type MessageEvent } from '@nestjs/common';
import { filter, map, Subject } from 'rxjs';
import { type } from 'arktype';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { desktopPreferencesSchema } from './desktop-preferences.dto';
import { defaultAppLaunch, defaultDesktopAppearance, normaliseDesktopAppearance } from '@runtipi/common/schemas';
import { patchSelectedPreferences, selectedPreferences, UnsupportedDesktopPreferencesError } from './desktop-preferences-sync';

export type DesktopPreferences = typeof desktopPreferencesSchema.infer;
export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences & { workspace: NonNullable<DesktopPreferences['workspace']> } = {
  serverName: 'Server',
  preset: 'frost',
  mode: 'light',
  density: 'comfortable',
  wallpaper: 'sandstone',
  wallpaperMode: 'theme',
  wallpaperPreset: null,
  windows: {},
  appLaunch: defaultAppLaunch,
  showStoreRecommendations: true,
  hiddenStoreRecommendationCategories: [],
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
  private readonly writes = new Map<number, Promise<unknown>>();
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
      const appearance = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'appearance' in parsed ? parsed.appearance : undefined;
      const supported =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) && appearance && typeof appearance === 'object' && !Array.isArray(appearance)
          ? { ...parsed, appearance: Object.fromEntries(Object.entries(appearance).filter(([key]) => Object.hasOwn(defaultDesktopAppearance, key))) }
          : parsed;
      const result = desktopPreferencesSchema(supported);
      return result instanceof type.errors
        ? DEFAULT_DESKTOP_PREFERENCES
        : {
            ...DEFAULT_DESKTOP_PREFERENCES,
            ...result,
            wallpaperMode: result.wallpaperMode ?? (result.wallpaperPreset || result.appearance?.wallpaperImage ? 'custom' : 'theme'),
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
    return this.serialize(userId, () => this.writePreferences(userId, preferences));
  }

  async updateSelected(userId: number, update: (current: DesktopPreferences) => DesktopPreferences): Promise<DesktopPreferences> {
    return this.serialize(userId, async () => {
      const raw = await this.readSelectedRaw(userId);
      const current = selectedPreferences(raw, DEFAULT_DESKTOP_PREFERENCES);
      const output = patchSelectedPreferences(raw, current, update(current));
      if (output !== raw) {
        await this.writeRawState(this.fileFor(userId), output);
        this.changes.next(userId);
      }
      return selectedPreferences(output, DEFAULT_DESKTOP_PREFERENCES);
    });
  }

  async readSelected(userId: number): Promise<DesktopPreferences> {
    return selectedPreferences(await this.readSelectedRaw(userId), DEFAULT_DESKTOP_PREFERENCES);
  }

  private async readSelectedRaw(userId: number) {
    try {
      const handle = await fs.open(this.fileFor(userId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
          throw new UnsupportedDesktopPreferencesError();
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${JSON.stringify(DEFAULT_DESKTOP_PREFERENCES)}\n`;
      throw error;
    }
  }

  private serialize<T>(userId: number, work: () => Promise<T>) {
    const pending = (this.writes.get(userId) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.writes.set(userId, pending);
    void pending
      .finally(() => {
        if (this.writes.get(userId) === pending) this.writes.delete(userId);
      })
      .catch(() => undefined);
    return pending;
  }

  private async writePreferences(userId: number, preferences: DesktopPreferences): Promise<DesktopPreferences> {
    const file = this.fileFor(userId);
    const value = {
      ...DEFAULT_DESKTOP_PREFERENCES,
      ...preferences,
      wallpaperMode: preferences.wallpaperMode ?? (preferences.wallpaperPreset || preferences.appearance?.wallpaperImage ? 'custom' : 'theme'),
      mode: preferences.mode ?? (preferences.preset === 'graphite' ? 'dark' : 'light'),
      workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, ...preferences.workspace },
      appearance: normaliseDesktopAppearance(preferences.appearance),
    };
    await this.writeState(file, value);
    this.changes.next(userId);
    return value;
  }

  private async writeState(file: string, value: unknown) {
    return this.writeRawState(file, `${JSON.stringify(value)}\n`);
  }

  private async writeRawState(file: string, raw: string) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      const parent = await fs.open(path.dirname(file), 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
