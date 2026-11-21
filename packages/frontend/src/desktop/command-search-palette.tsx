import { useState, type CSSProperties } from 'react';
import { useDesktopPreferences } from './preferences';
import { presetLabels, presetWallpaperColours, type ThemePreset } from './wallpaper-presets';

export function SearchPalette({ presets }: { presets: readonly ThemePreset[] }) {
  const { preferences, update, commit, syncState, activeThemePack } = useDesktopPreferences();
  const [attempt, setAttempt] = useState<ThemePreset | null>(null);
  const patch = (preset: ThemePreset) =>
    activeThemePack ? { preset } : { preset, appearance: { ...preferences.appearance, themeColour: null, accent: null, wallpaperColours: false } };
  const select = (preset: ThemePreset) => {
    setAttempt(preset);
    update(patch(preset));
  };
  return (
    <section className="desktop-search-group" aria-label="Colour presets">
      <h3>
        Colour presets<span>{presets.length}</span>
      </h3>
      <div className="desktop-search-palettes">
        {presets.map((preset) => (
          <button
            type="button"
            key={preset}
            data-search-preset
            data-search-result
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              const results = [
                ...(event.currentTarget.closest('.desktop-search-results')?.querySelectorAll<HTMLButtonElement>('[data-search-result]') ?? []),
              ];
              const index = results.indexOf(event.currentTarget);
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? results.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
              if (next < 0) document.getElementById('orbis-command-query')?.focus();
              else results[Math.min(next, results.length - 1)]?.focus();
            }}
            aria-label={`Use ${presetLabels[preset]} colour preset`}
            aria-pressed={
              preferences.preset === preset &&
              (Boolean(activeThemePack) || (!preferences.appearance.themeColour && !preferences.appearance.wallpaperColours))
            }
            disabled={syncState === 'loading'}
            onClick={() => select(preset)}
          >
            <span
              className="desktop-search-palette-swatch"
              aria-hidden="true"
              style={{ '--search-palette-colour': presetWallpaperColours[preset].themeColour } as CSSProperties}
            />
            <strong>{preset === 'stone' ? 'Warm stone' : presetLabels[preset]}</strong>
          </button>
        ))}
      </div>
      {attempt && syncState === 'error' ? (
        <p role="alert">
          This colour could not be saved.{' '}
          <button type="button" onClick={() => void commit(patch(attempt)).catch(() => undefined)}>
            Retry
          </button>
        </p>
      ) : null}
    </section>
  );
}
