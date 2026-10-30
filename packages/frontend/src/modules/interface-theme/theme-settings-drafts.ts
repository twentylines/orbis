import {
  interfaceThemeSettingAllows,
  interfaceThemeSettingsEntryAllows,
  type InterfaceThemeDescriptor,
  type InterfaceThemeIdentity,
  type InterfaceThemeSettingsEntry,
  type InterfaceThemeSettingsState,
  type InterfaceThemeValue,
} from '@runtipi/common/schemas/interface-theme';
import { builtinInterfaceTheme, registeredInterfaceTheme } from '@runtipi/common/schemas/interface-theme-registry';
import { resolveInterfaceThemeSettings } from '@runtipi/common/schemas/interface-theme-resolution';
import { ThemeSettingsError, type ThemeSettingsClient, type ThemeSettingsSnapshot } from './theme-settings-api';

type Values = InterfaceThemeSettingsEntry['values'];
export type InterfaceThemeDraft = {
  identity: InterfaceThemeIdentity;
  descriptor: InterfaceThemeDescriptor;
  base: Values;
  values: Values;
  dirty: boolean;
};
export type InterfaceThemeSessionStatus = 'loading' | 'ready' | 'migration' | 'legacy' | 'error' | 'signed-out';
export type InterfaceThemeDraftSnapshot = {
  status: InterfaceThemeSessionStatus;
  pending: boolean;
  error: ThemeSettingsError | null;
  document: ThemeSettingsSnapshot | null;
  cached: InterfaceThemeSettingsState | null;
  drafts: InterfaceThemeDraft[];
};
const copy = (values: Values): Values => values.map((item) => ({ ...item }));
const equal = (first: Values, second: Values) =>
  first.length === second.length && first.every((item, index) => item.key === second[index]?.key && item.value === second[index]?.value);
const namespace = (descriptor: InterfaceThemeDescriptor) => `${descriptor.id}:${descriptor.settingsVersion}`;

export class InterfaceThemeDraftStore {
  private listeners = new Set<() => void>();
  private state: InterfaceThemeDraftSnapshot;
  private queue = Promise.resolve();
  private request = 0;
  private remoteEpoch = 0;

  constructor(
    private readonly client: ThemeSettingsClient,
    cached: InterfaceThemeSettingsState | null = null,
  ) {
    this.state = { status: 'loading', pending: false, error: null, document: null, cached, drafts: [] };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<InterfaceThemeDraftSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private failure(error: unknown) {
    const failure =
      error instanceof ThemeSettingsError
        ? error
        : new ThemeSettingsError('unavailable', 'Theme settings are unavailable. Your draft is kept; retry when connected.');
    this.publish({
      status: failure.kind === 'compatibility' ? 'legacy' : 'error',
      error: failure,
      ...(failure.kind === 'compatibility' ? { document: null, cached: null } : {}),
    });
  }
  disconnect() {
    this.request++;
    this.remoteEpoch++;
    const cached = this.state.document?.legacyMigration === 'complete' ? this.state.document.settings : this.state.cached;
    this.publish({ status: 'signed-out', pending: false, error: null, document: null, cached, drafts: [] });
  }
  private accept(document: ThemeSettingsSnapshot) {
    const drafts = this.state.drafts.map((draft) => {
      const base = resolveInterfaceThemeSettings(draft.identity, document.settings).values;
      const values = draft.dirty ? draft.values : base;
      return { ...draft, base, values, dirty: !equal(values, base) };
    });
    this.publish({
      document,
      drafts,
      cached: document.legacyMigration === 'complete' ? document.settings : null,
      status: document.legacyMigration === 'complete' ? 'ready' : 'migration',
      error: null,
    });
  }
  async load(signal?: AbortSignal) {
    if (this.state.pending) return;
    const request = ++this.request;
    this.remoteEpoch++;
    this.publish({ pending: true });
    try {
      const document = await this.client.read(signal);
      if (signal?.aborted || request !== this.request) return;
      if (this.state.document && document.revision < this.state.document.revision) return;
      this.accept(document);
    } catch (error) {
      if (!signal?.aborted && request === this.request) this.failure(error);
    } finally {
      if (request === this.request) this.publish({ pending: false });
    }
  }
  async migrate(signal?: AbortSignal) {
    if (!this.state.document || this.state.document.legacyMigration !== 'pending' || this.state.pending) return;
    const request = ++this.request;
    this.remoteEpoch++;
    this.publish({ pending: true });
    try {
      const document = await this.client.migrate(this.state.document.revision, signal);
      if (!signal?.aborted && request === this.request) this.accept(document);
    } catch (error) {
      if (!signal?.aborted && request === this.request) this.failure(error);
    } finally {
      if (request === this.request) this.publish({ pending: false });
    }
  }
  binding(identity: InterfaceThemeIdentity | null, snapshot = this.state): InterfaceThemeDraft | null {
    const descriptor = identity === null ? builtinInterfaceTheme : registeredInterfaceTheme(identity);
    if (!descriptor) return null;
    const existing = snapshot.drafts.find((draft) => namespace(draft.descriptor) === namespace(descriptor));
    const base = resolveInterfaceThemeSettings(identity, this.settings(snapshot) ?? { formatVersion: 1, entries: [] }).values;
    return existing
      ? { ...existing, descriptor, identity: { id: descriptor.id, version: descriptor.version } }
      : { identity: { id: descriptor.id, version: descriptor.version }, descriptor, base, values: base, dirty: false };
  }
  settings(snapshot = this.state): InterfaceThemeSettingsState | null {
    if (snapshot.document) return snapshot.document.legacyMigration === 'complete' ? snapshot.document.settings : null;
    return snapshot.cached;
  }
  preview(identity: InterfaceThemeIdentity | null, snapshot = this.state) {
    if (identity !== null && !registeredInterfaceTheme(identity)) return null;
    const settings = this.settings(snapshot);
    if (!settings) return null;
    const entries = [...settings.entries];
    for (const draft of snapshot.drafts) {
      const values = draft.values.map((item) => {
        const definition = draft.descriptor.settings.find((setting) => setting.key === item.key);
        return definition && interfaceThemeSettingAllows(definition, item.value)
          ? item
          : (draft.base.find((base) => base.key === item.key) ?? { key: item.key, value: definition?.default ?? null });
      });
      const entry = { id: draft.descriptor.id, settingsVersion: draft.descriptor.settingsVersion, values };
      const index = entries.findIndex((item) => item.id === entry.id && item.settingsVersion === entry.settingsVersion);
      if (index < 0) entries.push(entry);
      else entries[index] = entry;
    }
    return resolveInterfaceThemeSettings(identity, { formatVersion: 1, entries });
  }
  setValue(identity: InterfaceThemeIdentity | null, key: string, value: InterfaceThemeValue) {
    const draft = this.binding(identity);
    if (!draft || this.state.document?.legacyMigration !== 'complete' || this.state.pending) return false;
    const definition = draft.descriptor.settings.find((setting) => setting.key === key);
    if (!definition || !interfaceThemeSettingAllows(definition, value)) return false;
    const values = draft.values.map((item) => (item.key === key ? { key, value } : item));
    this.publish({
      drafts: [
        ...this.state.drafts.filter((item) => namespace(item.descriptor) !== namespace(draft.descriptor)),
        { ...draft, values, dirty: !equal(values, draft.base) },
      ],
    });
    return true;
  }
  setColourText(identity: InterfaceThemeIdentity | null, key: string, value: string) {
    const draft = this.binding(identity);
    if (!draft || this.state.pending || this.state.document?.legacyMigration !== 'complete' || value.length > 7) return false;
    if (!draft.descriptor.settings.some((setting) => setting.key === key && setting.kind === 'colour')) return false;
    const values = draft.values.map((item) => (item.key === key ? { key, value } : item));
    this.publish({
      drafts: [
        ...this.state.drafts.filter((item) => namespace(item.descriptor) !== namespace(draft.descriptor)),
        { ...draft, values, dirty: !equal(values, draft.base) },
      ],
    });
    return true;
  }
  setNumberText(identity: InterfaceThemeIdentity | null, key: string, text: string) {
    const draft = this.binding(identity);
    if (!draft || this.state.pending || this.state.document?.legacyMigration !== 'complete' || text.length > 12) return false;
    const definition = draft.descriptor.settings.find((setting) => setting.key === key && setting.kind === 'integer');
    if (!definition) return false;
    const number = text === '' ? null : Number(text);
    const value = interfaceThemeSettingAllows(definition, number) ? number : text;
    const values = draft.values.map((item) => (item.key === key ? { key, value } : item));
    this.publish({
      drafts: [
        ...this.state.drafts.filter((item) => namespace(item.descriptor) !== namespace(draft.descriptor)),
        { ...draft, values, dirty: !equal(values, draft.base) },
      ],
    });
    return true;
  }
  reset(identity: InterfaceThemeIdentity | null) {
    const draft = this.binding(identity);
    if (!draft || this.state.pending || this.state.document?.legacyMigration !== 'complete') return;
    const values = draft.descriptor.settings.map((setting) => ({ key: setting.key, value: setting.default }));
    this.publish({
      drafts: [
        ...this.state.drafts.filter((item) => namespace(item.descriptor) !== namespace(draft.descriptor)),
        { ...draft, values, dirty: !equal(values, draft.base) },
      ],
    });
  }
  discard(identity: InterfaceThemeIdentity | null) {
    const draft = this.binding(identity);
    if (draft && !this.state.pending)
      this.publish({ drafts: this.state.drafts.filter((item) => namespace(item.descriptor) !== namespace(draft.descriptor)) });
  }
  async prepare(identity: InterfaceThemeIdentity): Promise<(() => Promise<void>) | null> {
    const draft = this.binding(identity);
    if (!draft || this.state.status !== 'ready' || this.state.pending || this.state.document?.legacyMigration !== 'complete') return null;
    const values = copy(draft.values);
    if (
      !interfaceThemeSettingsEntryAllows(draft.descriptor, { id: draft.descriptor.id, settingsVersion: draft.descriptor.settingsVersion, values })
    ) {
      this.publish({
        error: new ThemeSettingsError(
          'validation',
          `Check the values in ${draft.descriptor.name} before saving. Unsaved theme drafts have been kept.`,
        ),
      });
      return null;
    }
    const epoch = this.remoteEpoch;
    return () => {
      const write = async () => {
        if (epoch !== this.remoteEpoch || !this.state.document || this.state.status !== 'ready')
          throw new ThemeSettingsError('conflict', 'Theme settings changed while preparing Save. Reload and review your draft.');
        this.publish({ pending: true });
        try {
          const document = await this.client.update({ expectedRevision: this.state.document.revision, theme: draft.identity, values });
          if (epoch !== this.remoteEpoch)
            throw new ThemeSettingsError('authentication', 'The browser session changed while saving. Reload before editing another account.');
          this.accept(document);
        } catch (error) {
          if (epoch === this.remoteEpoch) this.failure(error);
          throw error;
        } finally {
          if (epoch === this.remoteEpoch) this.publish({ pending: false });
        }
      };
      const result = this.queue.then(write, write);
      this.queue = result.catch(() => undefined);
      return result;
    };
  }
}
