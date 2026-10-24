import {
  defaultDesktopPreferences,
  isPreferences,
  normalisePreferences,
  useDesktopPreferences,
  type DesktopPreferences,
} from '@/desktop/preferences';
import { useEffect, useRef, useState } from 'react';
import { IconDeviceDesktop, IconMoonStars, IconSunHigh } from '@tabler/icons-react';
import { WallpaperSettings } from './wallpaper-settings';
import { MaterialSettings } from './material-settings';
import { preferenceCacheLimit } from '@/desktop/appearance-cache';
import { AppOpeningSettings } from '@/desktop/app-opening-settings';
import { AppearanceRange } from './appearance-controls';
import './appearance.css';

const presets: { value: DesktopPreferences['preset']; title: string; description: string }[] = [
  { value: 'frost', title: 'Frost', description: 'Pale green' },
  { value: 'graphite', title: 'Graphite', description: 'Neutral grey' },
  { value: 'forest', title: 'Forest', description: 'Sage green' },
  { value: 'stone', title: 'Warm stone', description: 'Beige' },
  { value: 'ocean', title: 'Ocean', description: 'Blue green' },
  { value: 'blush', title: 'Blush', description: 'Rose' },
];

export const Appearance = () => {
  const { preferences, cacheAvailable, update, reset, syncState, updateAppearance } = useDesktopPreferences();
  const [name, setName] = useState(preferences.serverName);
  const [message, setMessage] = useState('');
  const [wallpaperSettingsRevision, setWallpaperSettingsRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setName(preferences.serverName), [preferences.serverName]);

  const changePreset = (preset: DesktopPreferences['preset']) => {
    update({ preset, appearance: { ...preferences.appearance, accent: null } });
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
    const exported = { ...preferences, appearance: { ...preferences.appearance, wallpaperImage: null } };
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
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
    if (file.size > preferenceCacheLimit) {
      setMessage('The settings file is too large.');
      return;
    }
    try {
      const value: unknown = JSON.parse(await file.text());
      if (!isPreferences(value)) throw new Error('Invalid appearance settings');
      const imported = normalisePreferences(value);
      update({ ...imported, appearance: { ...imported.appearance, wallpaperImage: null } });
      setWallpaperSettingsRevision((revision) => revision + 1);
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
                ? cacheAvailable
                  ? 'Sync unavailable. Changes are cached in this browser.'
                  : 'Sync unavailable. Changes will be lost when this page closes.'
                : cacheAvailable
                  ? 'Saved in this browser'
                  : 'Changes will be lost when this page closes.'}
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
          <p>Applies to buttons, the logo, panels, menus and notifications. Each preset has light and dark colours.</p>
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
              <span className="appearance-swatch" aria-hidden="true">
                <span className="appearance-swatch-light" />
                <span className="appearance-swatch-dark" />
              </span>
              <strong>{title}</strong>
              <small>{description}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-mode">
        <div>
          <h2 id="appearance-mode">Colour mode</h2>
          <p>Follow this device's setting, or choose a mode.</p>
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
          <button
            type="button"
            className="appearance-mode appearance-mode-system"
            aria-pressed={preferences.mode === 'system'}
            onClick={() => update({ mode: 'system' })}
          >
            <IconDeviceDesktop size={24} stroke={1.5} aria-hidden="true" />
            <span>
              <strong>Follow system</strong>
            </span>
          </button>
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-text">
        <div>
          <h2 id="appearance-text">Text size</h2>
          <p>Change text throughout Orbis. Browser zoom still applies.</p>
        </div>
        <div className="appearance-material-controls">
          <AppearanceRange
            label="Interface text"
            min={85}
            max={150}
            value={preferences.appearance.textScale}
            onChange={(textScale) => updateAppearance({ textScale })}
          />
          <div className="appearance-actions">
            <button type="button" onClick={() => updateAppearance({ textScale: 100 })}>
              Reset text size
            </button>
          </div>
        </div>
      </section>
      <MaterialSettings key={wallpaperSettingsRevision} />
      <WallpaperSettings key={wallpaperSettingsRevision} />
      <AppOpeningSettings />
      <section className="appearance-section" aria-labelledby="appearance-density">
        <div>
          <h2 id="appearance-density">Density</h2>
          <p>Compact fits more cards and rows by reducing spacing across Home, Apps, Store, Monitor and Settings. Text size stays the same.</p>
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
          <p>Export or import theme and workspace settings. Credentials and uploaded images are excluded.</p>
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
              setWallpaperSettingsRevision((revision) => revision + 1);
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
