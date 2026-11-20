import { ThemePacksCatalogue } from '@/modules/theme-packs/theme-packs-catalogue';
import {
  defaultDesktopPreferences,
  isPreferences,
  normalisePreferences,
  useDesktopPreferences,
  type DesktopPreferences,
} from '@/desktop/preferences';
import { useRef, useState } from 'react';
import { ColourModeChoice } from '@/desktop/colour-mode-choice';
import { WallpaperSettings } from './wallpaper-settings';
import { ColourSettings, MaterialSettings } from './material-settings';
import { preferenceCacheLimit } from '@/desktop/appearance-cache';
import { AppOpeningSettings } from '@/desktop/app-opening-settings';
import { presetLabels, visibleThemePresets } from '@/desktop/wallpaper-presets';
import { AppearanceRange } from './appearance-controls';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import './appearance.css';
import { useDebouncedPreferenceSave } from '../hooks/use-debounced-preference-save';
import { useUserContext } from '@/context/user-context';
import { usePreferenceNameDraft } from '@/desktop/preference-name-draft';

const presetDescriptions: Record<(typeof visibleThemePresets)[number], string> = {
  frost: 'Pale green',
  graphite: 'Neutral grey',
  forest: 'Sage green',
  stone: 'Beige',
  ocean: 'Blue green',
  blush: 'Petal pink',
  burgundy: 'Wine red',
  amber: 'Golden yellow',
  orange: 'Tangerine',
};

export function AppearanceReset({ open, onOpenChange, onReset }: { open: boolean; onOpenChange: (open: boolean) => void; onReset: () => void }) {
  return (
    <>
      <section className="appearance-section" aria-labelledby="appearance-reset">
        <div>
          <h2 id="appearance-reset">Reset customisation</h2>
          <p>Restore the default appearance and workspace settings.</p>
        </div>
        <div className="appearance-actions">
          <Button type="button" variant="outline" data-setting-review="reset-appearance" onClick={() => onOpenChange(true)}>
            Reset
          </Button>
        </div>
      </section>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="md" className="appearance-reset-dialog" aria-describedby="appearance-reset-description">
          <DialogHeader>
            <DialogTitle>Reset customisation?</DialogTitle>
          </DialogHeader>
          <DialogDescription id="appearance-reset-description">
            <p>This restores the defaults for:</p>
            <ul>
              <li>Server display name, colours, light/dark mode, text size and spacing.</li>
              <li>Wallpaper, material effects, motion, clock and dock settings.</li>
              <li>Home layout and pins, saved window positions and sizes, and app-opening preferences.</li>
              <li>Store recommendations and hidden suggestion categories.</li>
            </ul>
            <p>Your selected theme pack and uploaded images are kept. Accounts, installed apps and their data are unchanged.</p>
          </DialogDescription>
          <DialogFooter className="appearance-reset-actions">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              intent="danger"
              onClick={() => {
                onReset();
                onOpenChange(false);
              }}
            >
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const Appearance = () => {
  const { preferences, activeThemePack, cacheAvailable, update, commit, reset, syncState, updateAppearance } = useDesktopPreferences();
  const { sessionAbortSignal } = useUserContext();
  const { name, setName, acknowledge: acknowledgeName } = usePreferenceNameDraft(preferences.serverName);
  const [nameEdit, setNameEdit] = useState<{ draft: string; signal: AbortSignal } | null>(null);
  const [nameInvalid, setNameInvalid] = useState(false);
  const [message, setMessage] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [wallpaperSettingsRevision, setWallpaperSettingsRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const changePreset = (preset: DesktopPreferences['preset']) => {
    setMessage('');
    update(
      activeThemePack ? { preset } : { preset, appearance: { ...preferences.appearance, themeColour: null, accent: null, wallpaperColours: false } },
    );
  };

  const finishName = () => {
    const invalid = !name.trim() || name.trim().length > 40;
    setNameInvalid(invalid);
    if (!invalid) setNameEdit({ draft: name, signal: sessionAbortSignal });
  };
  const submittedName = nameEdit?.signal === sessionAbortSignal && nameEdit.draft === name && name !== preferences.serverName ? name : null;
  const nameSave = useDebouncedPreferenceSave(
    submittedName,
    async () => {
      const serverName = name.trim();
      if (serverName !== preferences.serverName) await commit({ serverName });
      acknowledgeName(name, serverName);
      setNameEdit((edit) => (edit?.draft === name && edit.signal === sessionAbortSignal ? null : edit));
    },
    { delay: 0, signal: sessionAbortSignal, ready: syncState !== 'loading', unsaved: name !== preferences.serverName },
  );

  const exportSettings = () => {
    setMessage('');
    const exported = { ...preferences, appearance: { ...preferences.appearance, wallpaperImage: null } };
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'orbis-appearance-workspace.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const importSettings = async (file?: File) => {
    if (!file) return;
    setMessage('');
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
    } catch {
      setMessage('This file does not contain valid appearance settings.');
    }
  };

  return (
    <div className="appearance">
      {syncState === 'loading' ? <output className="appearance-note">Loading your preferences…</output> : null}
      {syncState === 'error' ? (
        <output className="appearance-note">
          {cacheAvailable ? 'Sync unavailable. Changes are cached in this browser.' : 'Sync unavailable. Changes will be lost when this page closes.'}
        </output>
      ) : null}
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
              aria-invalid={nameInvalid || undefined}
              aria-describedby={nameInvalid ? 'appearance-server-name-error' : undefined}
              value={name}
              maxLength={40}
              onChange={(event) => {
                setNameEdit(null);
                setName(event.target.value);
                setNameInvalid(false);
              }}
              onBlur={finishName}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
          {nameInvalid ? (
            <p id="appearance-server-name-error" role="alert">
              Use a name between 1 and 40 characters.
            </p>
          ) : null}
          {nameSave.error ? (
            <div role="alert">
              <p>{nameSave.error}</p>
              <Button type="button" variant="outline" onClick={nameSave.retry}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </section>
      <div id="setting-theme-packs">
        <ThemePacksCatalogue />
      </div>
      <section className="appearance-section" aria-labelledby="appearance-preset">
        <div>
          <h2 id="appearance-preset">{activeThemePack ? 'Fallback colour preset' : 'Colour presets'}</h2>
          <p>
            {activeThemePack
              ? `${activeThemePack.name} supplies the palette. This preset returns when you stop using the pack. Your custom colours stay in place.`
              : 'Applies to buttons, the logo, panels, menus and notifications. Each preset has light and dark colours.'}
          </p>
        </div>
        <div className="appearance-preset-controls">
          <div className="appearance-presets">
            {visibleThemePresets.map((value) => (
              <button
                key={value}
                type="button"
                className={`appearance-preset appearance-preset-${value}`}
                aria-pressed={
                  preferences.preset === value &&
                  (Boolean(activeThemePack) || (preferences.appearance.themeColour === null && !preferences.appearance.wallpaperColours))
                }
                onClick={() => changePreset(value)}
              >
                <span className="appearance-swatch" aria-hidden="true">
                  <span className="appearance-swatch-light" />
                  <span className="appearance-swatch-dark" />
                </span>
                <strong>{value === 'stone' ? 'Warm stone' : presetLabels[value]}</strong>
                <small>{presetDescriptions[value]}</small>
              </button>
            ))}
          </div>
          <ColourSettings />
        </div>
      </section>
      <WallpaperSettings key={`wallpaper-${wallpaperSettingsRevision}`} />
      <section className="appearance-section" aria-labelledby="appearance-mode">
        <div>
          <h2 id="appearance-mode">Colour mode</h2>
          <p>
            {preferences.mode === 'system' && preferences.appearance.oledDark
              ? 'System uses OLED in dark mode.'
              : 'Follow this device’s setting, or choose a mode.'}
          </p>
        </div>
        <ColourModeChoice
          mode={preferences.mode}
          oledDark={preferences.appearance.oledDark}
          onChange={({ mode, oledDark }) => update({ ...preferences, mode, appearance: { ...preferences.appearance, oledDark } })}
        />
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
      <MaterialSettings key={`material-${wallpaperSettingsRevision}`} />
      <AppOpeningSettings />
      <section className="appearance-section" aria-labelledby="appearance-density">
        <div>
          <h2 id="appearance-density">Density</h2>
          <p>Compact fits more cards and rows by reducing spacing across Home, Apps, Store, Monitor and Settings. Text size stays the same.</p>
        </div>
        <SelectionGroup className="appearance-choice">
          <button type="button" aria-pressed={preferences.density === 'comfortable'} onClick={() => update({ density: 'comfortable' })}>
            Comfortable
          </button>
          <button type="button" aria-pressed={preferences.density === 'compact'} onClick={() => update({ density: 'compact' })}>
            Compact
          </button>
        </SelectionGroup>
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
        </div>
      </section>
      <AppearanceReset
        open={resetOpen}
        onOpenChange={setResetOpen}
        onReset={() => {
          reset();
          setWallpaperSettingsRevision((revision) => revision + 1);
          setName(defaultDesktopPreferences.serverName);
          setMessage('');
        }}
      />
      <output className="appearance-feedback" aria-live="polite">
        {message}
      </output>
    </div>
  );
};
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
