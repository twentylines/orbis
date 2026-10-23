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

export function transitionAppearance(apply: () => void, animate: boolean) {
  const root = document.documentElement;
  if (!animate || typeof CSS.registerProperty !== 'function' || typeof root.animate !== 'function') {
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
  const animation = root.animate([before, after], { duration: 280, easing: 'cubic-bezier(.2, 0, .2, 1)' });
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
