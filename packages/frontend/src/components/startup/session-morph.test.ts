import { expect, test } from 'bun:test';
import {
  beginSessionMorph,
  contractSessionMorph,
  currentSessionMorphExit,
  expandSessionMorph,
  hasActiveSessionMorph,
  matchSessionBackdrop,
  sessionClip,
  sessionExpansionSteps,
  sessionOrbBounds,
  settleSessionMorphViewport,
} from './session-morph';

test('session geometry stays within narrow/short viewports and clips real source coordinates', () => {
  for (const [width, height] of [
    [1280, 800],
    [320, 640],
    [640, 240],
  ]) {
    const box = sessionOrbBounds(width ?? 0, height ?? 0);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.left + box.width).toBeLessThanOrEqual(width ?? 0);
    expect(box.top + box.height).toBeLessThanOrEqual(height ?? 0);
  }
  expect(sessionClip({ left: 0, top: -100, width: 800, height: 1000 }, { left: 312, top: 212, width: 176, height: 176 }, 88)).toBe(
    'inset(312px 312px 512px 312px round 88px)',
  );
});

test('logout grows equally on both axes until the shorter card edge is reached, without overshooting', () => {
  for (const card of [
    { left: 200, top: 120, width: 488, height: 550 },
    { left: 24, top: 32, width: 272, height: 600 },
    { left: 180, top: 24, width: 600, height: 280 },
  ]) {
    const orb = sessionOrbBounds(800, 700);
    const steps = sessionExpansionSteps(orb, card, 24);
    expect(steps[0]?.box).toEqual(orb);
    expect(steps.at(-1)?.box).toEqual(card);
    expect(steps.at(-1)?.radius).toBe(24);
    for (const { box } of steps) {
      expect(box.width).toBeLessThanOrEqual(card.width);
      expect(box.height).toBeLessThanOrEqual(card.height);
      if (box.width < card.width && box.height < card.height) expect(box.width).toBe(box.height);
    }
  }
});

function harness() {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const set = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const box = { left: 0, top: 0, width: 800, height: 600 };
  const properties = new Map<string, string>();
  let held = false;
  const element = (bounds = box) => {
    const calls: Array<{ frames: Keyframe[]; timing: KeyframeAnimationOptions; animation: Animation }> = [];
    return {
      calls,
      draft: 'retained draft',
      isConnected: true,
      dataset: { desktopPreset: 'ocean', desktopMode: 'dark' },
      inert: false,
      children: [] as HTMLElement[],
      style: {
        position: '',
        zIndex: '',
        clipPath: '',
        opacity: '',
        background: '',
        boxShadow: '',
        transformOrigin: '',
        overflow: '',
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
      getBoundingClientRect: () => bounds,
      querySelector: (_selector: string): unknown => null,
      querySelectorAll: (_selector: string): unknown[] => [],
      closest: () => ({ style: { setProperty: (name: string, value: string) => properties.set(name, value) } }),
      getAnimations: () => calls.map(({ animation }) => animation),
      animate: (frames: Keyframe[], timing: KeyframeAnimationOptions) => {
        let finish: () => void = () => undefined;
        let reject: () => void = () => undefined;
        const finished = held
          ? new Promise<void>((resolve, failed) => {
              finish = resolve;
              reject = () => failed(new Error('cancelled'));
            })
          : Promise.resolve();
        const animation = { finished, cancel: () => reject(), finish: () => finish(), startTime: null } as unknown as Animation;
        calls.push({ frames, timing, animation });
        return animation;
      },
    };
  };
  const source = element();
  const shell = element();
  const target = element();
  const cardBox = { left: 200, top: 120, width: 400, height: 360 };
  const card = element(cardBox);
  const targetCard = element(cardBox);
  card.children.push(element() as unknown as HTMLElement, element() as unknown as HTMLElement);
  targetCard.children.push(element() as unknown as HTMLElement, element() as unknown as HTMLElement);
  source.querySelector = (selector: string) => (selector === '.card' ? card : null);
  target.querySelector = (selector: string) => (selector === '.card' ? targetCard : null);
  const root = { dataset: {} as Record<string, string> };
  const win = Object.assign(new EventTarget(), {
    visualViewport: undefined as { width: number; height: number; offsetLeft: number; offsetTop: number } | undefined,
  });
  set('window', win);
  set('document', { documentElement: root, timeline: { currentTime: 42 }, querySelector: () => source });
  set('innerWidth', 800);
  set('innerHeight', 600);
  set('getComputedStyle', (node?: { computedStyle?: Record<string, string> }) => ({
    position: 'relative',
    borderTopLeftRadius: '18px',
    backgroundColor: '#101820',
    background: 'rgba(0, 0, 0, 0.18)',
    boxShadow: '0px 8px 24px rgba(0, 0, 0, 0.2)',
    backdropFilter: 'blur(28px)',
    objectFit: 'cover',
    objectPosition: '50% 0%',
    filter: 'none',
    transform: 'none',
    getPropertyValue: (name: string) => properties.get(name) ?? '',
    ...node?.computedStyle,
  }));
  return {
    source,
    shell,
    target,
    card,
    targetCard,
    root,
    win,
    properties,
    holdAnimations: () => {
      held = true;
    },
    restore: () => {
      currentSessionMorphExit().cancel();
      for (const [name, previous] of saved) {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('captures one source palette with its wallpaper and refreshes it only for a new session morph', () => {
  const h = harness();
  try {
    h.properties.set('--desktop-accent', 'rgb(40, 90, 150)');
    h.properties.set('--desktop-surface', 'rgb(10, 20, 30)');
    h.properties.set('--orbis-loading-size', '320px');
    const first = beginSessionMorph('signing-in');
    expect(first?.appearance?.choice).toMatchObject({ preset: 'ocean', mode: 'dark' });
    expect(first?.appearance?.colours).toEqual({ '--desktop-accent': 'rgb(40, 90, 150)', '--desktop-surface': 'rgb(10, 20, 30)' });
    h.source.dataset.desktopPreset = 'blush';
    h.source.dataset.desktopMode = 'light';
    h.properties.set('--desktop-accent', 'rgb(180, 60, 110)');
    h.properties.set('--desktop-surface', 'rgb(250, 230, 240)');
    expect(first?.appearance?.choice.preset).toBe('ocean');
    expect(first?.appearance?.colours['--desktop-accent']).toBe('rgb(40, 90, 150)');
    const second = beginSessionMorph('signing-in');
    expect(first?.cancelled).toBe(true);
    expect(second?.appearance?.choice).toMatchObject({ preset: 'blush', mode: 'light' });
    expect(second?.appearance?.colours['--desktop-accent']).toBe('rgb(180, 60, 110)');
    expect(second?.appearance?.colours).not.toHaveProperty('--orbis-loading-size');
  } finally {
    h.restore();
  }
});

test('real source waits for the prepared shell, contracts on one clock, and cancellation restores its state', async () => {
  const h = harness();
  try {
    const model = beginSessionMorph('signing-in');
    if (!model) throw new Error('missing model');
    let finished = false;
    void model.finished.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(hasActiveSessionMorph()).toBe(true);
    expect(h.source.inert).toBe(true);
    expect(h.source.style.zIndex).toBe('99');
    contractSessionMorph(model, h.shell as unknown as HTMLElement, false);
    await model.finished;
    expect(h.source.calls).toHaveLength(0);
    expect(h.shell.calls).toHaveLength(1);
    expect(h.shell.calls[0]?.timing.duration).toBe(640);
    expect(h.shell.calls[0]?.animation.startTime).toBe(42);
    expect(h.card.calls).toHaveLength(1);
    expect(h.card.calls[0]?.animation.startTime).toBe(42);
    expect(h.card.calls[0]?.timing).toEqual({ duration: 640, easing: 'cubic-bezier(.22,.72,.18,1)', fill: 'both' });
    expect(h.card.calls[0]?.frames[0]).toMatchObject({ transform: 'none', borderRadius: '18px', width: '400px', height: '360px' });
    expect(h.card.calls[0]?.frames.at(-1)).toMatchObject({ transform: 'none', width: '176px', height: '176px', borderRadius: '88px' });
    expect(h.shell.calls[0]?.frames[0]).toMatchObject({ opacity: 0, width: '400px', height: '360px', borderRadius: '18px' });
    expect(h.shell.calls[0]?.frames.at(-1)).toMatchObject({ opacity: 1, width: '176px', height: '176px', borderRadius: '88px' });
    for (const frame of h.shell.calls[0]?.frames ?? []) {
      expect(Number.parseFloat(String(frame.borderRadius))).toBeGreaterThan(0);
      expect(frame.transform).toBe('none');
      expect(frame).not.toHaveProperty('clipPath');
      expect(frame).not.toHaveProperty('backdropFilter');
    }
    expect(h.shell.style).toHaveProperty('backdropFilter', 'blur(28px)');
    expect(h.shell.style.background).toBe('rgba(0, 0, 0, 0.18)');
    expect(h.shell.style.boxShadow).toBe('none');
    expect(h.card.calls[0]?.frames.at(-1)?.boxShadow).toBe('none');
    expect(h.card.style.position).toBe('fixed');
    expect(h.card.style.transformOrigin).toBe('0 0');
    expect(h.card.style.overflow).toBe('hidden');
    expect(h.source.calls).toHaveLength(0);
    expect(h.source.draft).toBe('retained draft');
    model.cancel();
    expect(h.source.style.zIndex).toBe('');
    expect(h.source.style.opacity).toBe('');
    expect(h.source.inert).toBe(false);
    expect(h.card.style.transformOrigin).toBe('');
    expect(h.card.style.overflow).toBe('');
    expect(hasActiveSessionMorph()).toBe(false);
    expect(h.root.dataset.orbisSessionMorph).toBeUndefined();
  } finally {
    h.restore();
  }
});

test('sign-in glass has a round base before the animation applies and after its effect is removed', async () => {
  const h = harness();
  h.holdAnimations();
  try {
    const model = beginSessionMorph('signing-in');
    if (!model) throw new Error('missing model');
    contractSessionMorph(model, h.shell as unknown as HTMLElement, false);
    expect(h.shell.style).toMatchObject({
      width: '176px',
      height: '176px',
      borderRadius: '88px',
      opacity: 0,
      backdropFilter: 'blur(28px)',
    });
    for (const animation of model.animations) animation.finish();
    await model.finished;
    expect(h.shell.style).toMatchObject({ width: '176px', height: '176px', borderRadius: '88px', opacity: 1 });
  } finally {
    h.restore();
  }
});

test('the shared backdrop reuses the already loaded wallpaper and its actual appearance without a new service contract', () => {
  const h = harness();
  try {
    const card = h.source.querySelector('.card');
    const image = { complete: true, naturalWidth: 800, currentSrc: '/fixtures/wallpaper.svg', src: '/fixtures/wallpaper.svg' };
    Object.assign(h.source, {
      querySelector: (selector: string) => (selector.includes('img[') ? image : card),
      querySelectorAll: () => [image],
    });
    const model = beginSessionMorph('signing-in');
    expect(model?.backdrop?.image).toBe(image as unknown as HTMLImageElement);
    expect(model?.backdrop?.src).toBe('/fixtures/wallpaper.svg');
    expect(model?.backdrop?.style).toEqual({ objectFit: 'cover', objectPosition: '50% 0%', filter: 'none', transform: 'none' });
    expect(model?.background).toBe('#101820');
    expect(model?.shade).toBe('rgba(0, 0, 0, 0.18)');
  } finally {
    h.restore();
  }
});

test('both session directions retain the displayed wallpaper while a decoded replacement remains hidden', () => {
  const h = harness();
  try {
    const card = h.source.querySelector('.card');
    const displayed = { complete: true, naturalWidth: 800, src: '/displayed.webp', computedStyle: { opacity: '1' } };
    const candidate = { complete: true, naturalWidth: 800, src: '/pending.webp', computedStyle: { opacity: '0' } };
    Object.assign(h.source, {
      querySelector: (selector: string) => (selector.includes('img[') ? displayed : selector === '.card' ? card : null),
      querySelectorAll: () => [displayed, candidate],
    });
    for (const kind of ['signing-in', 'logging-out'] as const) {
      expect(beginSessionMorph(kind)?.backdrop?.src).toBe('/displayed.webp');
    }
    // A marker-free source can still retain its visible image, never its hidden last child.
    Object.assign(h.source, { querySelector: (selector: string) => (selector === '.card' ? card : null) });
    expect(beginSessionMorph('signing-in')?.backdrop?.src).toBe('/displayed.webp');
    displayed.computedStyle.opacity = '0';
    expect(beginSessionMorph('signing-in')?.backdrop).toBeNull();
  } finally {
    h.restore();
  }
});

test('a fast sign-in holds only the auth entrance and resumes it when the handoff is cancelled', () => {
  const h = harness();
  let paused = 0;
  let resumed = 0;
  let unrelated = 0;
  const entrance = {
    id: 'orbis-auth-enter',
    playState: 'running',
    pause: () => {
      paused++;
      entrance.playState = 'paused';
    },
    play: () => {
      resumed++;
      entrance.playState = 'running';
    },
  };
  try {
    Object.assign(h.source, {
      getAnimations: () => [
        entrance,
        {
          id: 'other-animation',
          playState: 'running',
          pause: () => {
            unrelated++;
          },
        },
      ],
    });
    const model = beginSessionMorph('signing-in');
    expect(paused).toBe(1);
    expect(unrelated).toBe(0);
    model?.cancel();
    expect(resumed).toBe(1);
  } finally {
    h.restore();
  }
});

test('reduced motion and missing animation capability keep the same pending contract without moving layers', async () => {
  for (const [reduced, kind] of [
    [true, 'signing-in'],
    [false, 'signing-in'],
    [true, 'logging-out'],
    [false, 'logging-out'],
  ] as const) {
    const h = harness();
    try {
      const model = beginSessionMorph(kind);
      if (!model) throw new Error('missing model');
      if (!reduced) Object.assign(h.shell, { animate: undefined });
      contractSessionMorph(model, h.shell as unknown as HTMLElement, reduced);
      await model.finished;
      expect(h.root.dataset.orbisSessionMorph).toBe('waiting');
      expect(h.source.calls).toHaveLength(0);
      expect(h.shell.calls).toHaveLength(0);
      expect(h.shell.style).toMatchObject({ width: '176px', height: '176px', borderRadius: '88px', opacity: 1 });
      expect(h.source.style.opacity).toBe('0');
      expect(h.source.draft).toBe('retained draft');
    } finally {
      h.restore();
    }
  }
});

test('logout fades the workspace in place while the circular emblem stays round', async () => {
  const h = harness();
  try {
    const model = beginSessionMorph('logging-out');
    if (!model) throw new Error('missing model');
    contractSessionMorph(model, h.shell as unknown as HTMLElement, false);
    await model.finished;
    expect(h.source.calls[0]?.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(h.shell.calls[0]?.frames[0]?.transform).toBe('scale(.94)');
    expect(h.shell.calls[0]?.frames.at(-1)?.transform).toBe('none');
    expect(h.card.calls).toHaveLength(0);
  } finally {
    h.restore();
  }
});

test('login appearance is copied before expansion while the area around the session circle stays transparent', () => {
  const h = harness();
  try {
    const properties = new Map<string, string>();
    const underlay = { style: { background: '' } };
    const cover = {
      style: { background: '', setProperty: (key: string, value: string) => properties.set(key, value) },
      dataset: {} as Record<string, string>,
      querySelector: () => underlay,
    };
    Object.assign(h.shell, { closest: () => cover });
    Object.assign(h.target, { dataset: { desktopMode: 'dark', desktopPreset: 'sage' } });
    const card = h.targetCard;
    h.target.querySelector = (selector: string) => (selector === '.card' ? card : underlay);
    matchSessionBackdrop(h.shell as unknown as HTMLElement, h.target as unknown as HTMLElement, true);
    expect(cover.style.background).toBe('transparent');
    expect(cover.dataset).toEqual({ desktopMode: 'dark', desktopPreset: 'sage' });
    expect(underlay.style.background).toBe('rgba(0, 0, 0, 0.18)');
    expect(properties.get('--orbis-session-shade')).toBe('rgba(0, 0, 0, 0.18)');
  } finally {
    h.restore();
  }
});

test('viewport changes settle onto a visible orb without leaving a stale clip or an unbounded animation list', async () => {
  const h = harness();
  try {
    const model = beginSessionMorph('signing-in');
    if (!model) throw new Error('missing model');
    contractSessionMorph(model, h.shell as unknown as HTMLElement, false);
    h.win.visualViewport = { width: 320, height: 300, offsetLeft: 0, offsetTop: 0 };
    settleSessionMorphViewport(model, h.shell as unknown as HTMLElement);
    await model.finished;
    expect(model.orb).toEqual({ left: 90, top: 80, width: 140, height: 140 });
    expect(model.animations).toHaveLength(0);
    expect(h.properties.get('--orbis-session-status-top')).toBe('244px');
    expect(h.properties.get('--orbis-loading-size')).toBe('140px');
    expect(h.shell.style).toMatchObject({ left: '90px', top: '80px', width: '140px', height: '140px', transform: 'none', opacity: 1 });
  } finally {
    h.restore();
  }
});

test('expansion reveals the actual login card and keeps its lift until the persistent cover is removed', async () => {
  const h = harness();
  try {
    const restore = await expandSessionMorph(h.shell as unknown as HTMLElement, h.target as unknown as HTMLElement, false);
    expect(h.target.calls).toHaveLength(1);
    expect(h.target.calls[0]?.timing.duration).toBe(640);
    expect(h.target.calls[0]?.frames.at(-1)?.clipPath).toBe('inset(120px 200px 120px 200px round 18px)');
    expect(h.targetCard.calls).toHaveLength(0);
    expect(h.shell.calls[0]?.frames.at(-1)).toMatchObject({
      width: '400px',
      height: '360px',
      borderRadius: '18px',
      transform: 'none',
      opacity: 0,
    });
    expect(h.target.style.zIndex).toBe('101');
    expect(h.target.inert).toBe(true);
    expect(h.target.draft).toBe('retained draft');
    restore?.();
    expect(h.target.style.zIndex).toBe('');
    expect(h.target.inert).toBe(false);
  } finally {
    h.restore();
  }
});

test('the exit handshake remains pending until the actual card and its contents have completed', async () => {
  const h = harness();
  h.holdAnimations();
  try {
    const model = beginSessionMorph('signing-in');
    if (!model) throw new Error('missing model');
    const exit = currentSessionMorphExit();
    let navigated = false;
    void exit.finished.then(() => {
      navigated = true;
    });
    contractSessionMorph(model, h.shell as unknown as HTMLElement, false);
    h.shell.calls[0]?.animation.finish();
    expect(h.shell.style).toHaveProperty('backdropFilter', 'blur(28px)');
    expect(h.source.style.opacity).toBe('');
    await Promise.resolve();
    expect(navigated).toBe(false);
    expect(model.contracted).toBe(false);
    h.card.calls[0]?.animation.finish();
    await Promise.resolve();
    expect(navigated).toBe(false);
    for (const animation of model.animations) animation.finish();
    await exit.finished;
    await Promise.resolve();
    expect(navigated).toBe(true);
    expect(model.contracted).toBe(true);
  } finally {
    h.restore();
  }
});

test('interrupted contraction releases the waiting handshake and restores the same form and card', async () => {
  const h = harness();
  h.holdAnimations();
  try {
    h.card.style.transformOrigin = '50% 50%';
    h.card.style.overflow = 'visible';
    h.source.style.clipPath = 'none';
    const model = beginSessionMorph('signing-in');
    if (!model) throw new Error('missing model');
    contractSessionMorph(model, h.shell as unknown as HTMLElement, false);
    model.cancel();
    await model.finished;
    expect(model.cancelled).toBe(true);
    expect(model.animations).toHaveLength(0);
    expect(h.source.querySelector('.card')).toBe(h.card);
    expect(h.source.style.clipPath).toBe('none');
    expect(h.card.style).toMatchObject({ transformOrigin: '50% 50%', overflow: 'visible' });
    expect(h.source.draft).toBe('retained draft');
    expect(h.source.inert).toBe(false);
  } finally {
    h.restore();
  }
});

test('reverse expansion handles resize and reduced motion without retaining transformed or inert controls', async () => {
  for (const reduced of [false, true]) {
    const h = harness();
    h.holdAnimations();
    try {
      const expanding = expandSessionMorph(h.shell as unknown as HTMLElement, h.target as unknown as HTMLElement, reduced);
      h.win.dispatchEvent(new Event('resize'));
      const restore = await expanding;
      expect(h.targetCard.calls).toHaveLength(0);
      expect(h.targetCard.style).toMatchObject({ transformOrigin: '', overflow: '' });
      expect(h.target.style.opacity).toBe('');
      expect(h.target.inert).toBe(true);
      restore?.();
      expect(h.target.inert).toBe(false);
      expect(h.target.style.zIndex).toBe('');
      expect(h.target.draft).toBe('retained draft');
    } finally {
      h.restore();
    }
  }
});

test('superseding expansion aborts immediately and cannot overwrite the next owner after settlement', async () => {
  const h = harness();
  h.holdAnimations();
  try {
    const controller = new AbortController();
    const roundShell = { left: '312px', top: '212px', width: '176px', height: '176px', borderRadius: '88px', opacity: 1 };
    Object.assign(h.shell.style, roundShell);
    const expanding = expandSessionMorph(h.shell as unknown as HTMLElement, h.target as unknown as HTMLElement, false, controller.signal);
    expect(h.shell.calls[0]?.frames[0]).toMatchObject(roundShell);
    controller.abort();
    expect(h.shell.style).toMatchObject(roundShell);
    expect(h.target.inert).toBe(false);
    expect(h.target.style.zIndex).toBe('');
    h.target.style.opacity = '0.7';
    h.shell.style.opacity = '0.6';
    const restore = await expanding;
    expect(restore).toBeUndefined();
    expect(h.target.style.opacity).toBe('0.7');
    expect(h.shell.style.opacity).toBe('0.6');
  } finally {
    h.restore();
  }
});

test('the original full-screen wallpaper remains until the retained backdrop is decoded, including viewport settlement', async () => {
  for (const resize of [false, true]) {
    const h = harness();
    try {
      const model = beginSessionMorph('signing-in');
      if (!model) throw new Error('missing model');
      let decoded: () => void = () => undefined;
      const backdrop = new Promise<void>((resolve) => {
        decoded = resolve;
      });
      contractSessionMorph(model, h.shell as unknown as HTMLElement, false, backdrop);
      if (resize) {
        settleSessionMorphViewport(model, h.shell as unknown as HTMLElement);
        expect(h.card.style).toMatchObject({ width: '176px', height: '176px', borderRadius: '88px', transform: 'none' });
        expect(h.card.children.every((child) => child.style.opacity === '0')).toBe(true);
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(model.contracted).toBe(false);
      expect(h.source.style.opacity).toBe('');
      expect(h.source.calls).toHaveLength(0);
      decoded();
      await model.finished;
      expect(h.source.style.opacity).toBe('0');
      expect(h.root.dataset.orbisSessionMorph).toBe('waiting');
    } finally {
      h.restore();
    }
  }
});

test('cancelling while the backdrop decodes cannot hide the restored login surface later', async () => {
  const h = harness();
  try {
    Object.assign(h.card.style, { borderRadius: '22px', transform: 'rotate(0deg)', opacity: '0.95', boxShadow: '0px 2px 4px black' });
    for (const child of h.card.children) child.style.opacity = '0.8';
    const model = beginSessionMorph('signing-in');
    if (!model) throw new Error('missing model');
    let decoded: () => void = () => undefined;
    const backdrop = new Promise<void>((resolve) => {
      decoded = resolve;
    });
    contractSessionMorph(model, h.shell as unknown as HTMLElement, false, backdrop);
    await Promise.resolve();
    settleSessionMorphViewport(model, h.shell as unknown as HTMLElement);
    model.cancel();
    await model.finished;
    decoded();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.source.style.opacity).toBe('');
    expect(h.source.inert).toBe(false);
    expect(h.root.dataset.orbisSessionMorph).toBeUndefined();
    expect(h.card.style).toMatchObject({ borderRadius: '22px', transform: 'rotate(0deg)', opacity: '0.95', boxShadow: '0px 2px 4px black' });
    expect(h.card.children.every((child) => child.style.opacity === '0.8')).toBe(true);
  } finally {
    h.restore();
  }
});
