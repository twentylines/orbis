import { desktopMaterialForMode } from '@/desktop/appearance-cache';
import { Switch } from '@/components/ui/Switch';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useReducedTransparency } from '@/desktop/motion-preferences';
import { useEffect, useId, useRef, useState } from 'react';
import { AppearanceRange } from './appearance-controls';
import { applyAppearanceRuntime } from '@/desktop/appearance-runtime';
import { wallpaperColourOverrides } from '@/desktop/wallpaper-presets';
import type { DesktopMaterial } from '@runtipi/common/schemas/desktop-appearance';
import { ColourPicker } from '@/components/ui/ColourPicker/ColourPicker';
import { themePackAppearanceSnapshot, type ThemePackAppearance } from '@/modules/theme-packs/theme-pack-cache';
import { themePackAppearance } from '@/modules/theme-packs/theme-pack-runtime';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';

function effectiveOpacity(style: CSSStyleDeclaration, property: string) {
  const rgba = style.getPropertyValue(property).match(/,\s*([\d.]+)\s*\)$/);
  return rgba ? Math.round(Number(rgba[1]) * 100) : null;
}

const HEX_COLOUR = /^#[a-f0-9]{6}$/i;

function AppearanceColourSetting({
  appearanceKey,
  title,
  description,
  presetToken,
  fallback,
}: {
  appearanceKey: 'themeColour' | 'accent';
  title: string;
  description: string;
  presetToken: string;
  fallback: string;
}) {
  const { preferences, resolvedMode, activeThemePack, updateAppearance } = useDesktopPreferences();
  const saved = preferences.appearance[appearanceKey];
  const section = useRef<HTMLElement>(null);
  const id = appearanceKey === 'accent' ? 'appearance-accent' : 'appearance-theme-colour';
  const [presetColour, setPresetColour] = useState(fallback);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Palette and mode set the inherited preset colour.
  useEffect(() => {
    const inherited = section.current ? getComputedStyle(section.current).getPropertyValue(presetToken).trim() : '';
    setPresetColour(HEX_COLOUR.test(inherited) ? inherited : fallback);
  }, [preferences.preset, resolvedMode, activeThemePack?.id, activeThemePack?.version, presetToken, fallback]);
  const save = (next: string | null) => {
    if (next !== saved) updateAppearance({ [appearanceKey]: next });
  };
  return (
    <section id={id} ref={section} className="appearance-custom-colour" aria-labelledby={`${id}-title`}>
      <div>
        <h3 id={`${id}-title`}>{title}</h3>
        <p>{description}</p>
      </div>
      <ColourPicker
        label={title}
        value={saved ?? presetColour}
        sourceKey={JSON.stringify([preferences.preset, resolvedMode, activeThemePack?.id, activeThemePack?.version, saved])}
        onChange={save}
        onReset={() => save(null)}
      />
    </section>
  );
}

export function ColourSettings() {
  const { preferences, displayedWallpaperColours, updateAppearance } = useDesktopPreferences();
  const auto = preferences.appearance.wallpaperColours;
  const disclosure = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);

  const takeOver = () => {
    const style = displayedWallpaperColours?.preset && disclosure.current ? getComputedStyle(disclosure.current) : null;
    const current = (token: string, extracted?: string) => {
      const inherited = style?.getPropertyValue(token).trim() ?? '';
      return HEX_COLOUR.test(inherited) ? inherited : extracted;
    };
    const themeColour = current('--desktop-base-preset-tint', displayedWallpaperColours?.themeColour);
    const accent = current('--desktop-base-accent', displayedWallpaperColours?.accent);
    updateAppearance({ wallpaperColours: false, ...(themeColour ? { themeColour } : {}), ...(accent ? { accent } : {}) });
    summary.current?.focus();
  };

  return (
    <>
      <div id="appearance-colours" className="appearance-auto-colours">
        <Switch
          label="Auto"
          aria-describedby="appearance-auto-description"
          checked={auto}
          onCheckedChange={(wallpaperColours) => updateAppearance({ wallpaperColours })}
        />
        <p id="appearance-auto-description">Use the wallpaper’s colours.</p>
      </div>
      <details ref={disclosure} id="appearance-custom-colours" className="appearance-custom-colours">
        <summary ref={summary}>Custom colours</summary>
        <div className="appearance-custom-colour-controls">
          {auto ? (
            <div className="appearance-actions">
              <button type="button" data-colour-takeover onClick={takeOver}>
                Use manual colours
              </button>
            </div>
          ) : (
            <>
              <AppearanceColourSetting
                appearanceKey="themeColour"
                title="Theme colour"
                description="Tint panels, bars and other surfaces."
                presetToken="--desktop-base-preset-tint"
                fallback="#597b73"
              />
              <AppearanceColourSetting
                appearanceKey="accent"
                title="Accent colour"
                description="Used for buttons and links."
                presetToken="--desktop-base-accent"
                fallback="#914725"
              />
            </>
          )}
        </div>
      </details>
    </>
  );
}

export function MaterialSettings() {
  const { preferences, resolvedMode, activeThemePack, displayedWallpaperColours, updateAppearance } = useDesktopPreferences();
  const appearance = preferences.appearance;
  const materialKey = resolvedMode === 'dark' ? 'darkMaterial' : 'lightMaterial';
  const material = desktopMaterialForMode(appearance, resolvedMode);
  const value = { ...appearance, ...material };
  const updateMaterial = (patch: DesktopMaterial) => updateAppearance({ [materialKey]: patch });
  const systemSolid = useReducedTransparency();
  const systemTransparency =
    matchMedia('(prefers-reduced-transparency: reduce)').matches || matchMedia('(prefers-reduced-transparency: no-preference)').matches;
  const customControls = useId();
  const showCustom = value.materialMode === 'custom' && value.transparency !== 'solid';
  const dark = resolvedMode === 'dark';
  const oled = dark && value.oledDark;
  const opaque = oled || value.lowEffects || value.transparency === 'solid' || (value.transparency === 'system' && systemSolid);
  const [defaultOpacity, setDefaultOpacity] = useState<{ panel: number | null; chrome: number | null }>({ panel: null, chrome: null });
  const previewPack = useRef<ThemePackAppearance | null>(null);
  const packId = activeThemePack?.id;
  const packVersion = activeThemePack?.version;
  useEffect(() => {
    const cachedPack = packId ? themePackAppearanceSnapshot() : null;
    previewPack.current = cachedPack?.id === packId && cachedPack?.version === packVersion ? cachedPack : null;
  }, [packId, packVersion]);
  const preview = (key: keyof Omit<DesktopMaterial, 'transparency' | 'materialMode'>) => (next: number) => {
    const colours = wallpaperColourOverrides(value.wallpaperColours ? displayedWallpaperColours : null);
    applyAppearanceRuntime(themePackAppearance(previewPack.current, { ...value, ...colours, [key]: next }), resolvedMode);
  };
  const section = useRef<HTMLElement>(null);
  // Read the effective glass defaults when no saved numeric request overrides them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Appearance context reapplies tokens when the palette or material changes.
  useEffect(() => {
    if (!section.current || !showCustom || opaque) return;
    const style = getComputedStyle(section.current);
    setDefaultOpacity({
      panel: value.surfaceOpacity === null ? effectiveOpacity(style, '--desktop-pane-surface') : null,
      chrome: value.chromeOpacity === null ? effectiveOpacity(style, '--desktop-chrome') : null,
    });
  }, [
    showCustom,
    opaque,
    resolvedMode,
    preferences.preset,
    activeThemePack?.id,
    activeThemePack?.version,
    value.surfaceOpacity,
    value.chromeOpacity,
    value.glassTint,
    value.themeColour,
    displayedWallpaperColours,
  ]);
  const selectMaterial = (transparency: Required<DesktopMaterial>['transparency'], materialMode: Required<DesktopMaterial>['materialMode']) => {
    if (value.transparency !== transparency || value.materialMode !== materialMode) updateMaterial({ transparency, materialMode });
  };
  return (
    <>
      <section ref={section} className="appearance-section" aria-labelledby="appearance-glass">
        <div>
          <h2 id="appearance-glass">Surfaces</h2>
          <p>Choose how much of the wallpaper shows through in {dark ? 'Dark' : 'Light'} mode.</p>
        </div>
        <div className="appearance-material-controls appearance-surface-options">
          <SelectionGroup as="fieldset" className="appearance-choice appearance-surface-choices" aria-label="Transparency preference">
            {systemTransparency ? (
              <button type="button" aria-pressed={!showCustom && value.transparency === 'system'} onClick={() => selectMaterial('system', 'default')}>
                Use device setting
              </button>
            ) : null}
            <button
              type="button"
              aria-pressed={!showCustom && (value.transparency === 'glass' || (!systemTransparency && value.transparency === 'system'))}
              onClick={() => selectMaterial('glass', 'default')}
            >
              Transparent
            </button>
            <button type="button" aria-pressed={value.transparency === 'solid'} onClick={() => selectMaterial('solid', 'default')}>
              Solid
            </button>
            <button
              type="button"
              aria-pressed={showCustom}
              aria-expanded={showCustom}
              aria-controls={customControls}
              onClick={() => selectMaterial('glass', 'custom')}
            >
              Custom
            </button>
          </SelectionGroup>
          <div className="appearance-custom-controls" data-expanded={showCustom}>
            <div className="appearance-custom-clip" inert={!showCustom}>
              <section key={resolvedMode} id={customControls} className="appearance-custom-content" aria-label="Custom surface controls">
                <div className="appearance-range-grid">
                  <AppearanceRange
                    label="Panel opacity"
                    max={100}
                    value={value.surfaceOpacity ?? defaultOpacity.panel ?? 95}
                    disabled={opaque}
                    onPreview={preview('surfaceOpacity')}
                    onChange={(surfaceOpacity) => updateMaterial({ surfaceOpacity })}
                  />
                  <AppearanceRange
                    label="Bar and dock opacity"
                    max={100}
                    value={value.chromeOpacity ?? defaultOpacity.chrome ?? (dark ? 76 : 84)}
                    disabled={opaque}
                    onPreview={preview('chromeOpacity')}
                    onChange={(chromeOpacity) => updateMaterial({ chromeOpacity })}
                  />
                  <AppearanceRange
                    label="Panel blur"
                    max={40}
                    unit="px"
                    value={value.glassBlur ?? 36}
                    disabled={opaque}
                    onPreview={preview('glassBlur')}
                    onChange={(glassBlur) => updateMaterial({ glassBlur })}
                  />
                  <AppearanceRange
                    label="Bar and dock blur"
                    max={64}
                    unit="px"
                    value={value.chromeBlur ?? value.glassBlur ?? (dark ? 14 : 16)}
                    disabled={opaque}
                    onPreview={preview('chromeBlur')}
                    onChange={(chromeBlur) => updateMaterial({ chromeBlur })}
                  />
                  <AppearanceRange
                    label="Panel tint"
                    max={30}
                    value={value.glassTint ?? 0}
                    disabled={opaque}
                    onPreview={preview('glassTint')}
                    onChange={(glassTint) => updateMaterial({ glassTint })}
                  />
                </div>
                {opaque ? <p>{oled ? 'OLED uses black panels.' : 'Custom controls apply when transparency is enabled.'}</p> : null}
                <div className="appearance-actions">
                  <button
                    type="button"
                    disabled={[value.surfaceOpacity, value.chromeOpacity, value.glassBlur, value.chromeBlur, value.glassTint].every(
                      (item) => item === null,
                    )}
                    onClick={() => updateMaterial({ surfaceOpacity: null, chromeOpacity: null, glassBlur: null, chromeBlur: null, glassTint: null })}
                  >
                    Reset custom controls
                  </button>
                </div>
              </section>
            </div>
          </div>
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-motion">
        <div>
          <h2 id="appearance-motion">Motion</h2>
          <p>Reduce movement in navigation, app windows and the server rack.</p>
        </div>
        <div className="appearance-material-controls">
          <SelectionGroup as="fieldset" className="appearance-choice" aria-label="Motion preference">
            <button type="button" aria-pressed={value.motion === 'system'} onClick={() => updateAppearance({ motion: 'system' })}>
              Follow system
            </button>
            <button type="button" aria-pressed={value.motion === 'reduced'} onClick={() => updateAppearance({ motion: 'reduced' })}>
              Reduce motion
            </button>
          </SelectionGroup>
          {value.lowEffects ? <p>Energy saving also reduces movement.</p> : null}
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-effects">
        <div>
          <h2 id="appearance-effects">Performance</h2>
          <p>Choose energy saving when you prefer solid surfaces and reduced movement.</p>
        </div>
        <div className="appearance-low-effects">
          <Switch label="Energy saving" checked={value.lowEffects} onCheckedChange={(lowEffects) => updateAppearance({ lowEffects })} />
        </div>
      </section>
    </>
  );
}
