import { describe, expect, test } from 'bun:test';
import { essentialFrameworkComponents, frameworkComponentIds, silentFrameworkSounds } from '@runtipi/common/schemas/theme-framework-registry';
import type { ThemeFrameworkDocument } from '@runtipi/common/schemas/theme-framework-contract';
import { ThemeSoundEngine, type SoundTransport } from './theme-sound-engine';

function document(): ThemeFrameworkDocument {
  return {
    schema: 'orbis.theme-framework.v1',
    id: 'contract-test',
    version: '1.0.0',
    name: 'Contract test',
    settingsVersion: 1,
    requires: { api: 1, releases: ['0.5.0-beta.3', '1.0.0'] },
    supportsUiRevisions: [],
    components: frameworkComponentIds.map((id) => ({ id, variant: 'standard' })),
    tokens: {
      colours: {
        background: '#ffffff',
        surface: '#ffffff',
        ink: '#111111',
        muted: '#444444',
        accent: '#2255bb',
        danger: '#a01010',
        focus: '#2255bb',
      },
      typography: { family: 'system', baseSize: 16, scale: 1 },
      spacing: { unit: 4, gap: 16, inset: 16 },
      shape: { radius: 16, borderWidth: 1 },
      motion: { duration: 180, curve: 'standard' },
    },
    modes: [],
    tokenRules: [],
    tokenBindings: [],
    icons: [],
    assets: [],
    settings: [
      { key: 'enabled', label: 'Enabled', group: 'appearance', kind: 'boolean', default: false },
      { key: 'size', label: 'Size', group: 'appearance', kind: 'integer', default: 0, min: 0, max: 10, step: 2 },
      { key: 'accent', label: 'Accent', group: 'appearance', kind: 'colour', default: null },
      {
        key: 'density',
        label: 'Density',
        group: 'appearance',
        kind: 'enum',
        default: 'normal',
        options: [
          { value: 'normal', label: 'Normal' },
          { value: 'compact', label: 'Compact' },
        ],
      },
    ],
    conditions: [],
    customisation: {
      hostControls: 'always',
      sections: [{ id: 'appearance', label: 'Appearance', settings: ['enabled', 'size', 'accent', 'density'] }],
      presets: [
        {
          id: 'initial',
          label: 'Initial',
          values: [
            { key: 'enabled', value: false },
            { key: 'size', value: 0 },
            { key: 'accent', value: null },
          ],
        },
      ],
    },
    layouts: (['phone', 'tablet', 'desktop'] as const).map((viewport) => ({
      viewport,
      columns: viewport === 'phone' ? 1 : 4,
      nodes: essentialFrameworkComponents.map((component, order) => ({
        id: component,
        kind: 'core',
        component,
        slot:
          component === 'shell.navigation'
            ? 'shell.footer'
            : component === 'shell.session'
              ? 'shell.header'
              : component === 'settings.recovery'
                ? 'settings.header'
                : 'shell.overlay',
        parent: null,
        anchor: 'viewport.safe',
        order,
        placement: { kind: 'host' },
      })),
    })),
    sounds: silentFrameworkSounds(),
  };
}

type Buffer = { durationMs: number; bytes: number };
function setup() {
  const calls = { read: 0, create: 0, resume: 0, decode: 0, play: 0, stop: 0, close: 0, suspend: 0, gain: 0 };
  let clock = 1000;
  let decode: () => Promise<Buffer> = async () => ({ durationMs: 300, bytes: 1024 });
  let resume: () => Promise<boolean> = async () => true;
  const transport: SoundTransport<Buffer> = {
    resume: () => {
      calls.resume++;
      return resume();
    },
    suspend: async () => {
      calls.suspend++;
    },
    decode: () => {
      calls.decode++;
      return decode();
    },
    play: (_buffer, gain) => {
      calls.play++;
      calls.gain = gain;
      return () => {
        calls.stop++;
      };
    },
    close: async () => {
      calls.close++;
    },
  };
  const engine = new ThemeSoundEngine(
    async () => {
      calls.read++;
      return new ArrayBuffer(40);
    },
    () => {
      calls.create++;
      return transport;
    },
    () => clock,
  );
  const theme = document();
  const assign = () => {
    theme.assets.push({ id: 'tone', kind: 'audio', mime: 'audio/ogg', path: 'assets/tone.ogg', sha256: 'b'.repeat(64), bytes: 40, durationMs: 300 });
    theme.sounds[0] = { event: 'session.login', asset: 'tone', gain: 0.5 };
    engine.setTheme(theme);
  };
  return {
    calls,
    engine,
    theme,
    assign,
    advance: () => {
      clock += 200;
    },
    setDecode: (fn: () => Promise<Buffer>) => {
      decode = fn;
    },
    setResume: (fn: () => Promise<boolean>) => {
      resume = fn;
    },
  };
}

describe('theme sound engine', () => {
  test('default and explicit silence never create audio or read bytes', async () => {
    const s = setup();
    s.engine.setTheme(s.theme);
    expect(await s.engine.unlock()).toBe(false);
    expect(await s.engine.emit('session.login')).toBe('silent');
    expect(s.calls.create).toBe(0);
    expect(s.calls.read).toBe(0);
    s.assign();
    s.theme.sounds[0] = { event: 'session.login', asset: null, gain: 0 };
    s.engine.setTheme(s.theme);
    expect(await s.engine.unlock()).toBe(false);
    expect(s.calls.create).toBe(0);
  });
  test('blocked activation, mute and volume gate playback; successful activation uses host gain and bounded rate', async () => {
    const s = setup();
    s.assign();
    s.setResume(async () => false);
    expect(await s.engine.unlock()).toBe(false);
    expect(await s.engine.emit('session.login')).toBe('silent');
    expect(s.calls.read).toBe(0);
    s.setResume(async () => true);
    expect(await s.engine.unlock()).toBe(true);
    s.engine.setPreferences(false, 0.4);
    expect(await s.engine.emit('session.login')).toBe('scheduled');
    expect(s.calls.gain).toBe(0.2);
    expect(await s.engine.emit('session.login')).toBe('limited');
    s.advance();
    expect(await s.engine.emit('session.login')).toBe('scheduled');
    expect(s.calls.decode).toBe(1);
    s.engine.setPreferences(true, 0.4);
    expect(s.calls.stop).toBe(2);
    expect(await s.engine.emit('session.login')).toBe('silent');
  });
  test('theme switch cancels stale decode, releases old transport and prevents overlapping decode', async () => {
    const s = setup();
    s.assign();
    await s.engine.unlock();
    let finish!: (value: Buffer) => void;
    s.setDecode(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = s.engine.emit('session.login');
    await Promise.resolve();
    s.engine.setTheme(s.theme);
    expect(s.calls.close).toBe(1);
    await s.engine.unlock();
    expect(await s.engine.emit('session.login')).toBe('limited');
    finish({ durationMs: 300, bytes: 1024 });
    expect(await pending).toBe('stale');
    expect(s.calls.play).toBe(0);
  });
  test('invalid decoded resources and decode failures never play; visibility requires new activation', async () => {
    const s = setup();
    s.assign();
    await s.engine.unlock();
    s.setDecode(async () => ({ durationMs: 301, bytes: 9 * 1024 * 1024 }));
    expect(await s.engine.emit('session.login')).toBe('failed');
    s.setDecode(async () => {
      throw new Error('decode');
    });
    expect(await s.engine.emit('session.login')).toBe('failed');
    await s.engine.setVisible(false);
    expect(s.calls.suspend).toBe(1);
    await s.engine.setVisible(true);
    expect(await s.engine.emit('session.login')).toBe('silent');
    expect(s.calls.play).toBe(0);
    s.engine.dispose();
    expect(s.calls.close).toBe(1);
  });
  test('active voices are capped and an interrupted decode cannot play after mute', async () => {
    const s = setup();
    s.assign();
    await s.engine.unlock();
    expect(await s.engine.emit('session.login')).toBe('scheduled');
    s.advance();
    expect(await s.engine.emit('session.login')).toBe('scheduled');
    s.advance();
    expect(await s.engine.emit('session.login')).toBe('scheduled');
    s.advance();
    expect(await s.engine.emit('session.login')).toBe('limited');
    s.engine.setPreferences(true, 1);
    expect(s.calls.stop).toBe(3);
    s.engine.setTheme(s.theme);
    s.engine.setPreferences(false, 1);
    await s.engine.unlock();
    let finish!: (value: Buffer) => void;
    s.setDecode(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = s.engine.emit('session.login');
    await Promise.resolve();
    s.engine.setPreferences(true, 1);
    s.engine.setPreferences(false, 1);
    finish({ durationMs: 300, bytes: 1024 });
    expect(await pending).toBe('stale');
    expect(s.calls.play).toBe(3);
  });
  test('rejected activation cannot unlock playback', async () => {
    const s = setup();
    s.assign();
    s.setResume(async () => {
      throw new Error('blocked');
    });
    expect(await s.engine.unlock()).toBe(false);
    expect(await s.engine.emit('session.login')).toBe('silent');
    expect(s.calls.read).toBe(0);
  });
});
