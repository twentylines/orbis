import { ConfigurationService } from '@/core/config/configuration.service';
import { BadRequestException, ConflictException, Injectable, type MessageEvent } from '@nestjs/common';
import { filter, map, Subject } from 'rxjs';
import { type } from 'arktype';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { desktopPreferencesSchema } from './desktop-preferences.dto';
import { defaultAppLaunch, defaultDesktopAppearance, normaliseDesktopAppearance } from '@runtipi/common/schemas';
import { ResetState } from '../system-reset/reset-state';
import { patchSelectedPreferences, selectedPreferences, UnsupportedDesktopPreferencesError } from './desktop-preferences-sync';
import { notifyClientStatusChanged } from '@/common/restoration-status';
import { emptyUnsplashLibrary, record, type UnsplashAccount, unsplashLibrarySchema } from './desktop-unsplash-state';

export type DesktopPreferences = typeof desktopPreferencesSchema.infer;
export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences & { workspace: NonNullable<DesktopPreferences['workspace']> } = {
  serverName: 'Server',
  preset: 'frost',
  mode: 'system',
  density: 'comfortable',
  wallpaper: 'sandstone',
  wallpaperMode: 'theme',
  wallpaperPreset: null,
  windows: {},
  appLaunch: defaultAppLaunch,
  showLogicalProcessors: true,
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

  private async migratedFromRuntipi() {
    const file = path.join(this.config.get('directories').dataDir, '.orbis-onboarding-origin.json');
    try {
      const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 128 || info.mode & 0o022) return false;
        const value: unknown = JSON.parse(await handle.readFile('utf8'));
        return (
          typeof value === 'object' &&
          value !== null &&
          Object.keys(value).length === 2 &&
          'version' in value &&
          value.version === 1 &&
          'source' in value &&
          value.source === 'runtipi'
        );
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  }

  async onboarding(userId: number) {
    const reset = await new ResetState(this.config.get('directories').dataDir).read();
    const generation = reset?.phase === 'complete' ? { generation: reset.id } : {};
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.onboardingFile(userId), 'utf8'));
      return { complete: typeof value === 'object' && value !== null && 'version' in value && value.version === 1, ...generation };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
        return { complete: false, ...generation, ...((await this.migratedFromRuntipi()) ? { entry: 'runtipi' as const } : {}) };
      throw error;
    }
  }

  private async assertClientGeneration(generation: string | null | undefined) {
    if (generation === undefined) return;
    const reset = await new ResetState(this.config.get('directories').dataDir).active();
    if (
      (reset && reset.phase !== 'complete') ||
      (reset?.phase === 'complete' && generation !== reset.id) ||
      (!reset && generation !== null && generation !== 'none')
    )
      throw new ConflictException('Orbis was reset. Reload your settings before saving.');
  }

  async completeOnboarding(userId: number, generation?: string | null) {
    return this.serialize(userId, async () => {
      await this.assertClientGeneration(generation);
      await this.writeState(this.onboardingFile(userId), { version: 1 });
      this.changes.next(userId);
      notifyClientStatusChanged();
      return { complete: true };
    });
  }

  withIncompleteOnboarding<T>(userId: number, work: (complete: () => Promise<void>) => Promise<T>) {
    return this.serialize(userId, async () => {
      if ((await this.onboarding(userId)).complete) return null;
      const value = await work(async () => {
        await this.writeState(this.onboardingFile(userId), { version: 1 });
        this.changes.next(userId);
        notifyClientStatusChanged();
      });
      return { value };
    });
  }

  private fileFor(userId: number) {
    const { dataDir } = this.config.get('directories');
    return path.join(dataDir, 'state', 'desktop', `${userId}.json`);
  }

  private async readStored(userId: number): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(this.fileFor(userId), 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private clientPreferences(parsed: unknown): DesktopPreferences {
    const value = record(parsed);
    const appearance = record(value?.appearance);
    const supported = appearance
      ? { ...value, appearance: Object.fromEntries(Object.entries(appearance).filter(([key]) => Object.hasOwn(defaultDesktopAppearance, key))) }
      : parsed;
    const result = desktopPreferencesSchema(supported);
    if (result instanceof type.errors) return DEFAULT_DESKTOP_PREFERENCES;
    const currentAppearance = normaliseDesktopAppearance(result.appearance);
    if (currentAppearance.wallpaperUnsplash) {
      const library = unsplashLibrarySchema(value?.unsplashLibrary);
      if (library instanceof type.errors || !library.photos.some(({ id }) => id === currentAppearance.wallpaperUnsplash)) {
        currentAppearance.wallpaperUnsplash = null;
      }
    }
    return {
      ...DEFAULT_DESKTOP_PREFERENCES,
      ...result,
      wallpaperMode: result.wallpaperMode ?? (result.wallpaperPreset || result.appearance?.wallpaperImage ? 'custom' : 'theme'),
      mode: result.mode ?? (result.preset === 'graphite' ? 'dark' : 'system'),
      workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, ...result.workspace },
      appearance: currentAppearance,
    };
  }

  async read(userId: number): Promise<DesktopPreferences> {
    return this.clientPreferences(await this.readStored(userId));
  }

  private unsplashAccount(stored: Record<string, unknown>): UnsplashAccount {
    const library = stored.unsplashLibrary === undefined ? emptyUnsplashLibrary : unsplashLibrarySchema(stored.unsplashLibrary);
    if (library instanceof type.errors) throw new ConflictException('Saved Unsplash wallpapers need a review.');
    const selectedId = record(stored.appearance)?.wallpaperUnsplash;
    return { library, selectedId: typeof selectedId === 'string' && library.photos.some(({ id }) => id === selectedId) ? selectedId : null };
  }

  private async readUnsplashStored(userId: number) {
    const stored = record(JSON.parse(await this.readSelectedRaw(userId)));
    if (!stored || (stored.appearance !== undefined && !record(stored.appearance))) {
      throw new ConflictException('Saved wallpaper preferences need a review.');
    }
    return stored;
  }

  async unsplashSnapshot(userId: number) {
    return this.serialize(userId, async () => {
      const reset = await new ResetState(this.config.get('directories').dataDir).active();
      if (reset && reset.phase !== 'complete') throw new ConflictException('Wait for Orbis to finish resetting before loading preferences.');
      return { account: this.unsplashAccount(await this.readUnsplashStored(userId)), generation: reset?.id ?? null };
    });
  }

  async updateUnsplashWallpaper(
    userId: number,
    generation: string | null,
    update: (account: UnsplashAccount) => Promise<UnsplashAccount> | UnsplashAccount,
  ) {
    return this.serialize(userId, async () => {
      await this.assertClientGeneration(generation);
      const stored = await this.readUnsplashStored(userId);
      const current = this.unsplashAccount(stored);
      const next = await update(current);
      if (next !== current) {
        await this.assertClientGeneration(generation);
        await this.writeState(this.fileFor(userId), {
          ...stored,
          appearance: { ...record(stored.appearance), wallpaperUnsplash: next.selectedId },
          unsplashLibrary: next.library,
        });
        this.changes.next(userId);
      }
      return next;
    });
  }

  async clientSnapshot(userId: number) {
    return this.serialize(userId, async () => {
      const reset = await new ResetState(this.config.get('directories').dataDir).active();
      if (reset && reset.phase !== 'complete') throw new ConflictException('Wait for Orbis to finish resetting before loading preferences.');
      return { preferences: await this.read(userId), generation: reset?.id ?? null };
    });
  }

  async write(userId: number, preferences: DesktopPreferences, generation?: string | null, expectedSelection?: string): Promise<DesktopPreferences> {
    return this.serialize(userId, async () => {
      await this.assertClientGeneration(generation);
      return this.writePreferences(userId, preferences, generation !== undefined, expectedSelection);
    });
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

  backupSnapshot(userId: number): Promise<DesktopPreferences> {
    return this.serialize(userId, async () => {
      const raw: unknown = JSON.parse(await this.readSelectedRaw(userId));
      const stored = record(raw);
      const { unsplashLibrary: _serverOnlyLibrary, ...portable } = stored ?? {};
      const value = desktopPreferencesSchema.onDeepUndeclaredKey('reject').assert(stored ? portable : raw);
      return {
        ...DEFAULT_DESKTOP_PREFERENCES,
        ...value,
        wallpaperMode: value.wallpaperMode ?? (value.wallpaperPreset || value.appearance?.wallpaperImage ? 'custom' : 'theme'),
        mode: value.mode ?? (value.preset === 'graphite' ? 'dark' : 'system'),
        workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, ...value.workspace },
        appearance: normaliseDesktopAppearance(value.appearance),
      };
    });
  }

  private async readSelectedRaw(userId: number) {
    try {
      const handle = await fs.open(this.fileFor(userId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
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

  private async writePreferences(
    userId: number,
    preferences: DesktopPreferences,
    clientWrite: boolean,
    expectedSelection?: string,
  ): Promise<DesktopPreferences> {
    const file = this.fileFor(userId);
    const stored = await this.readStored(userId);
    const library = record(stored)?.unsplashLibrary;
    const previous = this.clientPreferences(stored);
    const showLogicalProcessors = preferences.showLogicalProcessors ?? previous.showLogicalProcessors ?? true;
    const previousSelection = previous.appearance?.wallpaperUnsplash ?? null;
    const requestedSelection = preferences.appearance?.wallpaperUnsplash;
    if (requestedSelection && requestedSelection !== previousSelection) {
      throw new BadRequestException('Choose an Unsplash wallpaper using the wallpaper picker.');
    }
    if (
      clientWrite &&
      requestedSelection === null &&
      (previousSelection !== null || expectedSelection !== undefined) &&
      expectedSelection !== (previousSelection ?? 'none')
    ) {
      throw new ConflictException('The selected wallpaper changed. Reload the selection and try again.');
    }
    const value = {
      ...DEFAULT_DESKTOP_PREFERENCES,
      ...preferences,
      showLogicalProcessors,
      wallpaperMode: preferences.wallpaperMode ?? (preferences.wallpaperPreset || preferences.appearance?.wallpaperImage ? 'custom' : 'theme'),
      mode: preferences.mode ?? (preferences.preset === 'graphite' ? 'dark' : 'system'),
      workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, ...preferences.workspace },
      appearance: normaliseDesktopAppearance(preferences.appearance),
    };
    value.appearance.wallpaperUnsplash = requestedSelection === null ? null : previousSelection;
    await this.writeState(file, library === undefined ? value : { ...value, unsplashLibrary: library });
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
