import { useEffect, useId, useState, type ReactNode } from 'react';
import { interfaceThemeSettingAllows, type InterfaceThemeSetting, type InterfaceThemeValue } from '@runtipi/common/schemas/interface-theme';
import { registeredInterfaceTheme } from '@runtipi/common/schemas/interface-theme-registry';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useSettingsSave } from '@/modules/settings/pages/settings-save';
import type { InterfaceThemeDraft } from './theme-settings-drafts';
import type { InterfaceThemeSession } from './use-interface-theme-session';
import './interface-theme-controls.css';

function NamespaceSave({ draft, session }: { draft: InterfaceThemeDraft; session: InterfaceThemeSession }) {
  useSettingsSave({ section: 'customise', dirty: draft.dirty, pending: session.pending, prepare: () => session.prepare(draft.identity) });
  return null;
}

export function InterfaceThemeSaveEntries({ session }: { session: InterfaceThemeSession }) {
  return (
    <>
      {session.drafts.map((draft) => (
        <NamespaceSave key={`${draft.descriptor.id}:${draft.descriptor.settingsVersion}`} draft={draft} session={session} />
      ))}
    </>
  );
}

export function InterfaceThemePaletteFallback({ session }: { session: InterfaceThemeSession }) {
  const fallback = session.forTheme(null);
  const descriptor = fallback.binding ? registeredInterfaceTheme(fallback.binding.identity) : null;
  const definition = descriptor?.settings.find((setting) => setting.key === 'palette');
  if (!definition || !fallback.binding || session.status !== 'ready' || session.current?.descriptor.kind === 'builtin') return null;
  const value = fallback.binding.values.find((item) => item.key === definition.key)?.value ?? definition.default;
  return (
    <section className="appearance-section">
      <div>
        <h2>Colour preset fallback</h2>
        <p>Used when you stop using this theme. Its choices belong to Orbis.</p>
      </div>
      <ThemeControl
        definition={definition}
        value={value}
        disabled={session.pending}
        session={{ ...session, current: fallback.binding, setValue: fallback.setValue }}
      />
    </section>
  );
}

function readInheritedControls(): Record<string, number | string> {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return {};
  const style = getComputedStyle(document.documentElement);
  const inherited: Record<string, number | string> = {};
  for (const [key, token] of [
    ['panel-opacity', '--desktop-surface'],
    ['chrome-opacity', '--desktop-chrome'],
  ] as const) {
    const match = style.getPropertyValue(token).match(/,\s*([\d.]+)\s*\)$/);
    if (match) inherited[key] = Math.round(Number(match[1]) * 100);
  }
  for (const [key, token] of [
    ['panel-blur', '--desktop-glass-filter'],
    ['chrome-blur', '--desktop-chrome-filter'],
  ] as const) {
    const value = style.getPropertyValue(token).trim();
    const match = value.match(/blur\(([\d.]+)px\)/);
    if (match) inherited[key] = Number(match[1]);
    else if (value === 'none') inherited[key] = 0;
  }
  inherited['panel-tint'] = 0;
  const accent = style.getPropertyValue('--desktop-base-accent').trim();
  if (/^#[a-f0-9]{6}$/i.test(accent)) inherited.accent = accent;
  return inherited;
}

function ThemeControl({
  definition,
  value,
  disabled,
  session,
  inherited = {},
}: {
  definition: InterfaceThemeSetting;
  value: InterfaceThemeValue;
  disabled: boolean;
  session: InterfaceThemeSession;
  inherited?: Record<string, number | string>;
}) {
  const id = useId();
  const valid = interfaceThemeSettingAllows(definition, value);
  const description = definition.help || !valid ? `${id}-help` : undefined;
  if (definition.kind === 'boolean')
    return (
      <div className="interface-theme-control">
        <Switch
          label={definition.label}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(next) => session.setValue(definition.key, next)}
        />
      </div>
    );
  return (
    <div className="interface-theme-control">
      <label htmlFor={id}>{definition.label}</label>
      {definition.kind === 'enum' ? (
        <Select
          value={typeof value === 'string' ? value : definition.default}
          disabled={disabled}
          onValueChange={(next) => session.setValue(definition.key, next)}
        >
          <SelectTrigger id={id} aria-label={definition.label} aria-describedby={description}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {definition.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : definition.kind === 'colour' ? (
        <div className="interface-theme-input-row">
          <input
            type="color"
            aria-label={`Choose ${definition.label.toLowerCase()}`}
            value={
              typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value) ? value : typeof inherited.accent === 'string' ? inherited.accent : '#000000'
            }
            disabled={disabled}
            onChange={(event) => session.setValue(definition.key, event.target.value)}
          />
          <input
            id={id}
            type="text"
            value={typeof value === 'string' ? value : ''}
            placeholder="Theme default"
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!valid || undefined}
            aria-describedby={description}
            disabled={disabled}
            onChange={(event) =>
              event.target.value === '' ? session.setValue(definition.key, null) : session.setColourText(definition.key, event.target.value)
            }
          />
          <Button type="button" variant="outline" disabled={disabled || value === null} onClick={() => session.setValue(definition.key, null)}>
            Use theme default
          </Button>
        </div>
      ) : (
        <div className="interface-theme-number">
          <input
            id={id}
            type="text"
            inputMode="numeric"
            value={value === null ? '' : String(value)}
            placeholder="Theme default"
            maxLength={12}
            aria-invalid={!valid || undefined}
            aria-describedby={`${id}-range${description ? ` ${description}` : ''}`}
            disabled={disabled}
            onChange={(event) => session.setNumberText(definition.key, event.target.value)}
          />
          <input
            type="range"
            aria-label={`Adjust ${definition.label.toLowerCase()}`}
            min={definition.min}
            max={definition.max}
            step={definition.step}
            value={
              typeof value === 'number' ? value : typeof inherited[definition.key] === 'number' ? Number(inherited[definition.key]) : definition.min
            }
            aria-valuetext={value === null ? 'Theme default; adjusting creates a custom value' : String(value)}
            disabled={disabled || (value !== null && typeof value !== 'number')}
            onChange={(event) => session.setValue(definition.key, Number(event.target.value))}
          />
          <span id={`${id}-range`}>
            {definition.min} to {definition.max}. Leave empty to use the theme default.
          </span>
          <Button type="button" variant="outline" disabled={disabled || value === null} onClick={() => session.setValue(definition.key, null)}>
            Use theme default
          </Button>
        </div>
      )}
      {definition.help || !valid ? (
        <p id={`${id}-help`} role={valid ? undefined : 'alert'}>
          {valid
            ? definition.help
            : definition.kind === 'colour'
              ? 'Use six hexadecimal digits, for example #4c74b8.'
              : 'Enter a whole number within the displayed range.'}
        </p>
      ) : null}
    </div>
  );
}

export function InterfaceThemeControls({ session, legacyControls }: { session: InterfaceThemeSession; legacyControls?: ReactNode }) {
  const [inherited, setInherited] = useState<Record<string, number | string>>({});
  useEffect(() => {
    if (session.preview) setInherited(readInheritedControls());
  }, [session.preview]);
  const descriptor = session.current ? registeredInterfaceTheme(session.current.identity) : null;
  const disabled = session.pending || session.status !== 'ready';
  const groups = descriptor ? [...new Set(descriptor.settings.map((setting) => setting.group))] : [];
  const labels: Record<string, string> = { colour: 'Colours', material: 'Surfaces', effects: 'Motion and energy' };
  const inactive = session.drafts.filter((draft) => draft.dirty && draft.descriptor.id !== descriptor?.id);
  return (
    <div className="interface-theme-controls">
      <InterfaceThemeSaveEntries session={session} />
      {session.status === 'loading' || session.pending ? (
        <output className="appearance-note" aria-live="polite">
          {session.pending && session.status === 'ready' ? 'Saving or refreshing theme settings…' : 'Loading theme settings…'}
        </output>
      ) : null}
      {session.error ? (
        <div role="alert" className="appearance-note">
          <p>{session.error.message}</p>
          <Button type="button" variant="outline" disabled={session.pending} onClick={() => void session.reload()}>
            Reload theme settings
          </Button>
        </div>
      ) : null}
      {session.status === 'migration' ? (
        <section className="appearance-section">
          <h2>Keep your current appearance</h2>
          <p>Your existing appearance stays in use until it is copied into theme settings.</p>
          <Button type="button" disabled={session.pending} onClick={() => void session.migrate()}>
            Keep appearance in this theme
          </Button>
        </section>
      ) : null}
      {session.status === 'legacy' ? (
        <>
          <p className="appearance-note">This server uses shared appearance settings. Changes here apply across themes.</p>
          {legacyControls}
        </>
      ) : null}
      {session.status !== 'legacy' && session.status !== 'migration' && descriptor
        ? groups.map((group) => (
            <section className="appearance-section" key={group}>
              <div>
                <h2>{labels[group] ?? group}</h2>
                <p>{descriptor.name} provides these controls. Save keeps changes for this theme.</p>
              </div>
              <div className="interface-theme-group">
                {descriptor.settings
                  .filter((setting) => setting.group === group)
                  .map((definition) => (
                    <ThemeControl
                      key={definition.key}
                      definition={definition}
                      value={session.current?.values.find((item) => item.key === definition.key)?.value ?? definition.default}
                      disabled={disabled}
                      session={session}
                      inherited={inherited}
                    />
                  ))}
              </div>
            </section>
          ))
        : null}
      {!descriptor && session.status === 'ready' ? (
        <output>This theme needs a compatible interface package before its controls can be shown.</output>
      ) : null}
      {descriptor && session.status === 'ready' ? (
        <div className="appearance-actions">
          <Button type="button" variant="outline" disabled={session.pending} onClick={session.reset}>
            Use theme defaults
          </Button>
          <Button type="button" variant="outline" disabled={session.pending || !session.current?.dirty} onClick={() => session.discard()}>
            Discard unsaved theme changes
          </Button>
        </div>
      ) : null}
      {inactive.length ? (
        <output>Unsaved changes are also kept for {inactive.map((draft) => draft.descriptor.name).join(', ')}. Save includes those themes.</output>
      ) : null}
      {(session.status === 'legacy' || session.status === 'error') && session.drafts.some((draft) => draft.dirty) ? (
        <Button
          type="button"
          variant="outline"
          disabled={session.pending}
          onClick={() => {
            for (const draft of session.drafts) session.discard(draft.identity);
          }}
        >
          Discard unsaved theme changes
        </Button>
      ) : null}
      {session.cacheAvailable ? null : <output>This browser cannot remember the theme appearance for the next startup.</output>}
    </div>
  );
}
