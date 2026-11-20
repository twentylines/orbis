// This function is also embedded before hydration; keep its helpers self-contained.
export function applyAppearanceRuntime(input: unknown, mode: string) {
  type Rgba = [number, number, number, number];
  const root = document.documentElement;
  const options = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const source = getComputedStyle(root);
  const numeric = (key: string, min: number, max: number) => {
    const value = options[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
  };
  const textScale = numeric('textScale', 85, 150) ?? 100;
  if (textScale === 100) root.style.removeProperty('--orbis-text-scale');
  else root.style.setProperty('--orbis-text-scale', String(textScale / 100));
  if (!source.getPropertyValue('--desktop-base-surface').trim()) return;
  const colour = (value: string): Rgba => {
    const hex = value.match(/^#([a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/i)?.[1];
    if (hex) {
      const expanded = hex.length < 5 ? [...hex].map((channel) => channel + channel).join('') : hex;
      return [
        Number.parseInt(expanded.slice(0, 2), 16),
        Number.parseInt(expanded.slice(2, 4), 16),
        Number.parseInt(expanded.slice(4, 6), 16),
        expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
      ];
    }
    const match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)] : [0, 0, 0, 1];
  };
  const base = (name: string) => colour(source.getPropertyValue(`--desktop-base-${name}`).trim());
  const mix = (first: Rgba, second: Rgba, amount: number): Rgba => {
    const alpha = first[3] * (1 - amount) + second[3] * amount;
    if (alpha === 0) return [first[0], first[1], first[2], 0];
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
  const backgrounds = (value: Rgba, brightest = 255): Rgba[] =>
    [0, brightest].map(
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
    'pane-surface',
    'home-surface',
    'chrome',
    'chrome-rgb',
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
    'oled-panel',
    'glass-filter',
    'chrome-filter',
    'chrome-backdrop-brightness',
    'glass-chrome-blur',
    'tray-chrome-filter',
    'menu-surface',
    'menu-muted',
    'theme-ink',
    'theme-tint',
  ];
  const next = new Map<string, string>();
  const set = (name: string, value: string) => next.set(name, value);
  const commit = () => {
    if (typeof requestAnimationFrame === 'function') {
      const revision = String(Number(root.dataset.orbisColourSwitch ?? '0') + 1);
      root.dataset.orbisColourSwitch = revision;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (root.dataset.orbisColourSwitch === revision) delete root.dataset.orbisColourSwitch;
        }),
      );
    }
    // Read the complete base palette before replacing overrides in one synchronous pass.
    for (const name of properties) {
      const value = next.get(name);
      if (value === undefined) root.style.removeProperty(`--orbis-${name}`);
      else root.style.setProperty(`--orbis-${name}`, value);
    }
  };

  const dark = mode === 'dark';
  const low = options.lowEffects === true;
  const media = (query: string) => {
    try {
      return typeof matchMedia === 'function' && matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const systemSolid = media('(prefers-reduced-transparency: reduce)');
  const oled = mode === 'dark' && options.oledDark === true;
  root.dataset.orbisOled = String(oled);
  const solid = low || oled || options.transparency === 'solid' || (options.transparency !== 'glass' && systemSolid);
  const systemReduced = media('(prefers-reduced-motion: reduce)');
  root.style.setProperty('--orbis-control-transition-duration', options.motion === 'reduced' || systemReduced ? '0.01ms' : '180ms');
  root.dataset.orbisMotion = low || options.motion === 'reduced' || systemReduced ? 'reduced' : 'full';
  root.dataset.orbisTransparency = solid ? 'solid' : 'glass';
  root.dataset.orbisEffects = low ? 'low' : 'full';

  const legacyMaterial = [
    numeric('surfaceOpacity', 0, 100),
    numeric('chromeOpacity', 0, 100),
    numeric('glassBlur', 0, 40),
    numeric('chromeBlur', 0, 64),
    numeric('glassTint', 0, 30),
  ].some((value) => value !== null);
  const customMaterial = options.materialMode === 'custom' || (options.materialMode !== 'default' && legacyMaterial);
  const opacity = customMaterial ? numeric('surfaceOpacity', 0, 100) : null;
  const chromeOpacity = customMaterial ? numeric('chromeOpacity', 0, 100) : null;
  const tint = oled || !customMaterial ? 0 : (numeric('glassTint', 0, 30) ?? 0) / 100;
  const blur = customMaterial ? numeric('glassBlur', 0, 40) : null;
  const themeColour = typeof options.themeColour === 'string' && /^#[a-f0-9]{6}$/i.test(options.themeColour) ? colour(options.themeColour) : null;
  const materialChanged = solid || opacity !== null || chromeOpacity !== null || tint > 0 || themeColour !== null;
  const preset =
    themeColour ?? colour((source.getPropertyValue('--desktop-base-preset-tint') || source.getPropertyValue('--desktop-preset-tint')).trim());
  const surface = base('surface');
  const chrome = base('chrome');
  const panel = base('panel-dark');
  if (themeColour) {
    const surfaceRgb = mix(themeColour, mode === 'dark' ? black : white, mode === 'dark' ? 0.84 : 0.88);
    const chromeRgb = mix(themeColour, black, 0.72);
    const panelRgb = mix(themeColour, black, 0.82);
    for (let channel = 0; channel < 3; channel++) {
      surface[channel] = Math.round(surfaceRgb[channel] ?? 0);
      chrome[channel] = Math.round(chromeRgb[channel] ?? 0);
      panel[channel] = Math.round(panelRgb[channel] ?? 0);
    }
    set('chrome-rgb', chrome.slice(0, 3).join(', '));
    set('theme-tint', css(themeColour));
    set('theme-ink', css(mix(themeColour, mode === 'dark' ? white : black, mode === 'dark' ? 0.95 : 0.85)));
  }
  if (oled) {
    surface[0] = surface[1] = surface[2] = 0;
    surface[3] = 1;
    panel[0] = panel[1] = panel[2] = 0;
    panel[3] = 1;
    set('oled-panel', css(black));
  }
  if (opacity !== null) surface[3] = opacity / 100;
  if (chromeOpacity !== null) chrome[3] = chromeOpacity / 100;
  const defaultChromeOpacity = mode === 'dark' ? 0.76 : 0.84;
  const defaultChromeChanged = !solid && chromeOpacity === null && chrome[3] > defaultChromeOpacity;
  if (defaultChromeChanged) chrome[3] = defaultChromeOpacity;
  if (solid) surface[3] = chrome[3] = panel[3] = 1;
  const tintedSurface = [...mix(surface, preset, tint).slice(0, 3), surface[3]] as Rgba;
  const homeSurface = [...tintedSurface] as Rgba;
  if (!solid && opacity === null) homeSurface[3] = Math.min(homeSurface[3], dark ? 0.9 : 0.76);
  const paneBackgrounds = (value: Rgba) =>
    [value, mix(value, preset, 0.08), mix(value, preset, 0.2)].flatMap((background) => backgrounds(background));
  const inkValue = (source.getPropertyValue('--desktop-base-ink') || source.getPropertyValue('--desktop-ink')).trim();
  const paneInk = themeColour ? colour(next.get('theme-ink') ?? '') : inkValue ? colour(inkValue) : mode === 'dark' ? white : black;
  while (opacity === null && homeSurface[3] < 1 && !paneBackgrounds(homeSurface).every((background) => contrast(paneInk, background) >= 4.65))
    homeSurface[3] = Math.min(1, Math.round((homeSurface[3] + 0.01) * 100) / 100);
  set('home-surface', css(homeSurface));
  // The main window has a denser fill. Home retains its existing material.
  const paneSurface =
    opacity === null && !solid
      ? ([...mix([...tintedSurface.slice(0, 3), 1] as Rgba, white, dark ? 0 : 0.45).slice(0, 3), 0.95] as Rgba)
      : ([...tintedSurface] as Rgba);
  while (opacity === null && paneSurface[3] < 1 && !paneBackgrounds(paneSurface).every((background) => contrast(paneInk, background) >= 4.65))
    paneSurface[3] = Math.min(1, Math.round((paneSurface[3] + 0.01) * 100) / 100);
  const paneChanged = homeSurface[3] !== tintedSurface[3] || css(paneSurface) !== css(tintedSurface);
  set('pane-surface', css(paneSurface));
  // Photo presets already define their chrome tint separately from the panel.
  const defaultChromeTint = themeColour ? 0.14 : Number(source.getPropertyValue('--desktop-base-chrome-tint').trim() || '0.14');
  const chromeTint = dark && !solid && !customMaterial ? defaultChromeTint : tint;
  const guardedGlass = !solid && (chromeOpacity !== null || dark);
  const chromePaint: Rgba = guardedGlass ? [chrome[0], chrome[1], chrome[2], 1] : chrome;
  const tintedPaint = mix(chromePaint, preset, chromeTint);
  const darkChrome = dark && !oled;
  const shade = darkChrome ? 0.25 : 1;
  const originalChrome = [...tintedPaint.slice(0, 3).map((channel) => channel * shade), chrome[3]] as Rgba;
  let tintedChrome = originalChrome;
  const chromeInk = colour(source.getPropertyValue('--desktop-chrome-ink').trim());
  const controlBackgrounds = (paint: Rgba, brightness: number, highlight: number) =>
    backgrounds(paint, 255 * brightness).flatMap((background) => [background, mix(background, white, highlight)]);
  const highlight = guardedGlass ? 0.24 : 0.2;
  const hasChromeContrast = (paint: Rgba, brightness: number) =>
    controlBackgrounds(paint, brightness, highlight).every((background) => contrast(chromeInk, background) >= 4.65);
  // Keep the underlying scene dim in Dark while leaving the requested tint alpha untouched.
  let brightness = dark && guardedGlass ? 0.22 : 1;
  let chromeAdjusted = false;
  // Bound the tint once at full opacity. For custom glass, any remaining glare
  // comes from the backdrop, including light page content under sticky chrome.
  for (let shade = 0; shade <= 100; shade += 1) {
    tintedChrome = [
      Math.round(originalChrome[0] * (1 - shade / 100)),
      Math.round(originalChrome[1] * (1 - shade / 100)),
      Math.round(originalChrome[2] * (1 - shade / 100)),
      originalChrome[3],
    ];
    chromeAdjusted = shade > 0;
    const reference: Rgba = guardedGlass ? [tintedChrome[0], tintedChrome[1], tintedChrome[2], 1] : tintedChrome;
    if (hasChromeContrast(reference, 1)) break;
  }
  if (guardedGlass && !hasChromeContrast(tintedChrome, brightness)) {
    let lower = 0;
    let upper = Math.round(brightness * 100);
    while (upper - lower > 1) {
      const percent = Math.floor((lower + upper) / 2);
      if (hasChromeContrast(tintedChrome, percent / 100)) lower = percent;
      else upper = percent;
    }
    brightness = lower / 100;
  }
  if (brightness < 1) {
    set('chrome-backdrop-brightness', `brightness(${brightness})`);
    set('tray-chrome-filter', 'var(--desktop-glass-chrome-filter)');
  }
  const chromeBackgrounds = controlBackgrounds(tintedChrome, brightness, highlight);
  const menuSurface: Rgba = darkChrome
    ? tintedChrome
    : ([...tintedSurface.slice(0, 3), solid ? 1 : Math.max(0.8, Math.min(0.86, tintedSurface[3]))] as Rgba);
  set('menu-surface', css(menuSurface));
  const menuBackgrounds = darkChrome
    ? [menuSurface, mix(menuSurface, preset, 0.2)].flatMap((background) => backgrounds(background, 255 * brightness))
    : [menuSurface, mix(menuSurface, preset, 0.2), mix(surface, paneInk, 0.12)].flatMap((background) => backgrounds(background));
  set('menu-muted', css(readable(base('muted'), menuBackgrounds, dark)));
  if (materialChanged) {
    set('surface', css(tintedSurface));
    set('panel-dark', css([...mix(panel, preset, tint).slice(0, 3), panel[3]] as Rgba));
  }
  if (materialChanged || darkChrome || chromeAdjusted || defaultChromeChanged || chromeTint > 0) set('chrome', css(tintedChrome));
  if (solid || blur === 0) set('glass-filter', 'none');
  else if (blur !== null) set('glass-filter', `blur(${blur}px) saturate(1.2)`);
  const chromeBlur = customMaterial ? numeric('chromeBlur', 0, 64) : null;
  if (solid || chromeBlur === 0) set('chrome-filter', 'none');
  else if (chromeBlur !== null) set('chrome-filter', `blur(${chromeBlur}px) saturate(1.2)`);

  if (brightness < 1 && (chromeBlur === 0 || (chromeBlur === null && blur === 0))) set('glass-chrome-blur', 'blur(0px)');

  const accent = typeof options.accent === 'string' && /^#[a-f0-9]{6}$/i.test(options.accent) ? colour(options.accent) : themeColour;
  set('chrome-muted', css(readable(mix(chromeInk, originalChrome, 0.25), chromeBackgrounds, true)));
  set('chrome-focus', css(readable(accent ?? base('focus'), chromeBackgrounds, true, 3.1)));
  root.dataset.orbisColourCustom = materialChanged || accent ? 'true' : 'false';
  if (!materialChanged && !accent && !paneChanged) {
    commit();
    return;
  }
  const behind = [...paneBackgrounds(tintedSurface), ...paneBackgrounds(paneSurface), ...paneBackgrounds(homeSurface)];
  const foreground = readable(accent ?? base('accent'), behind, dark);
  set('accent', css(foreground));
  set('focus', css(foreground));
  set('muted', css(readable(base('muted'), behind, dark)));
  if (materialChanged || paneChanged) {
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
  commit();
}
