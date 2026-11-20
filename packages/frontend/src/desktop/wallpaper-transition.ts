import type { CSSProperties } from 'react';

export const wallpaperFadeDuration = 420;
export type WallpaperFrame = { id: number; source: string; style: CSSProperties; opacity: number; displayed: boolean; ready: boolean };

export class WallpaperTransition {
  private frames: WallpaperFrame[];
  private images = new Map<number, HTMLImageElement>();
  private sequence = 0;
  private latest = 0;
  private live = false;
  private reduced = false;
  private motion: { id: number; animation: Animation } | null = null;
  private revealed: number | null = null;

  constructor(
    source: string,
    style: CSSProperties,
    private render: (frames: WallpaperFrame[]) => void,
    private displayed: (image: HTMLImageElement) => void,
    private failed: () => void,
    private opacity: (image: HTMLImageElement) => number = (image) => Number.parseFloat(getComputedStyle(image).opacity),
    private reveal?: (image: HTMLImageElement) => void,
  ) {
    this.frames = [{ id: 0, source, style, opacity: 0, displayed: false, ready: false }];
  }

  snapshot() {
    return this.frames.map((frame) => ({ ...frame }));
  }

  attach(id: number, image: HTMLImageElement | null) {
    if (image) this.images.set(id, image);
    else this.images.delete(id);
  }

  activate() {
    this.live = true;
    if (this.frames.find((frame) => frame.id === this.latest)?.ready) this.start(this.latest);
  }

  deactivate() {
    this.live = false;
    this.freeze();
  }

  request(source: string, style: CSSProperties, reduced: boolean) {
    if (!this.live) return;
    this.reduced = reduced;
    const current = this.frames.find((frame) => frame.id === this.latest);
    if (current?.source === source) {
      if (JSON.stringify(current.style) !== JSON.stringify(style)) {
        current.style = style;
        this.render(this.snapshot());
      }
      if (reduced && this.motion) this.finish(current.ready ? current.id : this.motion.id);
      return;
    }
    const visible = this.frames.filter((frame) => frame.displayed || frame.opacity > 0 || frame.id === this.motion?.id);
    if (!this.motion && visible.length === 1 && visible[0]?.displayed && visible[0].source === source) {
      this.latest = visible[0].id;
      this.frames = [{ ...visible[0], style }];
      this.render(this.snapshot());
      return;
    }
    // Retain the visible composition; replace only an undecoded or queued choice.
    this.frames = this.frames.filter((frame) => frame.displayed || frame.opacity > 0 || frame.id === this.motion?.id);
    this.latest = ++this.sequence;
    this.frames.push({ id: this.latest, source, style, opacity: 0, displayed: false, ready: false });
    this.render(this.snapshot());
    if (reduced && this.motion) this.finish(this.motion.id);
  }

  needsDecode(id: number) {
    return this.live && this.frames.some((frame) => frame.id === id && !frame.ready);
  }

  loaded(id: number) {
    const frame = this.frames.find((frame) => frame.id === id);
    if (!this.live || !frame || frame.ready) return;
    frame.ready = true;
    if (id === this.latest) this.start(id);
  }

  error(id: number) {
    if (this.live && id === this.latest) this.failed();
  }

  private freeze() {
    const motion = this.motion;
    if (!motion) return;
    this.motion = null;
    const image = this.images.get(motion.id);
    const frame = this.frames.find((frame) => frame.id === motion.id);
    if (image && frame) {
      const value = this.opacity(image);
      frame.opacity = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      image.style.opacity = String(frame.opacity);
    }
    motion.animation.cancel();
  }

  private start(id: number) {
    const frame = this.frames.find((frame) => frame.id === id);
    const image = this.images.get(id);
    if (!this.live || !frame?.ready || !image || frame.displayed || this.motion?.id === id) return;
    const previous = this.frames.filter((item) => item.id !== id && (item.displayed || item.opacity > 0 || item.id === this.motion?.id));
    if (this.reduced || !previous.length || typeof image.animate !== 'function') {
      this.finish(id);
      return;
    }
    // Three visible layers preserve interrupted blends; one extra slot decodes the latest choice.
    if (previous.length >= 3) {
      const resume = previous.at(-1);
      if (!this.motion && resume && !resume.displayed) this.start(resume.id);
      return;
    }
    this.freeze();
    this.frames = this.frames.filter((item) => item.id === id || item.id === this.latest || item.displayed || item.opacity > 0);
    this.revealFrame(id, image);
    image.style.opacity = String(frame.opacity);
    this.render(this.snapshot());
    const animation = image.animate([{ opacity: frame.opacity }, { opacity: 1 }], {
      duration: wallpaperFadeDuration,
      easing: 'cubic-bezier(.22, .61, .36, 1)',
      fill: 'forwards',
    });
    const motion = { id, animation };
    this.motion = motion;
    void animation.finished.then(
      () => {
        if (this.live && this.motion === motion) this.finish(id);
      },
      () => undefined,
    );
  }

  private finish(id: number) {
    const frame = this.frames.find((frame) => frame.id === id);
    const image = this.images.get(id);
    if (!frame || !image) return;
    this.revealFrame(id, image);
    image.style.opacity = '1';
    const motion = this.motion;
    this.motion = null;
    motion?.animation.cancel();
    const pending = id !== this.latest ? this.frames.find((item) => item.id === this.latest) : undefined;
    this.frames = [{ ...frame, opacity: 1, displayed: true }, ...(pending ? [pending] : [])];
    this.render(this.snapshot());
    this.displayed(image);
    if (pending?.ready) this.start(pending.id);
  }

  private revealFrame(id: number, image: HTMLImageElement) {
    if (id === this.revealed) return;
    this.revealed = id;
    this.reveal?.(image);
  }
}
