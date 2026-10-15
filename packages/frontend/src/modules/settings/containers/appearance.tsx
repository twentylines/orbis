import {
  defaultDesktopPreferences,
  isPreferences,
  normalisePreferences,
  useDesktopPreferences,
  type DesktopPreferences,
} from '@/desktop/preferences';
import { useEffect, useRef, useState } from 'react';
import { IconMoonStars, IconSunHigh } from '@tabler/icons-react';
import './appearance.css';

const presets: { value: DesktopPreferences['preset']; title: string; description: string }[] = [
  { value: 'frost', title: 'Frost', description: 'Pale green' },
  { value: 'graphite', title: 'Graphite', description: 'Dark grey' },
  { value: 'forest', title: 'Forest', description: 'Sage green' },
  { value: 'stone', title: 'Warm stone', description: 'Beige' },
  { value: 'ocean', title: 'Ocean', description: 'Blue green' },
  { value: 'blush', title: 'Blush', description: 'Rose' },
];

const wallpapers: { value: DesktopPreferences['wallpaper']; title: string }[] = [
  { value: 'sandstone', title: 'Sandstone' },
  { value: 'tidal', title: 'Tidal' },
  { value: 'canopy', title: 'Canopy' },
];

export const Appearance = () => {
  const { preferences, update, reset, syncState } = useDesktopPreferences();
  const [name, setName] = useState(preferences.serverName);
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setName(preferences.serverName), [preferences.serverName]);

  const changePreset = (preset: DesktopPreferences['preset']) => {
    update({ preset, mode: preset === 'graphite' ? 'dark' : 'light' });
    setMessage(`${presets.find((item) => item.value === preset)?.title} applied.`);
  };

  const saveName = () => {
    const value = name.trim();
    if (!value || value.length > 40) {
      setMessage('Use a name between 1 and 40 characters.');
      return;
    }
    update({ serverName: value });
    setMessage('Server name updated.');
  };

  const exportSettings = () => {
    const blob = new Blob([JSON.stringify(preferences, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'orbis-appearance-workspace.json';
    link.click();
    URL.revokeObjectURL(url);
    setMessage('Appearance and workspace settings exported.');
  };

  const importSettings = async (file?: File) => {
    if (!file) return;
    if (file.size > 16 * 1024) {
      setMessage('The settings file is too large.');
      return;
    }
    try {
      const value: unknown = JSON.parse(await file.text());
      if (!isPreferences(value)) throw new Error('Invalid appearance settings');
      update(normalisePreferences(value));
      setName(value.serverName);
      setMessage('Appearance and workspace settings imported.');
    } catch {
      setMessage('This file does not contain valid appearance settings.');
    }
  };

  return (
    <div className="appearance">
      <output className="appearance-note">
        {syncState === 'saved'
          ? 'Synced to your account'
          : syncState === 'saving'
            ? 'Saving changes…'
            : syncState === 'loading'
              ? 'Loading your preferences…'
              : syncState === 'error'
                ? 'Sync unavailable. Changes are cached in this browser.'
                : 'Saved in this browser'}
      </output>
      <section className="appearance-section" aria-labelledby="appearance-server-name">
        <div>
          <h2 id="appearance-server-name">Server name</h2>
          <p>Shown in the system bar and workspace.</p>
        </div>
        <div className="appearance-name">
          <div>
            <input
              id="desktop-server-name"
              aria-labelledby="appearance-server-name"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
            />
            <button type="button" onClick={saveName}>
              Save name
            </button>
          </div>
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-preset">
        <div>
          <h2 id="appearance-preset">Colour preset</h2>
          <p>Applies to windows, menus, and notifications.</p>
        </div>
        <div className="appearance-presets">
          {presets.map(({ value, title, description }) => (
            <button
              key={value}
              type="button"
              className={`appearance-preset appearance-preset-${value}`}
              aria-pressed={preferences.preset === value}
              onClick={() => changePreset(value)}
            >
              <span className="appearance-swatch" aria-hidden="true" />
              <strong>{title}</strong>
              <small>{description}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-mode">
        <div>
          <h2 id="appearance-mode">Light & dark</h2>
        </div>
        <div className="appearance-modes">
          <button
            type="button"
            className="appearance-mode appearance-mode-light"
            aria-pressed={preferences.mode === 'light'}
            onClick={() => update({ mode: 'light' })}
          >
            <IconSunHigh size={24} stroke={1.5} aria-hidden="true" />
            <span>
              <strong>Light</strong>
            </span>
          </button>
          <button
            type="button"
            className="appearance-mode appearance-mode-dark"
            aria-pressed={preferences.mode === 'dark'}
            onClick={() => update({ mode: 'dark' })}
          >
            <IconMoonStars size={24} stroke={1.5} aria-hidden="true" />
            <span>
              <strong>Dark</strong>
            </span>
          </button>
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-wallpaper">
        <div>
          <h2 id="appearance-wallpaper">Wallpaper</h2>
          <p>Wallpapers are stored on this server.</p>
        </div>
        <div className="appearance-wallpapers">
          {wallpapers.map(({ value, title }) => (
            <button
              key={value}
              type="button"
              className="appearance-wallpaper"
              aria-pressed={preferences.wallpaper === value}
              onClick={() => update({ wallpaper: value })}
            >
              <span className={`appearance-wallpaper-preview appearance-wallpaper-${value}`} aria-hidden="true" />
              <strong>{title}</strong>
            </button>
          ))}
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-density">
        <div>
          <h2 id="appearance-density">Density</h2>
          <p>Change spacing without reducing text size.</p>
        </div>
        <div className="appearance-choice">
          <button type="button" aria-pressed={preferences.density === 'comfortable'} onClick={() => update({ density: 'comfortable' })}>
            Comfortable
          </button>
          <button type="button" aria-pressed={preferences.density === 'compact'} onClick={() => update({ density: 'compact' })}>
            Compact
          </button>
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-transfer">
        <div>
          <h2 id="appearance-transfer">Import and export</h2>
          <p>Export or import theme and workspace settings. Credentials are excluded.</p>
        </div>
        <div className="appearance-actions">
          <button type="button" onClick={exportSettings}>
            Export settings
          </button>
          <button type="button" onClick={() => inputRef.current?.click()}>
            Import settings
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            aria-label="Select appearance and workspace settings file"
            onChange={(event) => {
              void importSettings(event.target.files?.[0]);
              event.target.value = '';
            }}
            hidden
          />
          <button
            type="button"
            onClick={() => {
              reset();
              setName(defaultDesktopPreferences.serverName);
              setMessage('Appearance and workspace restored to defaults.');
            }}
          >
            Restore all defaults
          </button>
        </div>
      </section>
      <output className="appearance-feedback" aria-live="polite">
        {message}
      </output>
    </div>
  );
};
