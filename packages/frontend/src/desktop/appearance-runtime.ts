// This function is also embedded before hydration; keep its helpers self-contained.
export function applyAppearanceRuntime(input: unknown, mode: string) {
  type Rgba = [number, number, number, number];
  const root = document.documentElement;
  const options = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const source = getComputedStyle(document.querySelector('.orbis-theme') ?? root);
  if (!source.getPropertyValue('--desktop-base-surface').trim()) return;
  const numeric = (key: string, min: number, max: number) => {
    const value = options[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
  };
  const colour = (value: string): Rgba => {
    if (/^#[a-f0-9]{6}$/i.test(value))
      return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16), 1];
    const match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)] : [0, 0, 0, 1];
  };
  const base = (name: string) => colour(source.getPropertyValue(`--desktop-base-${name}`).trim());
  const mix = (first: Rgba, second: Rgba, amount: number): Rgba => {
    const alpha = first[3] * (1 - amount) + second[3] * amount;
    return first
      .slice(0, 3)
      .map((channel, index) => (channel * first[3] * (1 - amount) + (second[index] ?? 0) * second[3] * amount) / alpha)
      .concat(alpha) as Rgba;
  };
  const css = (value: Rgba) => `rgba(${value.slice(0, 3).map(Math.round).join(', ')}, ${value[3]})`;
  const luminance = (value: number[]) =>
    value.slice(0, 3).reduce((total, channel, index) => {
      const unit = channel / 255;
      return total + (unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4) * ([0.2126, 0.7152, 0.0722][index] ?? 0);
    }, 0);
  const contrast = (first: number[], second: number[]) => {
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const black: Rgba = [0, 0, 0, 1];
  const white: Rgba = [255, 255, 255, 1];
  const backgrounds = (value: Rgba): Rgba[] =>
    [0, 255].map(
      (channel) =>
        value
          .slice(0, 3)
          .map((foreground) => foreground * value[3] + channel * (1 - value[3]))
          .concat(1) as Rgba,
    );
  const readable = (value: Rgba, behind: Rgba[], dark: boolean, minimum = 4.65) => {
    const original: Rgba = [value[0], value[1], value[2], 1];
    for (let step = 0; step <= 100; step += 1) {
      const candidate = mix(original, dark ? white : black, step / 100);
      const rounded = candidate.slice(0, 3).map(Math.round).concat(1) as Rgba;
      if (behind.every((background) => contrast(rounded, background) >= minimum)) return rounded;
    }
    return dark ? white : black;
  };
  const properties = [
    'surface',
    'chrome',
    'muted',
    'accent',
    'action',
    'action-ink',
    'action-hover',
    'action-rgb',
    'positive',
    'negative',
    'warning',
    'info',
    'focus',
    'chrome-focus',
    'chrome-muted',
    'panel-dark',
    'glass-filter',
  ];
  const set = (name: string, value: string) => root.style.setProperty(`--orbis-${name}`, value);
  for (const name of properties) root.style.removeProperty(`--orbis-${name}`);

  const low = options.lowEffects === true;
  const media = (query: string) => {
    try {
      return typeof matchMedia === 'function' && matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const systemSolid = media('(prefers-reduced-transparency: reduce)');
  const solid = low || options.transparency === 'solid' || (options.transparency !== 'glass' && systemSolid);
  const systemReduced = media('(prefers-reduced-motion: reduce)');
  root.dataset.orbisMotion = low || options.motion === 'reduced' || systemReduced ? 'reduced' : 'full';
  root.dataset.orbisTransparency = solid ? 'solid' : 'glass';
  root.dataset.orbisEffects = low ? 'low' : 'full';

  const opacity = numeric('surfaceOpacity', 90, 100);
  const chromeOpacity = numeric('chromeOpacity', 80, 100);
  const tint = (numeric('glassTint', 0, 30) ?? 0) / 100;
  const blur = numeric('glassBlur', 0, 40);
  const materialChanged = solid || opacity !== null || chromeOpacity !== null || tint > 0;
  const preset = colour(source.getPropertyValue('--desktop-preset-tint').trim());
  const surface = base('surface');
  const chrome = base('chrome');
  const panel = base('panel-dark');
  if (opacity !== null) surface[3] = opacity / 100;
  if (chromeOpacity !== null) chrome[3] = chromeOpacity / 100;
  if (solid) surface[3] = chrome[3] = panel[3] = 1;
  const tintedSurface = [...mix(surface, preset, tint).slice(0, 3), surface[3]] as Rgba;
  let tintedChrome = [...mix(chrome, preset, tint).slice(0, 3), chrome[3]] as Rgba;
  const originalChrome = tintedChrome;
  const chromeInk = colour(source.getPropertyValue('--desktop-chrome-ink').trim());
  const chromeBackgrounds = (value: Rgba) => backgrounds(value).flatMap((background) => [background, mix(background, white, 0.2)]);
  let chromeAdjusted = false;
  // Include the selected dock bubble and a white wallpaper behind the bar.
  for (let shade = 0; shade <= 100; shade += 1) {
    tintedChrome = [
      Math.round(originalChrome[0] * (1 - shade / 100)),
      Math.round(originalChrome[1] * (1 - shade / 100)),
      Math.round(originalChrome[2] * (1 - shade / 100)),
      originalChrome[3],
    ];
    chromeAdjusted = shade > 0;
    if (chromeBackgrounds(tintedChrome).every((background) => contrast(chromeInk, background) >= 4.65)) break;
  }
  if (materialChanged) {
    set('surface', css(tintedSurface));
    set('panel-dark', css([...mix(panel, preset, tint).slice(0, 3), panel[3]] as Rgba));
  }
  if (materialChanged || chromeAdjusted) set('chrome', css(tintedChrome));
  if (solid || blur === 0) set('glass-filter', 'none');
  else if (blur !== null) set('glass-filter', `blur(${blur}px) saturate(1.2)`);

  const accent = typeof options.accent === 'string' && /^#[a-f0-9]{6}$/i.test(options.accent) ? colour(options.accent) : null;
  set('chrome-muted', css(readable(mix(chromeInk, originalChrome, 0.25), chromeBackgrounds(tintedChrome), true)));
  set('chrome-focus', css(readable(accent ?? base('focus'), chromeBackgrounds(tintedChrome), true, 3.1)));
  root.dataset.orbisColourCustom = materialChanged || accent ? 'true' : 'false';
  if (!materialChanged && !accent) return;
  const behind = [tintedSurface, mix(tintedSurface, preset, 0.08), mix(tintedSurface, preset, 0.2)].flatMap(backgrounds);
  const dark = mode === 'dark';
  const foreground = readable(accent ?? base('accent'), behind, dark);
  set('accent', css(foreground));
  set('focus', css(foreground));
  set('muted', css(readable(base('muted'), behind, dark)));
  if (materialChanged) {
    for (const name of ['positive', 'negative', 'warning', 'info']) set(name, css(readable(base(name), behind, dark)));
  }
  if (accent) {
    // White control glyphs and hovered primary buttons share this contrast floor.
    const action = readable(accent, [white], false);
    set('action', css(action));
    set('action-ink', '#ffffff');
    set('action-hover', css(mix(action, black, 0.12)));
    set('action-rgb', action.slice(0, 3).join(', '));
  }
}
