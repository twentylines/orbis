import { Switch } from '@/components/ui/Switch';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useReducedTransparency } from '@/desktop/motion-preferences';
import { useLayoutEffect, useRef, useState } from 'react';
import { AppearanceRange } from './appearance-controls';

export function MaterialSettings() {
  const { preferences, resolvedMode, updateAppearance } = useDesktopPreferences();
  const value = preferences.appearance;
  const systemSolid = useReducedTransparency();
  const section = useRef<HTMLElement>(null);
  const [colour, setColour] = useState(value.accent ?? '#914725');
  const [message, setMessage] = useState('');
  const [defaults, setDefaults] = useState({ surface: 92, chrome: 82 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Palette and mode change the inherited CSS defaults.
  useLayoutEffect(() => {
    if (!section.current) return;
    const style = getComputedStyle(section.current);
    const alpha = (token: string, fallback: number) => {
      const match = style.getPropertyValue(token).match(/,\s*([\d.]+)\s*\)$/);
      return match ? Math.round(Number(match[1]) * 100) : fallback;
    };
    setDefaults({ surface: alpha('--desktop-base-surface', 92), chrome: alpha('--desktop-base-chrome', 82) });
    const inherited = style.getPropertyValue('--desktop-base-accent').trim();
    setColour(value.accent ?? (/^#[a-f0-9]{6}$/i.test(inherited) ? inherited : '#914725'));
    setMessage('');
  }, [preferences.preset, resolvedMode, value.accent]);
  const setAccent = (next: string) => {
    setColour(next);
    if (/^#[a-f0-9]{6}$/i.test(next)) {
      updateAppearance({ accent: next });
      setMessage('');
    }
  };
  const opaque = value.lowEffects || value.transparency === 'solid' || (value.transparency === 'system' && systemSolid);
  return (
    <>
      <section ref={section} className="appearance-section" aria-labelledby="appearance-accent">
        <div>
          <h2 id="appearance-accent">Accent colour</h2>
          <p>Used for buttons and links. Colours are adjusted for readable text.</p>
        </div>
        <div className="appearance-material-controls">
          <div className="appearance-accent-controls">
            <input
              type="color"
              aria-label="Choose accent colour"
              value={/^#[a-f0-9]{6}$/i.test(colour) ? colour : '#914725'}
              onChange={(event) => setAccent(event.target.value)}
            />
            <input
              type="text"
              className="appearance-colour-value"
              aria-label="Accent hex value"
              aria-invalid={Boolean(message)}
              aria-describedby={message ? 'appearance-accent-error' : undefined}
              maxLength={7}
              spellCheck={false}
              autoComplete="off"
              value={colour}
              onChange={(event) => setAccent(event.target.value)}
              onBlur={() => {
                if (!/^#[a-f0-9]{6}$/i.test(colour)) setMessage('Use six hexadecimal digits, for example #4c74b8.');
              }}
            />
            <button
              type="button"
              onClick={() => {
                const inherited = section.current ? getComputedStyle(section.current).getPropertyValue('--desktop-base-accent').trim() : '#914725';
                setColour(inherited);
                setMessage('');
                updateAppearance({ accent: null });
              }}
            >
              Use preset colour
            </button>
          </div>
          {message ? (
            <p id="appearance-accent-error" className="appearance-upload-message" role="alert">
              {message}
            </p>
          ) : null}
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-glass">
        <div>
          <h2 id="appearance-glass">Glass</h2>
          <p>Adjust panels, the system bar, dock, menus and notifications.</p>
        </div>
        <div className="appearance-material-controls">
          <div className="appearance-range-grid">
            <AppearanceRange
              label="Panel opacity"
              min={90}
              max={100}
              value={value.surfaceOpacity ?? defaults.surface}
              disabled={opaque}
              onChange={(surfaceOpacity) => updateAppearance({ surfaceOpacity })}
            />
            <AppearanceRange
              label="Bar and dock opacity"
              min={80}
              max={100}
              value={value.chromeOpacity ?? defaults.chrome}
              disabled={opaque}
              onChange={(chromeOpacity) => updateAppearance({ chromeOpacity })}
            />
            <AppearanceRange
              label="Glass blur"
              max={40}
              unit="px"
              value={value.glassBlur ?? 28}
              disabled={opaque}
              onChange={(glassBlur) => updateAppearance({ glassBlur })}
            />
            <AppearanceRange label="Glass tint" max={30} value={value.glassTint ?? 0} onChange={(glassTint) => updateAppearance({ glassTint })} />
          </div>
          {opaque ? <p>Solid surfaces are enabled. Opacity and blur will apply when glass is enabled.</p> : null}
          <div className="appearance-actions">
            <button type="button" onClick={() => updateAppearance({ surfaceOpacity: null, chromeOpacity: null, glassBlur: null, glassTint: null })}>
              Reset glass
            </button>
          </div>
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-motion">
        <div>
          <h2 id="appearance-motion">Motion</h2>
          <p>Reduce movement in navigation, app windows and the server rack.</p>
        </div>
        <div className="appearance-material-controls">
          <fieldset className="appearance-choice" aria-label="Motion preference">
            <button type="button" aria-pressed={value.motion === 'system'} onClick={() => updateAppearance({ motion: 'system' })}>
              Follow system
            </button>
            <button type="button" aria-pressed={value.motion === 'reduced'} onClick={() => updateAppearance({ motion: 'reduced' })}>
              Reduce motion
            </button>
          </fieldset>
          {value.lowEffects ? <p>Low effects also reduces movement.</p> : null}
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-transparency">
        <div>
          <h2 id="appearance-transparency">Surfaces</h2>
          <p>Use solid surfaces when you prefer less background detail.</p>
        </div>
        <fieldset className="appearance-choice" aria-label="Transparency preference">
          <button type="button" aria-pressed={value.transparency === 'system'} onClick={() => updateAppearance({ transparency: 'system' })}>
            Follow system
          </button>
          <button type="button" aria-pressed={value.transparency === 'glass'} onClick={() => updateAppearance({ transparency: 'glass' })}>
            Glass
          </button>
          <button type="button" aria-pressed={value.transparency === 'solid'} onClick={() => updateAppearance({ transparency: 'solid' })}>
            Solid
          </button>
        </fieldset>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-effects">
        <div>
          <h2 id="appearance-effects">Effects</h2>
          <p>Disable blur, shadows and decorative motion on slower devices.</p>
        </div>
        <div className="appearance-low-effects">
          <Switch label="Low effects" checked={value.lowEffects} onCheckedChange={(lowEffects) => updateAppearance({ lowEffects })} />
        </div>
      </section>
    </>
  );
}
