import { ConfigurationService } from '@/core/config/configuration.service';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  interfaceThemeSettingsEntryAllows,
  type InterfaceThemeIdentity,
  type InterfaceThemeSettingsEntry,
} from '@runtipi/common/schemas/interface-theme';
import { builtinInterfaceTheme, registeredInterfaceTheme, legacyThemeVersions } from '@runtipi/common/schemas/interface-theme-registry';
import { resolveInterfaceThemeSettings } from '@runtipi/common/schemas/interface-theme-resolution';
import {
  themeSettingsDocumentSchema,
  themeSettingsMigrationSchema,
  themeSettingsUpdateSchema,
  type ThemeSettingsDocument,
} from '@runtipi/common/schemas/theme-settings';
import { DesktopPreferencesService } from '../desktop-preferences/desktop-preferences.service';
import { ThemePacksService } from '../theme-packs/theme-packs.service';
import { ThemeSettingsStore } from './theme-settings.store';

@Injectable()
export class ThemeSettingsService {
  private readonly writes = new Map<number, Promise<unknown>>();
  private readonly store: ThemeSettingsStore;
  constructor(
    config: ConfigurationService,
    private readonly packs: ThemePacksService,
    private readonly desktop: DesktopPreferencesService,
  ) {
    this.store = new ThemeSettingsStore(config.get('directories').dataDir);
  }

  private async read(userId: number) {
    const document = await this.store.read(userId);
    for (const entry of document.settings.entries) {
      const descriptor = this.namespaceDescriptor(entry);
      if (descriptor && !interfaceThemeSettingsEntryAllows(descriptor, entry))
        throw new ConflictException('Saved theme values need a compatibility review.');
    }
    return document;
  }

  private namespaceDescriptor(entry: InterfaceThemeSettingsEntry) {
    return [builtinInterfaceTheme, ...legacyThemeVersions.map((version) => registeredInterfaceTheme({ id: entry.id, version }))].find(
      (descriptor) => descriptor?.id === entry.id && descriptor.settingsVersion === entry.settingsVersion,
    );
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

  private assertRevision(document: ThemeSettingsDocument, expected: number) {
    if (document.revision !== expected) throw new ConflictException('Theme settings changed. Reload before saving.');
    if (document.revision >= Number.MAX_SAFE_INTEGER) throw new ConflictException('Theme settings revision needs review.');
  }

  private projection(document: ThemeSettingsDocument, selected: InterfaceThemeIdentity | null) {
    return {
      ...document,
      selected,
      current: resolveInterfaceThemeSettings(selected, document.settings),
      builtinFallback: resolveInterfaceThemeSettings(null, document.settings),
    };
  }

  async snapshot(userId: number) {
    const [document, { state }] = await Promise.all([this.read(userId), this.packs.snapshot(userId)]);
    return this.projection(document, state.selected);
  }

  async update(userId: number, input: unknown) {
    if (!themeSettingsUpdateSchema.allows(input)) throw new BadRequestException('Choose one theme namespace and valid settings.');
    return this.serialize(userId, async () => {
      const document = await this.read(userId);
      this.assertRevision(document, input.expectedRevision);
      const { state } = await this.packs.snapshot(userId);
      const descriptor = registeredInterfaceTheme(input.theme);
      const installed =
        input.theme.id === builtinInterfaceTheme.id ||
        state.installed.some((item) => item.manifest.id === input.theme.id && item.manifest.version === input.theme.version);
      if (!descriptor || !installed) throw new ConflictException('Install this registered theme version before changing its settings.');
      const entry = { id: descriptor.id, settingsVersion: descriptor.settingsVersion, values: input.values };
      if (!interfaceThemeSettingsEntryAllows(descriptor, entry)) throw new BadRequestException('These settings do not belong to this theme.');
      const entries = document.settings.entries.filter((item) => item.id !== entry.id || item.settingsVersion !== entry.settingsVersion);
      entries.push(entry);
      const next = { ...document, revision: document.revision + 1, settings: { formatVersion: 1 as const, entries } };
      if (!themeSettingsDocumentSchema.allows(next))
        throw new BadRequestException('Theme namespace limit reached. Review saved themes before adding another.');
      await this.store.write(userId, next);
      const latest = await this.packs.snapshot(userId);
      return this.projection(next, latest.state.selected);
    });
  }

  async migrate(userId: number, input: unknown) {
    if (!themeSettingsMigrationSchema.allows(input)) throw new BadRequestException('Confirm the displayed theme settings revision.');
    return this.serialize(userId, async () => {
      const document = await this.read(userId);
      const { state } = await this.packs.snapshot(userId);
      if (document.legacyMigration === 'complete') return this.projection(document, state.selected);
      this.assertRevision(document, input.expectedRevision);
      const legacy = await this.desktop.readSelected(userId).catch(() => {
        throw new ConflictException('Legacy appearance could not be safely read. Review it before migration.');
      });
      const mapping = [
        ['accent', 'accent'],
        ['surfaceOpacity', 'panel-opacity'],
        ['chromeOpacity', 'chrome-opacity'],
        ['glassBlur', 'panel-blur'],
        ['chromeBlur', 'chrome-blur'],
        ['glassTint', 'panel-tint'],
        ['transparency', 'transparency'],
        ['motion', 'motion'],
        ['lowEffects', 'low-effects'],
      ] as const;
      const entries = [...document.settings.entries];
      const active = state.selected ? registeredInterfaceTheme(state.selected) : null;
      for (const descriptor of [builtinInterfaceTheme, ...(active ? [active] : [])]) {
        const current = entries.find((entry) => entry.id === descriptor.id && entry.settingsVersion === descriptor.settingsVersion);
        const values = new Map(mapping.map(([oldKey, key]) => [key as string, legacy.appearance?.[oldKey] ?? null]));
        if (descriptor.kind === 'builtin') values.set('palette', legacy.preset);
        for (const item of current?.values ?? []) values.set(item.key, item.value);
        const entry = { id: descriptor.id, settingsVersion: descriptor.settingsVersion, values: [...values].map(([key, value]) => ({ key, value })) };
        if (!interfaceThemeSettingsEntryAllows(descriptor, entry))
          throw new ConflictException('Legacy appearance needs a compatibility review before migration.');
        const index = entries.findIndex((item) => item.id === entry.id && item.settingsVersion === entry.settingsVersion);
        if (index < 0) entries.push(entry);
        else entries[index] = entry;
      }
      const next = {
        ...document,
        revision: document.revision + 1,
        legacyMigration: 'complete' as const,
        settings: { formatVersion: 1 as const, entries },
      };
      if (!themeSettingsDocumentSchema.allows(next)) throw new ConflictException('Theme namespaces need review before migration.');
      await this.store.write(userId, next);
      const latest = await this.packs.snapshot(userId);
      return this.projection(next, latest.state.selected);
    });
  }
}
