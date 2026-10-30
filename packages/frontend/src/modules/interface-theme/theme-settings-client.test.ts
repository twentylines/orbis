/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';
import type { ThemeSettingsDocument, ThemeSettingsUpdate } from '@runtipi/common/schemas/theme-settings';
import { resolveInterfaceThemeSettings } from '@runtipi/common/schemas/interface-theme-resolution';
import {
  createThemeSettingsClient,
  decodeThemeSettingsSnapshot,
  ThemeSettingsError,
  type ThemeSettingsClient,
  type ThemeSettingsSnapshot,
} from './theme-settings-api';
import { InterfaceThemeDraftStore } from './theme-settings-drafts';
import { saveSettingsPlan } from '../settings/helpers/settings-save-plan';

const alpine = { id: 'alpine', version: '1.1.0' };
const tideline = { id: 'tideline', version: '1.1.0' };
function snapshot(document: Partial<ThemeSettingsDocument> = {}): ThemeSettingsSnapshot {
  const complete: ThemeSettingsDocument = {
    formatVersion: 1,
    revision: 0,
    legacyMigration: 'complete',
    settings: { formatVersion: 1, entries: [] },
    ...document,
  };
  return {
    ...complete,
    selected: alpine,
    current: resolveInterfaceThemeSettings(alpine, complete.settings),
    builtinFallback: resolveInterfaceThemeSettings(null, complete.settings),
  };
}
function fixture(initial = snapshot()) {
  let server = initial;
  const writes: ThemeSettingsUpdate[] = [];
  const client: ThemeSettingsClient = {
    read: async () => server,
    migrate: async () => {
      server = snapshot({ ...server, revision: server.revision + 1, legacyMigration: 'complete' });
      return server;
    },
    update: async (update) => {
      if (update.expectedRevision !== server.revision) throw new ThemeSettingsError('conflict', 'Reload the changed settings.');
      writes.push(update);
      const descriptor = resolveInterfaceThemeSettings(update.theme, server.settings).descriptor;
      server = snapshot({
        ...server,
        revision: server.revision + 1,
        settings: {
          formatVersion: 1,
          entries: [
            ...server.settings.entries.filter((entry) => entry.id !== descriptor.id || entry.settingsVersion !== descriptor.settingsVersion),
            { id: descriptor.id, settingsVersion: descriptor.settingsVersion, values: update.values },
          ],
        },
      });
      return server;
    },
  };
  return {
    store: new InterfaceThemeDraftStore(client),
    client,
    writes,
    setServer: (next: ThemeSettingsSnapshot) => {
      server = next;
    },
  };
}

describe('strict theme settings client', () => {
  test('accepts reviewed definitions and projections only, regardless of object key order', () => {
    const value = snapshot();
    expect(decodeThemeSettingsSnapshot(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(decodeThemeSettingsSnapshot(Object.fromEntries(Object.entries(value).reverse())).current.descriptor.id).toBe('alpine');
    for (const invalid of [
      { ...value, script: 'run()' },
      { ...value, current: { ...value.current, descriptor: { ...value.current.descriptor, implementation: 'external' } } },
      { ...value, current: { ...value.current, descriptor: { ...value.current.descriptor, settings: [] } } },
      { ...value, current: { ...value.current, values: [{ key: 'accent', value: '#000000' }] } },
      { ...value, settings: { formatVersion: 1, entries: [{ id: 'alpine', settingsVersion: 1, values: [{ key: 'panel-blur', value: 900 }] }] } },
      { ...value, builtinFallback: { ...value.builtinFallback, html: '<script>' } },
    ])
      expect(() => decodeThemeSettingsSnapshot(invalid)).toThrow('unsupported');
  });

  test('uses only the fixed same-origin API, rejects malformed bodies before sending and validates responses', async () => {
    const fetcher = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(snapshot()), { status: 200 }));
    const client = createThemeSettingsClient(fetcher as unknown as typeof fetch);
    await client.read();
    await client.update({ expectedRevision: 0, theme: alpine, values: [{ key: 'accent', value: '#123456' }] });
    await client.migrate(0);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(['/api/theme-settings', '/api/theme-settings', '/api/theme-settings/migrate']);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store', method: 'GET' });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ expectedRevision: 0, theme: alpine, values: [{ key: 'accent', value: '#123456' }] }),
    });
    await expect(client.migrate(-1)).rejects.toMatchObject({ kind: 'validation' });
    await expect(
      client.update({ expectedRevision: 0, theme: { ...alpine, url: 'https://example.invalid' }, values: [] } as ThemeSettingsUpdate),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test('keeps compatibility, authentication, conflict, validation and malformed responses distinct', async () => {
    for (const [status, kind] of [
      [404, 'compatibility'],
      [405, 'compatibility'],
      [401, 'authentication'],
      [403, 'authentication'],
      [409, 'conflict'],
      [400, 'validation'],
      [500, 'unavailable'],
    ] as const) {
      const client = createThemeSettingsClient((async () => new Response('{}', { status })) as unknown as typeof fetch);
      await expect(client.read()).rejects.toMatchObject({ kind, status });
    }
    for (const text of ['{', 'x'.repeat(524289), JSON.stringify({ ...snapshot(), javascript: 'run()' })]) {
      const client = createThemeSettingsClient((async () => new Response(text)) as unknown as typeof fetch);
      await expect(client.read()).rejects.toMatchObject({ kind: 'unsupported' });
    }
  });
});

describe('theme drafts and global Save preparation', () => {
  test('stages independent namespace drafts without writing and previews only the requested theme', async () => {
    const { store, writes } = fixture();
    await store.load();
    expect(store.setValue(alpine, 'accent', '#123456')).toBe(true);
    expect(store.setValue(tideline, 'panel-blur', 18)).toBe(true);
    expect(writes).toHaveLength(0);
    expect(store.preview(alpine)?.values.find((item) => item.key === 'accent')?.value).toBe('#123456');
    expect(store.preview(tideline)?.values.find((item) => item.key === 'accent')?.value).toBeNull();
    expect(store.getSnapshot().drafts.filter((draft) => draft.dirty)).toHaveLength(2);
    expect(store.setValue(alpine, 'unknown', true)).toBe(false);
    expect(store.setValue(alpine, 'panel-blur', 900)).toBe(false);
    expect(store.preview({ id: 'unknown', version: '1.0.0' })).toBeNull();
  });

  test('prepares every namespace before writing and chains fresh acknowledged revisions through global Save', async () => {
    const { store, writes } = fixture();
    await store.load();
    store.setValue(alpine, 'accent', '#123456');
    store.setValue(tideline, 'accent', '#654321');
    const entries = store
      .getSnapshot()
      .drafts.map((draft) => ({ section: 'customise' as const, dirty: draft.dirty, pending: false, prepare: () => store.prepare(draft.identity) }));
    expect(await saveSettingsPlan(entries)).toEqual({ saved: 2 });
    expect(writes.map((write) => write.expectedRevision)).toEqual([0, 1]);
    expect(store.getSnapshot().drafts.filter((draft) => draft.dirty)).toHaveLength(0);
    expect(store.getSnapshot().document?.revision).toBe(2);
  });

  test('keeps partial-save success and unsaved drafts when a later namespace conflicts', async () => {
    const { store, client, writes } = fixture();
    const original = client.update;
    client.update = async (update) => {
      if (update.theme.id === tideline.id) throw new ThemeSettingsError('conflict', 'Review the changed theme.');
      return original(update);
    };
    await store.load();
    store.setValue(alpine, 'accent', '#123456');
    store.setValue(tideline, 'accent', '#654321');
    const result = await saveSettingsPlan(
      store
        .getSnapshot()
        .drafts.map((draft) => ({ section: 'customise' as const, dirty: draft.dirty, pending: false, prepare: () => store.prepare(draft.identity) })),
    );
    expect(result).toEqual({ saved: 1, failed: 'customise' });
    expect(writes).toHaveLength(1);
    expect(store.binding(alpine)?.dirty).toBe(false);
    expect(store.binding(tideline)?.dirty).toBe(true);
    expect(store.getSnapshot().error?.kind).toBe('conflict');
  });

  test('retains invalid partial colour and numeric text, previews the last saved values and prevents all writes', async () => {
    const { store, writes } = fixture(
      snapshot({
        settings: {
          formatVersion: 1,
          entries: [
            {
              id: 'alpine',
              settingsVersion: 1,
              values: [
                { key: 'accent', value: '#445566' },
                { key: 'panel-opacity', value: 97 },
              ],
            },
          ],
        },
      }),
    );
    await store.load();
    expect(store.setColourText(alpine, 'accent', '#12')).toBe(true);
    expect(store.setNumberText(alpine, 'panel-opacity', '9')).toBe(true);
    expect(store.binding(alpine)?.values.find((item) => item.key === 'accent')?.value).toBe('#12');
    expect(store.preview(alpine)?.values.find((item) => item.key === 'accent')?.value).toBe('#445566');
    expect(store.preview(alpine)?.values.find((item) => item.key === 'panel-opacity')?.value).toBe(97);
    expect(await store.prepare(alpine)).toBeNull();
    expect(writes).toHaveLength(0);
    expect(store.binding(alpine)?.dirty).toBe(true);
    store.setColourText(alpine, 'accent', '#abcdef');
    store.setNumberText(alpine, 'panel-opacity', '95');
    const commit = await store.prepare(alpine);
    await commit?.();
    expect(store.binding(alpine)?.dirty).toBe(false);
  });

  test('keeps legacy appearance until explicit migration and preserves drafts during a read-only reload', async () => {
    const { store, setServer } = fixture(snapshot({ legacyMigration: 'pending' }));
    await store.load();
    expect(store.getSnapshot().status).toBe('migration');
    expect(store.preview(alpine)).toBeNull();
    expect(store.setValue(alpine, 'accent', '#123456')).toBe(false);
    await store.migrate();
    expect(store.getSnapshot().status).toBe('ready');
    store.setValue(alpine, 'accent', '#123456');
    setServer(
      snapshot({
        revision: 3,
        settings: { formatVersion: 1, entries: [{ id: 'alpine', settingsVersion: 1, values: [{ key: 'accent', value: '#654321' }] }] },
      }),
    );
    await store.load();
    expect(store.binding(alpine)?.values.find((item) => item.key === 'accent')?.value).toBe('#123456');
    expect(store.binding(alpine)?.base.find((item) => item.key === 'accent')?.value).toBe('#654321');
  });

  test('treats compatible package versions as one draft namespace, and supports defaults and discard', async () => {
    const { store, writes } = fixture();
    await store.load();
    store.setValue({ ...alpine, version: '1.0.0' }, 'accent', '#123456');
    expect(store.binding(alpine)?.identity).toEqual(alpine);
    expect(store.binding(alpine)?.values.find((item) => item.key === 'accent')?.value).toBe('#123456');
    store.reset(alpine);
    expect(store.binding(alpine)?.dirty).toBe(false);
    store.setValue(alpine, 'accent', '#123456');
    store.discard(alpine);
    expect(store.getSnapshot().drafts).toHaveLength(0);
    store.setValue({ ...alpine, version: '1.0.0' }, 'accent', '#123456');
    const commit = await store.prepare(alpine);
    await commit?.();
    expect(writes[0]?.theme).toEqual(alpine);
  });

  test('does not accept a completed save into another browser session', async () => {
    const { store, client } = fixture();
    await store.load();
    store.setValue(alpine, 'accent', '#123456');
    let finish: ((value: ThemeSettingsSnapshot) => void) | undefined;
    client.update = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const commit = await store.prepare(alpine);
    const pending = commit?.();
    await Promise.resolve();
    store.disconnect();
    finish?.(snapshot({ revision: 1 }));
    await expect(pending).rejects.toMatchObject({ kind: 'authentication' });
    expect(store.getSnapshot().document).toBeNull();
    expect(store.getSnapshot().status).toBe('signed-out');
    expect(store.getSnapshot().drafts).toHaveLength(0);
  });

  test('rejects a prepared save after an intervening remote refresh and keeps compatibility distinct', async () => {
    const { store, client, writes } = fixture();
    await store.load();
    store.setValue(alpine, 'accent', '#123456');
    const prepared = await store.prepare(alpine);
    await store.load();
    await expect(prepared?.()).rejects.toMatchObject({ kind: 'conflict' });
    expect(writes).toHaveLength(0);
    client.read = async () => {
      throw new ThemeSettingsError('compatibility', 'Shared appearance only.');
    };
    await store.load();
    expect(store.getSnapshot().status).toBe('legacy');
    expect(store.preview(alpine)).toBeNull();
    expect(store.getSnapshot().drafts.some((draft) => draft.dirty)).toBe(true);
  });
});
