import { prefersReducedMotion } from './motion-setting';

const colours = [
  '--desktop-surface',
  '--desktop-chrome',
  '--desktop-chrome-opaque',
  '--desktop-ink',
  '--desktop-muted',
  '--desktop-accent',
  '--desktop-action',
  '--desktop-action-ink',
  '--desktop-action-hover',
  '--desktop-action-active',
  '--desktop-positive',
  '--desktop-negative',
  '--desktop-warning',
  '--desktop-info',
  '--desktop-focus',
  '--desktop-panel-dark',
  '--desktop-preset-tint',
  '--desktop-chrome-ink',
  '--desktop-line',
  '--desktop-edge',
  '--desktop-highlight',
  '--desktop-log-background',
  '--desktop-warning-fill',
  '--desktop-warning-ink',
  '--desktop-danger-fill',
  '--desktop-danger-ink',
  '--workspace-heading-ink',
  '--workspace-heading-shadow',
  '--desktop-action-rgb',
  '--desktop-base-chrome-rgb',
  '--desktop-wallpaper-shade-start-alpha',
  '--desktop-wallpaper-shade-end-alpha',
];
const registered = new Set<string>();
let motion: Animation | null = null;
let paletteRevision = 0;
let snapshotTransition: ViewTransition | null = null;
let paletteIdentity: string | undefined;

export function transitionAppearance(apply: () => void, animate: boolean, identity?: string) {
  if (identity !== undefined && identity === paletteIdentity) return;
  paletteIdentity = identity;
  const root = document.documentElement;
  const revision = ++paletteRevision;
  snapshotTransition?.skipTransition();
  snapshotTransition = null;
  if (!animate || prefersReducedMotion()) {
    motion?.cancel();
    motion = null;
    delete root.dataset.orbisPaletteMotion;
    apply();
    return;
  }
  // Crossfade two paints instead of recalculating every inherited palette colour each frame.
  if (typeof document.startViewTransition === 'function') {
    motion?.cancel();
    motion = null;
    root.dataset.orbisPaletteMotion = 'true';
    let transition: ViewTransition;
    try {
      transition = document.startViewTransition(() => {
        if (revision === paletteRevision) apply();
      });
    } catch {
      delete root.dataset.orbisPaletteMotion;
      apply();
      return;
    }
    snapshotTransition = transition;
    const settle = () => {
      if (snapshotTransition !== transition) return;
      snapshotTransition = null;
      delete root.dataset.orbisPaletteMotion;
    };
    void transition.ready.catch(() => undefined);
    void transition.finished.then(settle, settle);
    return;
  }
  if (typeof CSS.registerProperty !== 'function' || typeof root.animate !== 'function') {
    apply();
    return;
  }
  for (const name of colours) {
    if (registered.has(name)) continue;
    const channels = name.endsWith('-rgb');
    const scalar = name.endsWith('-alpha');
    CSS.registerProperty({
      name,
      syntax: channels ? '<number>#' : scalar ? '<number>' : '<color>',
      inherits: true,
      initialValue: channels ? '0, 0, 0' : scalar ? '0' : 'transparent',
    });
    registered.add(name);
  }
  const read = () => {
    const style = getComputedStyle(root);
    return Object.fromEntries(colours.map((name) => [name, style.getPropertyValue(name).trim()]));
  };
  const before = read();
  motion?.cancel();
  motion = null;
  apply();
  if (prefersReducedMotion()) {
    delete root.dataset.orbisPaletteMotion;
    return;
  }
  const after = read();
  if (colours.every((name) => before[name] === after[name])) {
    delete root.dataset.orbisPaletteMotion;
    return;
  }
  root.dataset.orbisPaletteMotion = 'true';
  const changed = colours.filter((name) => before[name] !== after[name]);
  const frame = (values: Record<string, string>) => Object.fromEntries(changed.map((name) => [name, values[name]]));
  const animation = root.animate([frame(before), frame(after)], { duration: 260, easing: 'cubic-bezier(.2, 0, .2, 1)' });
  animation.id = 'orbis-palette';
  motion = animation;
  void animation.finished.then(
    () => {
      if (motion !== animation) return;
      motion = null;
      delete root.dataset.orbisPaletteMotion;
    },
    () => undefined,
  );
}
