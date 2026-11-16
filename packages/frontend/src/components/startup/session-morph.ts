export const sessionMorphDuration = 640;
const easing = 'cubic-bezier(.22,.72,.18,1)';
export type SessionBox = { left: number; top: number; width: number; height: number };
export type SessionMorph = {
  source: HTMLElement;
  card: HTMLElement | null;
  radius: number;
  backdrop: { src: string; image: HTMLImageElement; style: { objectFit: string; objectPosition: string; filter: string; transform: string } } | null;
  background: string;
  shade: string;
  dim: string;
  sourceBox: SessionBox;
  from: SessionBox;
  orb: SessionBox;
  started: boolean;
  contracted: boolean;
  cancelled: boolean;
  finished: Promise<void>;
  animations: Animation[];
  settleSurface: () => void;
  finishContraction: () => void;
  complete: () => void;
  cancel: () => void;
};
let current: SessionMorph | null = null;
const changeEvent = 'orbis-session-morph-changed';
export const hasActiveSessionMorph = () => current !== null && !current.cancelled;
export const noSessionMorph = () => false;
export function subscribeSessionMorph(changed: () => void) {
  window.addEventListener(changeEvent, changed);
  return () => window.removeEventListener(changeEvent, changed);
}

export function sessionOrbBounds(width: number, height: number): SessionBox {
  const size = Math.max(48, Math.min(Math.max(176, Math.min(352, (width * 176) / 1920)), width - 48, height - 160));
  return { left: (width - size) / 2, top: (height - size) / 2, width: size, height: size };
}
function viewport() {
  const visual = window.visualViewport;
  return { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0, width: visual?.width ?? innerWidth, height: visual?.height ?? innerHeight };
}
function currentOrb() {
  const view = viewport();
  const box = sessionOrbBounds(view.width, view.height);
  return { ...box, left: box.left + view.left, top: box.top + view.top };
}
function placeStatus(shell: HTMLElement, orb: SessionBox) {
  shell.style.setProperty('--orbis-loading-size', `${orb.width}px`);
  shell.closest<HTMLElement>('.orbis-startup')?.style.setProperty('--orbis-session-center-x', `${orb.left + orb.width / 2}px`);
  shell.closest<HTMLElement>('.orbis-startup')?.style.setProperty('--orbis-session-status-top', `${orb.top + orb.height + 24}px`);
}
export function sessionClip(source: SessionBox, box: SessionBox, radius: number) {
  return `inset(${Math.max(0, box.top - source.top)}px ${Math.max(0, source.left + source.width - box.left - box.width)}px ${Math.max(0, source.top + source.height - box.top - box.height)}px ${Math.max(0, box.left - source.left)}px round ${radius}px)`;
}
const frame = (box: SessionBox, radius: number, opacity = 1): Keyframe => ({
  left: `${box.left}px`,
  top: `${box.top}px`,
  width: `${box.width}px`,
  height: `${box.height}px`,
  borderRadius: `${radius}px`,
  transform: 'none',
  transformOrigin: '0 0',
  opacity,
});
const cardFrames = (from: SessionBox, to: SessionBox, radius: number): Keyframe[] =>
  sessionExpansionSteps(to, from, radius)
    .reverse()
    .map(({ box, radius, offset }) => ({ ...frame(box, radius), offset: 1 - offset }));
export function sessionExpansionSteps(orb: SessionBox, card: SessionBox, radius: number) {
  const growth = Math.max(card.width - orb.width, card.height - orb.height, 0);
  return Array.from({ length: 21 }, (_, index) => {
    const offset = index / 20;
    const dimension = (start: number, end: number) => (end < start ? start + (end - start) * offset : Math.min(end, start + growth * offset));
    const width = dimension(orb.width, card.width);
    const height = dimension(orb.height, card.height);
    const centerX = orb.left + orb.width / 2 + (card.left + card.width / 2 - orb.left - orb.width / 2) * offset;
    const centerY = orb.top + orb.height / 2 + (card.top + card.height / 2 - orb.top - orb.height / 2) * offset;
    return {
      offset,
      box: { left: centerX - width / 2, top: centerY - height / 2, width, height },
      radius: (Math.min(width, height) / 2) * (1 - offset) + radius * offset,
    };
  });
}
function prepareCard(card: HTMLElement | null, holdBox = false) {
  if (!card) return () => undefined;
  const saved = {
    transformOrigin: card.style.transformOrigin,
    transform: card.style.transform,
    borderRadius: card.style.borderRadius,
    boxShadow: card.style.boxShadow,
    opacity: card.style.opacity,
    overflow: card.style.overflow,
    position: card.style.position,
    left: card.style.left,
    top: card.style.top,
    width: card.style.width,
    height: card.style.height,
    minWidth: card.style.minWidth,
    minHeight: card.style.minHeight,
    maxWidth: card.style.maxWidth,
    maxHeight: card.style.maxHeight,
    margin: card.style.margin,
    boxSizing: card.style.boxSizing,
    contain: card.style.contain,
  };
  const children = holdBox
    ? Array.from(card.children).map((child) => {
        const element = child as HTMLElement;
        const saved = {
          width: element.style.width,
          minWidth: element.style.minWidth,
          maxWidth: element.style.maxWidth,
          boxSizing: element.style.boxSizing,
          opacity: element.style.opacity,
        };
        const width = `${element.getBoundingClientRect().width}px`;
        Object.assign(element.style, { width, minWidth: width, maxWidth: width, boxSizing: 'border-box' });
        return { element, saved };
      })
    : [];
  if (holdBox) {
    const bounds = card.getBoundingClientRect();
    Object.assign(card.style, {
      position: 'fixed',
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      minWidth: '0',
      minHeight: '0',
      maxWidth: 'none',
      maxHeight: 'none',
      margin: '0',
      boxSizing: 'border-box',
      contain: 'layout paint',
    });
    const placed = card.getBoundingClientRect();
    card.style.left = `${bounds.left - (placed.left - bounds.left)}px`;
    card.style.top = `${bounds.top - (placed.top - bounds.top)}px`;
  }
  card.style.transformOrigin = '0 0';
  card.style.overflow = 'hidden';
  return () => {
    Object.assign(card.style, saved);
    for (const { element, saved } of children) Object.assign(element.style, saved);
  };
}
function fadeCardContent(card: HTMLElement, entering: boolean, timing: KeyframeAnimationOptions) {
  return Array.from(card.children).flatMap((child) =>
    typeof (child as HTMLElement).animate === 'function'
      ? [
          (child as HTMLElement).animate(
            entering
              ? [{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }]
              : [{ opacity: 1 }, { opacity: 0, offset: 0.32 }, { opacity: 0 }],
            timing,
          ),
        ]
      : [],
  );
}

export function beginSessionMorph(kind: 'signing-in' | 'logging-out'): SessionMorph | null {
  current?.cancel();
  const source = document.querySelector<HTMLElement>(kind === 'signing-in' ? '.desktop-auth:not(.desktop-auth-setup)' : '.desktop');
  if (!source) return null;
  const entrance = (source.getAnimations?.({ subtree: true }) ?? []).filter(
    (animation) => animation.id === 'orbis-auth-enter' && animation.playState === 'running',
  );
  for (const animation of entrance) animation.pause();
  const card = source.querySelector<HTMLElement>('.card');
  const from = kind === 'signing-in' && card ? card.getBoundingClientRect() : viewport();
  const sourceBox = source.getBoundingClientRect();
  const sourceStyle = getComputedStyle(source);
  const image = source.querySelector<HTMLImageElement>('.desktop-wallpaper-layer img:last-of-type');
  const imageStyle = image?.complete && image.naturalWidth > 0 ? getComputedStyle(image) : null;
  const shade = source.querySelector<HTMLElement>('.desktop-wallpaper-shade');
  const dim = source.querySelector<HTMLElement>('.desktop-wallpaper-dim');
  const saved = {
    position: source.style.position,
    zIndex: source.style.zIndex,
    clipPath: source.style.clipPath,
    opacity: source.style.opacity,
    inert: source.inert,
  };
  const restoreCard = prepareCard(kind === 'signing-in' ? card : null, kind === 'signing-in');
  let resolve: () => void = () => undefined;
  const finished = new Promise<void>((done) => {
    resolve = done;
  });
  const model: SessionMorph = {
    source,
    card: kind === 'signing-in' ? card : null,
    radius: kind === 'signing-in' && card ? Number.parseFloat(getComputedStyle(card).borderTopLeftRadius) || 24 : 0,
    backdrop:
      image && imageStyle
        ? {
            src: image.currentSrc || image.src,
            image,
            style: {
              objectFit: imageStyle.objectFit,
              objectPosition: imageStyle.objectPosition,
              filter: imageStyle.filter,
              transform: imageStyle.transform,
            },
          }
        : null,
    background: sourceStyle.backgroundColor || '#030508',
    shade: shade ? getComputedStyle(shade).background : 'transparent',
    dim: dim ? getComputedStyle(dim).background : 'transparent',
    sourceBox,
    from,
    orb: currentOrb(),
    started: false,
    contracted: false,
    cancelled: false,
    finished,
    animations: [],
    settleSurface: () => undefined,
    finishContraction: () => model.complete(),
    complete: () => {
      if (!model.cancelled) {
        model.settleSurface();
        if (current === model) document.documentElement.dataset.orbisSessionMorph = 'waiting';
      }
      model.contracted = true;
      resolve();
    },
    cancel: () => {
      model.cancelled = true;
      for (const animation of model.animations.splice(0)) animation.cancel();
      source.style.position = saved.position;
      source.style.zIndex = saved.zIndex;
      source.style.clipPath = saved.clipPath;
      source.style.opacity = saved.opacity;
      source.inert = saved.inert;
      restoreCard();
      if (source.isConnected) for (const animation of entrance) if (animation.playState === 'paused') animation.play();
      model.complete();
      if (current === model) {
        current = null;
        delete document.documentElement.dataset.orbisSessionMorph;
        window.dispatchEvent(new Event(changeEvent));
      }
    },
  };
  if (sourceStyle.position === 'static') source.style.position = 'relative';
  source.style.zIndex = kind === 'signing-in' && card ? '99' : '101';
  source.inert = true;
  current = model;
  document.documentElement.dataset.orbisSessionMorph = 'contracting';
  window.dispatchEvent(new Event(changeEvent));
  return model;
}

export function currentSessionMorphExit() {
  const model = current;
  return { finished: model?.finished ?? Promise.resolve(), cancel: () => model?.cancel() };
}

export function contractSessionMorph(model: SessionMorph, shell: HTMLElement, reduced: boolean, backdropReady?: Promise<void>) {
  if (model.started) return;
  model.started = true;
  let finishing = false;
  model.finishContraction = () => {
    if (finishing) return;
    finishing = true;
    const finish = () => {
      if (!model.cancelled) {
        model.source.style.opacity = '0';
        model.complete();
      }
    };
    if (backdropReady) void backdropReady.then(finish);
    else finish();
  };
  model.sourceBox = model.source.getBoundingClientRect();
  model.from = model.card?.getBoundingClientRect() ?? viewport();
  model.orb = currentOrb();
  placeStatus(shell, model.orb);
  const to = frame(model.orb, model.orb.width / 2);
  const timing = { duration: reduced ? 0 : sessionMorphDuration, easing, fill: 'both' as const };
  if (model.card) {
    const appearance = getComputedStyle(model.card);
    const surface = {
      background: appearance.background,
      border: appearance.border,
      boxShadow: 'none',
      backdropFilter: appearance.backdropFilter,
      boxSizing: 'border-box',
    };
    Object.assign(shell.style, { background: 'transparent', border: '0', boxShadow: 'none', backdropFilter: 'none' });
    model.settleSurface = () => {
      Object.assign(shell.style, surface, frame(model.orb, model.orb.width / 2));
      model.source.style.opacity = '0';
    };
  }
  if (
    typeof shell.animate !== 'function' ||
    typeof model.source.animate !== 'function' ||
    (model.card && typeof model.card.animate !== 'function') ||
    reduced
  ) {
    Object.assign(shell.style, to);
    model.finishContraction();
    return;
  }
  Object.assign(shell.style, to);
  const shellMotion = shell.animate(
    model.card
      ? cardFrames(model.from, model.orb, model.radius).map((keyframe) => ({
          ...keyframe,
          opacity: Math.min(1, Math.max(0, (Number(keyframe.offset) - 0.12) / 0.43)),
        }))
      : [
          { transform: 'scale(.94)', transformOrigin: '50% 50%', opacity: 0 },
          { transform: 'none', transformOrigin: '50% 50%', opacity: 1 },
        ],
    timing,
  );
  const sourceMotion = model.source.animate(model.card ? [{ opacity: 1 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], timing);
  model.animations.push(shellMotion, sourceMotion);
  if (model.card) {
    const shadow = getComputedStyle(model.card).boxShadow;
    const origin = {
      left: model.from.left - Number.parseFloat(model.card.style.left || '0'),
      top: model.from.top - Number.parseFloat(model.card.style.top || '0'),
    };
    model.animations.push(
      model.card.animate(
        cardFrames(model.from, model.orb, model.radius).map((keyframe) => ({
          ...keyframe,
          ...(Number(keyframe.offset) === 0 ? { boxShadow: shadow } : Number(keyframe.offset) >= 0.5 ? { boxShadow: 'none' } : {}),
          left: `${Number.parseFloat(String(keyframe.left)) - origin.left}px`,
          top: `${Number.parseFloat(String(keyframe.top)) - origin.top}px`,
        })),
        timing,
      ),
    );
    model.animations.push(...fadeCardContent(model.card, false, timing));
  }
  const start = document.timeline?.currentTime;
  if (typeof start === 'number') for (const animation of model.animations) animation.startTime = start;
  void Promise.allSettled(model.animations.map((animation) => animation.finished)).then(() => {
    model.finishContraction();
  });
}

export function matchSessionBackdrop(shell: HTMLElement, target: HTMLElement, reduced = false) {
  const surface = shell.closest<HTMLElement>('.orbis-startup');
  if (!surface?.querySelector) return;
  surface.style.background = 'transparent';
  for (const key of ['desktopMode', 'desktopPreset'] as const) {
    if (target.dataset[key]) surface.dataset[key] = target.dataset[key];
  }
  for (const name of ['shade', 'dim']) {
    const destination = target.querySelector<HTMLElement>(`.desktop-wallpaper-${name}`);
    const underlay = surface.querySelector<HTMLElement>(`.desktop-wallpaper-${name}`);
    if (!destination || !underlay) continue;
    const before = getComputedStyle(underlay).backgroundColor;
    const appearance = getComputedStyle(destination);
    surface.style.setProperty(`--orbis-session-${name}`, appearance.background);
    underlay.style.background = appearance.background;
    if (!reduced && typeof underlay.animate === 'function' && appearance.backgroundImage === 'none' && before !== appearance.backgroundColor)
      underlay.animate([{ backgroundColor: before }, { backgroundColor: appearance.backgroundColor }], { duration: 240, easing: 'ease-out' });
  }
}

export function settleSessionMorphViewport(model: SessionMorph, shell: HTMLElement) {
  if (!model.started || model.cancelled) return;
  for (const animation of model.animations.splice(0)) animation.cancel();
  model.orb = currentOrb();
  Object.assign(shell.style, frame(model.orb, model.orb.width / 2));
  if (model.card) {
    const bounds = model.card.getBoundingClientRect();
    const left = bounds.left - Number.parseFloat(model.card.style.left || '0');
    const top = bounds.top - Number.parseFloat(model.card.style.top || '0');
    Object.assign(model.card.style, frame({ ...model.orb, left: model.orb.left - left, top: model.orb.top - top }, model.orb.width / 2));
    model.card.style.boxShadow = 'none';
    for (const child of model.card.children) (child as HTMLElement).style.opacity = '0';
  }
  placeStatus(shell, model.orb);
  model.finishContraction();
}

export async function expandSessionMorph(shell: HTMLElement, target: HTMLElement, reduced: boolean, signal?: AbortSignal) {
  if (signal?.aborted) return;
  const card = target.querySelector<HTMLElement>('.card');
  if (!card) return;
  matchSessionBackdrop(shell, target, reduced);
  const orb = currentOrb();
  const to = card.getBoundingClientRect();
  const root = target.getBoundingClientRect();
  const restoreCard = prepareCard(card);
  const saved = {
    position: target.style.position,
    zIndex: target.style.zIndex,
    clipPath: target.style.clipPath,
    opacity: target.style.opacity,
    inert: target.inert,
  };
  const restore = () => {
    Object.assign(target.style, { position: saved.position, zIndex: saved.zIndex, clipPath: saved.clipPath, opacity: saved.opacity });
    target.inert = saved.inert;
    restoreCard();
  };
  if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
  target.style.zIndex = '101';
  target.inert = true;
  const animations: Animation[] = [];
  let aborted = false;
  const abort = () => {
    aborted = true;
    for (const animation of animations) animation.cancel();
    window.removeEventListener('resize', resized);
    window.visualViewport?.removeEventListener('resize', resized);
    restore();
  };
  const resized = () => {
    for (const animation of animations) animation.cancel();
  };
  window.addEventListener('resize', resized);
  window.visualViewport?.addEventListener('resize', resized);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (!reduced && typeof shell.animate === 'function' && typeof target.animate === 'function' && typeof card.animate === 'function') {
      const timing = { duration: sessionMorphDuration, easing, fill: 'both' as const };
      const radius = Number.parseFloat(getComputedStyle(card).borderTopLeftRadius) || 24;
      const steps = sessionExpansionSteps(orb, to, radius);
      Object.assign(shell.style, frame(orb, orb.width / 2));
      animations.push(
        shell.animate(
          steps.map(({ box, radius, offset }) => ({ ...frame(box, radius, Math.max(0, 1 - offset / 0.7)), offset })),
          timing,
        ),
      );
      animations.push(...fadeCardContent(card, true, timing));
      animations.push(
        target.animate(
          steps.map(({ box, radius, offset }) => ({
            clipPath: sessionClip(root, box, radius),
            opacity: Math.min(1, offset / 0.28),
            offset,
          })),
          timing,
        ),
      );
      const start = document.timeline?.currentTime;
      if (typeof start === 'number') for (const animation of animations) animation.startTime = start;
      await Promise.allSettled(animations.map((animation) => animation.finished));
    }
  } finally {
    window.removeEventListener('resize', resized);
    window.visualViewport?.removeEventListener('resize', resized);
    for (const animation of animations) animation.cancel();
    signal?.removeEventListener('abort', abort);
    if (!aborted) {
      Object.assign(shell.style, frame(to, Number.parseFloat(getComputedStyle(card).borderTopLeftRadius) || 24, 0));
      target.style.clipPath = saved.clipPath;
      target.style.opacity = saved.opacity;
      restoreCard();
    }
  }
  return aborted ? undefined : restore;
}
