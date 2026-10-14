import { defaultDesktopPreferences, isPreferences, useDesktopPreferences, type DesktopPreferences } from '@/desktop/preferences';
import { useUIStore } from '@/stores/ui-store';
import { useRef, useState } from 'react';
import './appearance.css';

const presets: { value: DesktopPreferences['preset']; title: string; description: string }[] = [
  { value: 'frost', title: 'Frost', description: 'Soft mineral light' },
  { value: 'graphite', title: 'Graphite', description: 'Deep charcoal' },
  { value: 'forest', title: 'Forest', description: 'Cool sage' },
  { value: 'stone', title: 'Warm stone', description: 'Sand and clay' },
];

export const Appearance = () => {
  const { preferences, update, reset, syncState } = useDesktopPreferences();
  const setDarkMode = useUIStore((state) => state.setDarkMode);
  const [name, setName] = useState(preferences.serverName);
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const changePreset = (preset: DesktopPreferences['preset']) => {
    update({ preset });
    setDarkMode(preset === 'graphite');
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
    link.download = 'server-desktop-appearance.json';
    link.click();
    URL.revokeObjectURL(url);
    setMessage('Appearance settings exported.');
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
      update(value);
      setName(value.serverName);
      setDarkMode(value.preset === 'graphite');
      setMessage('Appearance settings imported.');
    } catch {
      setMessage('This file does not contain valid appearance settings.');
    }
  };

  return (
    <div className="appearance">
      <div className="desktop-view-heading">
        <div>
          <p>Personalisation</p>
          <h1>Appearance & workspace</h1>
        </div>
      </div>
      <p className="appearance-note">
        Appearance is saved to your account and cached in this browser. Sync: {syncState}. Orbis server settings remain in the General tab.
      </p>
      <section className="appearance-section" aria-labelledby="appearance-server-name">
        <div>
          <h2 id="appearance-server-name">Server name</h2>
          <p>Shown in the system bar. Name this server so you can recognize it later.</p>
        </div>
        <div className="appearance-name">
          <label htmlFor="desktop-server-name">Display name</label>
          <div>
            <input id="desktop-server-name" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
            <button type="button" onClick={saveName}>
              Save name
            </button>
          </div>
        </div>
      </section>
      <section className="appearance-section" aria-labelledby="appearance-preset">
        <div>
          <h2 id="appearance-preset">Material & colour</h2>
          <p>Choose a preset for the workspace and application surfaces.</p>
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
          <h2 id="appearance-transfer">Keep a copy</h2>
          <p>Export or import appearance settings. The file contains no credentials.</p>
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
            aria-label="Select appearance settings file"
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
              setDarkMode(false);
              setMessage('Appearance restored to defaults.');
            }}
          >
            Restore defaults
          </button>
        </div>
      </section>
      <output className="appearance-feedback" aria-live="polite">
        {message}
      </output>
    </div>
  );
};
