import { resolveThemeFrameworkSound } from '@runtipi/common/schemas/theme-framework-compatibility';
import { frameworkSoundEventIds, type FrameworkSoundEventId } from '@runtipi/common/schemas/theme-framework-registry';
import type { FrameworkAsset, ThemeFrameworkDocument } from '@runtipi/common/schemas/theme-framework-contract';
import { validateThemeFrameworkDocument } from '@runtipi/common/schemas/theme-framework-validation';

type AudioAsset = Extract<FrameworkAsset, { kind: 'audio' }>;
type Decoded = { durationMs: number; bytes: number };
export interface SoundTransport<T extends Decoded> {
  resume(): Promise<boolean>;
  suspend(): Promise<void>;
  decode(bytes: ArrayBuffer): Promise<T>;
  play(buffer: T, gain: number, ended: () => void): () => void;
  close(): Promise<void>;
}
type Reader = (asset: AudioAsset, signal: AbortSignal) => Promise<ArrayBuffer>;
type Result = 'scheduled' | 'silent' | 'blocked' | 'limited' | 'stale' | 'failed';
const MAX_ENCODED = 2 * 1024 * 1024;
const MAX_DECODED = 8 * 1024 * 1024;
const MAX_DURATION_MS = 10_000;
const MAX_CACHE = 4;
const MAX_ACTIVE = 3;
const MIN_INTERVAL_MS = 100;

export class ThemeSoundEngine<T extends Decoded> {
  private document: ThemeFrameworkDocument | null = null;
  private transport: SoundTransport<T> | null = null;
  private cache = new Map<string, T>();
  private active = new Set<() => void>();
  private controller = new AbortController();
  private generation = 0;
  private unlocked = false;
  private visible = true;
  private muted = false;
  private volume = 1;
  private pending = false;
  private lastStart = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(
    private readonly reader: Reader,
    private readonly createTransport: () => SoundTransport<T>,
    private readonly now = () => performance.now(),
  ) {}

  setTheme(value: unknown): void {
    const result = validateThemeFrameworkDocument(value);
    if (!result.valid) throw new TypeError('Invalid theme framework document');
    this.reset();
    this.document = structuredClone(result.document);
  }

  private reset(): void {
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.unlocked = false;
    this.cache.clear();
    for (const stop of this.active) stop();
    this.active.clear();
    const previous = this.transport;
    this.transport = null;
    if (previous) void previous.close().catch(() => undefined);
  }

  setPreferences(muted: boolean, volume: number): void {
    const next = Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : 0;
    if (muted !== this.muted || next !== this.volume) {
      this.generation++;
      this.controller.abort();
      this.controller = new AbortController();
      this.stopAll();
    }
    this.muted = muted;
    this.volume = next;
  }

  private stopAll(): void {
    for (const stop of this.active) stop();
    this.active.clear();
  }

  async setVisible(visible: boolean): Promise<void> {
    this.visible = visible;
    if (!visible) {
      this.generation++;
      this.controller.abort();
      this.controller = new AbortController();
      this.stopAll();
      this.unlocked = false;
      if (this.transport) await this.transport.suspend().catch(() => undefined);
    }
  }

  // Call synchronously from a trusted user gesture. Browser policy can still refuse it.
  async unlock(): Promise<boolean> {
    if (this.disposed || !this.visible || this.muted || this.volume <= 0 || !this.document?.sounds.some((sound) => sound.asset && sound.gain > 0))
      return false;
    const generation = this.generation;
    this.unlocked = false;
    try {
      if (!this.transport) this.transport = this.createTransport();
      const transport = this.transport;
      const running = await transport.resume();
      if (generation !== this.generation || !this.visible || this.disposed || this.muted || this.volume <= 0) {
        if (!this.visible && this.transport === transport) await transport.suspend().catch(() => undefined);
        return false;
      }
      this.unlocked = running;
      return running;
    } catch {
      return false;
    }
  }

  async emit(event: FrameworkSoundEventId): Promise<Result> {
    if (!frameworkSoundEventIds.includes(event) || !this.document || this.disposed) return 'silent';
    const resolved = resolveThemeFrameworkSound(this.document, event, {
      gestureUnlocked: this.unlocked && this.visible,
      muted: this.muted,
      volume: this.volume,
    });
    if (!resolved || resolved.asset.kind !== 'audio') return 'silent';
    const transport = this.transport;
    if (!transport || !this.unlocked) return 'blocked';
    const time = this.now();
    if (this.pending || this.active.size >= MAX_ACTIVE || !Number.isFinite(time) || time - this.lastStart < MIN_INTERVAL_MS) return 'limited';
    if (resolved.asset.bytes > MAX_ENCODED || resolved.asset.durationMs > MAX_DURATION_MS) return 'limited';
    this.pending = true;
    const generation = this.generation;
    const signal = this.controller.signal;
    const stale = () =>
      generation !== this.generation || signal.aborted || this.disposed || !this.visible || !this.unlocked || this.muted || this.volume <= 0;
    try {
      let buffer = this.cache.get(resolved.asset.id);
      if (!buffer) {
        const bytes = await this.reader(resolved.asset, signal);
        if (stale()) return 'stale';
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== resolved.asset.bytes || bytes.byteLength > MAX_ENCODED) return 'failed';
        buffer = await transport.decode(bytes);
        if (stale()) return 'stale';
        if (
          !Number.isFinite(buffer.durationMs) ||
          buffer.durationMs <= 0 ||
          buffer.durationMs > MAX_DURATION_MS ||
          buffer.durationMs > resolved.asset.durationMs + 100 ||
          !Number.isSafeInteger(buffer.bytes) ||
          buffer.bytes <= 0 ||
          buffer.bytes > MAX_DECODED
        )
          return 'failed';
        while (this.cache.size >= MAX_CACHE || [...this.cache.values()].reduce((sum, item) => sum + item.bytes, 0) + buffer.bytes > MAX_DECODED) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) return 'failed';
          this.cache.delete(oldest);
        }
        this.cache.set(resolved.asset.id, buffer);
      }
      if (stale()) return 'stale';
      const startTime = this.now();
      if (!Number.isFinite(startTime) || startTime - this.lastStart < MIN_INTERVAL_MS || this.active.size >= MAX_ACTIVE) return 'limited';
      const current = resolveThemeFrameworkSound(this.document, event, { gestureUnlocked: true, muted: this.muted, volume: this.volume });
      if (!current) return 'stale';
      let stop: (() => void) | undefined;
      let ended = false;
      stop = transport.play(buffer, current.gain, () => {
        ended = true;
        if (stop) this.active.delete(stop);
      });
      if (!ended) this.active.add(stop);
      this.lastStart = startTime;
      return 'scheduled';
    } catch {
      return stale() ? 'stale' : 'failed';
    } finally {
      this.pending = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.document = null;
  }
}

export type BrowserDecodedSound = Decoded & { buffer: AudioBuffer };
export function createBrowserSoundTransport(): SoundTransport<BrowserDecodedSound> {
  const context = new AudioContext();
  return {
    async resume() {
      await context.resume();
      return context.state === 'running';
    },
    async suspend() {
      if (context.state === 'running') await context.suspend();
    },
    async decode(bytes) {
      const buffer = await context.decodeAudioData(bytes);
      return { buffer, durationMs: buffer.duration * 1000, bytes: buffer.length * buffer.numberOfChannels * 4 };
    },
    play(decoded, gain, ended) {
      if (context.state !== 'running') throw new Error('Audio context is not running');
      const source = context.createBufferSource();
      const level = context.createGain();
      source.buffer = decoded.buffer;
      level.gain.value = gain;
      source.connect(level).connect(context.destination);
      source.onended = () => {
        source.disconnect();
        level.disconnect();
        ended();
      };
      try {
        source.start();
      } catch (error) {
        source.onended = null;
        source.disconnect();
        level.disconnect();
        throw error;
      }
      return () => {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // The source may already have ended.
        }
        source.disconnect();
        level.disconnect();
      };
    },
    async close() {
      if (context.state !== 'closed') await context.close();
    },
  };
}
