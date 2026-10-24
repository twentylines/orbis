import { acknowledgeWelcome } from '@/api-client';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AuthLayout } from '@/components/layouts/auth/layout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useAppContext } from '@/context/app-context';
import {
  automaticUpdateSettingsOptions,
  saveAutomaticUpdateSettings,
  saveAppUpdateSchedule,
  type AutomaticUpdateSettings,
} from '@/desktop/automatic-updates-api';
import { DesktopPreferencesPreview, useDesktopPreferences } from '@/desktop/preferences';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { themePresets, presetLabels, presetWallpaperSources } from '@/desktop/wallpaper-presets';
import { IconArrowLeft, IconArrowRight, IconCheck, IconDeviceDesktop, IconLeaf, IconMoon, IconSparkles, IconSun } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { saveSetupSteps, type SetupSaveStep } from './setup-save';
import './welcome.css';

const steps = ['Your server', 'Colour', 'Wallpaper', 'Performance', 'Updates', 'Ready'] as const;
const descriptions = [
  'Give this server a name. You can change every choice later in Settings.',
  'Choose a palette and display mode. Preview your workspace as you go.',
  'Each palette has its own landscape. Keep them linked, or choose a favourite.',
  'Choose the balance that suits your devices. Your apps keep all their features.',
  'Keep updates manual, or choose what Orbis may update automatically.',
  'Your workspace is ready. Review your choices and make it yours.',
];
const defaultAutomatic: AutomaticUpdateSettings = { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } };

export const Welcome = ({ allowErrorMonitoring }: { allowErrorMonitoring: boolean }) => {
  const { preferences, completeOnboarding, syncState } = useDesktopPreferences();
  const { user } = useAppContext();
  const [draft, setDraft] = useState(preferences);
  const [name, setName] = useState(preferences.serverName);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [errorMonitoring, setErrorMonitoring] = useState(allowErrorMonitoring);
  const [pairNext, setPairNext] = useState(false);
  const [automatic, setAutomatic] = useState(defaultAutomatic);
  const [automaticEdited, setAutomaticEdited] = useState(false);
  const [appChoices, setAppChoices] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savingStep, setSavingStep] = useState('');
  const [error, setError] = useState('');
  const savingLock = useRef(false);
  const receipts = useRef(new Map<string, string>());
  const acceptedApps = useRef(new Map<string, string>());
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const canManageUpdates = user.operator;
  const updateSettings = useQuery({ ...automaticUpdateSettingsOptions(), enabled: canManageUpdates && step >= 4 });
  const installed = useQuery({
    ...getInstalledAppsOptions(),
    enabled: canManageUpdates && step >= 4,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const eligibleApps = installed.data?.installed.filter(({ info }) => !info.urn.endsWith(':_user')) ?? [];
  const selectedApps = eligibleApps.filter(({ info }) => appChoices.includes(info.urn));
  const nameValid = name.trim().length > 0 && name.trim().length <= 40;
  const scheduleValid = (!automaticEdited && appChoices.length === 0) || /^([01]\d|2[0-3]):[0-5]\d$/.test(automatic.schedule.time);

  useEffect(() => {
    if (updateSettings.data && !automaticEdited) setAutomatic(updateSettings.data.settings);
  }, [updateSettings.data, automaticEdited]);
  useLayoutEffect(() => {
    if (firstStep.current && step === 0) {
      firstStep.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [step]);

  const go = (next: number) => {
    if (saving || next < 0 || next >= steps.length) return;
    setDirection(next > step ? 1 : -1);
    setError('');
    setStep(next);
  };
  const save = async () => {
    if (savingLock.current || !nameValid || !scheduleValid || syncState === 'loading') return;
    savingLock.current = true;
    setSaving(true);
    setError('');
    const completedDraft = { ...draft, serverName: name.trim() };
    const tasks: SetupSaveStep[] = [
      {
        id: 'Saving reporting preference',
        value: errorMonitoring,
        save: () => acknowledgeWelcome({ body: { allowErrorMonitoring: errorMonitoring }, signal: AbortSignal.timeout(20_000), throwOnError: true }),
      },
    ];
    if (canManageUpdates && automaticEdited)
      tasks.push({ id: 'Saving Orbis update schedule', value: automatic, save: () => saveAutomaticUpdateSettings(automatic) });
    const appUpdates = new Map(acceptedApps.current);
    for (const { info } of selectedApps) appUpdates.set(info.urn, info.name);
    for (const [urn, appName] of appUpdates) {
      const mode = appChoices.includes(urn) ? 'global' : 'disabled';
      tasks.push({
        id: `app:${urn}`,
        label: `Saving updates for ${appName}`,
        value: { urn, mode },
        save: async () => {
          await saveAppUpdateSchedule(urn, { mode });
          acceptedApps.current.set(urn, appName);
        },
      });
    }
    tasks.push({ id: 'Opening your workspace', value: completedDraft, save: () => completeOnboarding(name, completedDraft) });
    try {
      await saveSetupSteps(tasks, receipts.current, setSavingStep);
      if (pairNext) await navigate('/settings?tab=cluster');
    } catch (reason) {
      setError(
        `Setup is not complete. ${reason instanceof Error ? reason.message : 'Check the connection and try again.'} Saved choices are kept; retry continues with the remaining steps.`,
      );
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  };
  const setAutomaticDraft = (value: AutomaticUpdateSettings) => {
    setAutomaticEdited(true);
    setAutomatic(value);
  };

  return (
    <DesktopPreferencesPreview value={draft} onChange={setDraft}>
      <AuthLayout busy={saving} setup>
        <form
          className="orbis-setup"
          aria-labelledby="setup-heading"
          aria-busy={saving}
          data-reduced={reduceMotion || draft.appearance.motion === 'reduced' || draft.appearance.lowEffects}
          onSubmit={(event) => {
            event.preventDefault();
            if (step === steps.length - 1) void save();
            else if ((step !== 0 || nameValid) && (step !== 4 || scheduleValid)) go(step + 1);
          }}
        >
          <header className="orbis-setup-header">
            <span className="orbis-setup-eyebrow">Make yourself at home</span>
            <div className="orbis-setup-progress-label">
              <span>{steps[step]}</span>
              <span>
                {step + 1} / {steps.length}
              </span>
            </div>
            <div
              className="orbis-setup-progress"
              role="progressbar"
              aria-label="Setup progress"
              aria-valuemin={1}
              aria-valuemax={steps.length}
              aria-valuenow={step + 1}
              aria-valuetext={`Step ${step + 1} of ${steps.length}: ${steps[step]}`}
            >
              <span style={{ transform: `scaleX(${(step + 1) / steps.length})` }} />
            </div>
          </header>
          <div className="orbis-setup-stage" data-direction={direction}>
            <section key={step} className="orbis-setup-step" aria-labelledby="setup-heading">
              <div className="orbis-setup-intro">
                <h2 ref={heading} id="setup-heading" tabIndex={-1}>
                  {step === 0 ? 'Welcome to Orbis' : step === 5 ? 'Ready when you are' : steps[step]}
                </h2>
                <p>{descriptions[step]}</p>
              </div>
              <fieldset disabled={saving} className="orbis-setup-fields">
                {step === 0 ? (
                  <>
                    <div className="orbis-setup-name-mark" aria-hidden="true">
                      <IconDeviceDesktop size={42} />
                      <span>{name.trim() || 'Your server'}</span>
                    </div>
                    <Input
                      label="Server name"
                      name="setup-server-name"
                      value={name}
                      maxLength={40}
                      required
                      onChange={(event) => setName(event.target.value)}
                      aria-describedby="setup-name-help"
                    />
                    <p id="setup-name-help" className="orbis-setup-help">
                      A familiar name, such as Hades or Home server. Up to 40 characters.
                    </p>
                  </>
                ) : null}
                {step === 1 ? (
                  <>
                    <div className="orbis-setup-palettes">
                      {themePresets.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className="orbis-setup-palette"
                          data-palette={preset}
                          aria-pressed={draft.preset === preset}
                          onClick={() => setDraft({ ...draft, preset, appearance: { ...draft.appearance, accent: null } })}
                        >
                          <span aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                          <strong>{presetLabels[preset]}</strong>
                          {draft.preset === preset ? <IconCheck size={18} aria-hidden="true" /> : null}
                        </button>
                      ))}
                    </div>
                    <fieldset className="orbis-setup-choice-group">
                      <legend>Display mode</legend>
                      <div className="orbis-setup-mode">
                        {(
                          [
                            ['light', 'Light', IconSun],
                            ['dark', 'Dark', IconMoon],
                            ['system', 'System', IconDeviceDesktop],
                          ] as const
                        ).map(([mode, label, Icon]) => (
                          <button key={mode} type="button" aria-pressed={draft.mode === mode} onClick={() => setDraft({ ...draft, mode })}>
                            <Icon size={19} aria-hidden="true" />
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="orbis-setup-help">System follows this browser’s light or dark preference.</p>
                    </fieldset>
                  </>
                ) : null}
                {step === 2 ? (
                  <>
                    <Switch
                      label="Match wallpaper to colour preset"
                      checked={draft.wallpaperMode === 'theme'}
                      onCheckedChange={(checked) =>
                        setDraft({
                          ...draft,
                          wallpaperMode: checked ? 'theme' : 'custom',
                          wallpaperPreset: checked ? draft.wallpaperPreset : draft.preset,
                          appearance: { ...draft.appearance, wallpaperImage: null },
                        })
                      }
                    />
                    <div className="orbis-setup-wallpapers">
                      {themePresets.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          aria-pressed={
                            draft.wallpaperMode === 'theme'
                              ? draft.preset === preset
                              : draft.wallpaperPreset === preset && !draft.appearance.wallpaperImage
                          }
                          onClick={() =>
                            setDraft({
                              ...draft,
                              wallpaperMode: 'custom',
                              wallpaperPreset: preset,
                              appearance: { ...draft.appearance, wallpaperImage: null },
                            })
                          }
                        >
                          <img src={presetWallpaperSources[preset]} alt="" loading="lazy" decoding="async" />
                          <span>
                            {presetLabels[preset]}
                            {(draft.wallpaperMode === 'theme' ? draft.preset === preset : draft.wallpaperPreset === preset) ? (
                              <IconCheck size={18} aria-hidden="true" />
                            ) : null}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="orbis-setup-help">Choose an image to keep it when you change palette. Upload your own later in Settings.</p>
                  </>
                ) : null}
                {step === 3 ? (
                  <>
                    <div className="orbis-setup-performance">
                      {(
                        [
                          { low: false, title: 'Full experience', text: 'Glass, depth and fluid motion.', Icon: IconSparkles },
                          { low: true, title: 'Save resources', text: 'Solid surfaces and less movement for lighter browsing.', Icon: IconLeaf },
                        ] as const
                      ).map(({ low, title, text, Icon }) => (
                        <button
                          key={title}
                          type="button"
                          aria-pressed={draft.appearance.lowEffects === low}
                          onClick={() => setDraft({ ...draft, appearance: { ...draft.appearance, lowEffects: low } })}
                        >
                          <Icon size={28} aria-hidden="true" />
                          <strong>{title}</strong>
                          <span>{text}</span>
                          {draft.appearance.lowEffects === low ? <IconCheck size={18} aria-hidden="true" /> : null}
                        </button>
                      ))}
                    </div>
                    <Switch
                      label="Reduce movement"
                      checked={draft.appearance.motion === 'reduced'}
                      onCheckedChange={(reduced) =>
                        setDraft({ ...draft, appearance: { ...draft.appearance, motion: reduced ? 'reduced' : 'system' } })
                      }
                    />
                    <p className="orbis-setup-help">You can fine-tune blur, transparency and motion in Settings → Appearance → Performance.</p>
                    <div className="orbis-setup-schedule">
                      <label htmlFor="setup-app-opening">Open apps</label>
                      <select
                        id="setup-app-opening"
                        className="form-select"
                        value={draft.appLaunch.mode}
                        onChange={(event) => setDraft({ ...draft, appLaunch: { ...draft.appLaunch, mode: event.target.value as 'window' | 'tab' } })}
                      >
                        <option value="window">In Orbis</option>
                        <option value="tab">In a new tab</option>
                      </select>
                      <p className="orbis-setup-help">Account default. Smaller screens use tabs. Some apps require a tab for security or sign-in.</p>
                    </div>
                  </>
                ) : null}
                {step === 4 ? (
                  canManageUpdates ? (
                    <>
                      {updateSettings.isPending ? <output>Reading update preferences…</output> : null}
                      {updateSettings.isError ? (
                        <div className="orbis-setup-notice">
                          <p>Update preferences could not be read. They will stay as they are.</p>
                          <button type="button" onClick={() => void updateSettings.refetch()}>
                            Try again
                          </button>
                        </div>
                      ) : null}
                      {updateSettings.data ? (
                        <>
                          <Switch
                            label="Automatically update Orbis"
                            checked={automatic.orbis.enabled}
                            disabled={!updateSettings.data.available}
                            onCheckedChange={(enabled) => setAutomaticDraft({ ...automatic, orbis: { ...automatic.orbis, enabled } })}
                          />
                          <p className="orbis-setup-help">Off by default. Updates wait until everyone has left Orbis. Your apps keep running.</p>
                          {updateSettings.data.available ? null : (
                            <p className="orbis-setup-help">{updateSettings.data.reason || 'Automatic updates are unavailable on this host.'}</p>
                          )}
                          {automatic.orbis.enabled ? (
                            <div className="orbis-setup-schedule">
                              <label htmlFor="setup-update-mode">When to update</label>
                              <select
                                id="setup-update-mode"
                                className="form-select"
                                value={automatic.orbis.mode}
                                onChange={(event) =>
                                  setAutomaticDraft({
                                    ...automatic,
                                    orbis: { ...automatic.orbis, mode: event.target.value as 'idle' | 'scheduled' },
                                  })
                                }
                              >
                                <option value="idle">When Orbis is idle</option>
                                <option value="scheduled">At a scheduled time</option>
                              </select>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                      <details className="orbis-setup-app-updates">
                        <summary>
                          Choose apps for automatic updates <span>{appChoices.length} selected</span>
                        </summary>
                        <p>
                          Select apps to enable daily updates. Other apps keep their current settings; new apps stay manual. Selected apps may restart
                          during installation.
                        </p>
                        {installed.isPending ? <p>Reading installed apps…</p> : null}
                        {installed.isError ? (
                          <p>
                            Installed apps could not be read.{' '}
                            <button type="button" onClick={() => void installed.refetch()}>
                              Try again
                            </button>
                          </p>
                        ) : null}
                        {installed.data && eligibleApps.length === 0 ? (
                          <p>No eligible store apps installed yet. Choose automatic updates in each app’s settings after installing it.</p>
                        ) : null}
                        <div className="orbis-setup-app-list">
                          {eligibleApps.map(({ info }) => (
                            <label key={info.urn}>
                              <input
                                disabled={!updateSettings.data?.available}
                                type="checkbox"
                                checked={appChoices.includes(info.urn)}
                                onChange={(event) =>
                                  setAppChoices((current) =>
                                    event.target.checked ? [...current, info.urn] : current.filter((urn) => urn !== info.urn),
                                  )
                                }
                              />
                              <span>{info.name}</span>
                            </label>
                          ))}
                        </div>
                      </details>
                      {updateSettings.data ? (
                        <p className="orbis-setup-help">
                          Shared daily app time: {automatic.schedule.time} ({automatic.schedule.timezone}). Custom apps stay manual.
                        </p>
                      ) : null}
                      {(automatic.orbis.enabled && automatic.orbis.mode === 'scheduled') || appChoices.length > 0 ? (
                        <div className="orbis-setup-schedule">
                          <Input
                            label="Update time"
                            name="setup-update-time"
                            type="time"
                            required
                            value={automatic.schedule.time}
                            onChange={(event) => setAutomaticDraft({ ...automatic, schedule: { ...automatic.schedule, time: event.target.value } })}
                          />
                          <p className="orbis-setup-help">
                            Daily in {automatic.schedule.timezone}. Shared by selected apps and scheduled Orbis updates.
                          </p>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p>Automatic updates are managed by an operator. You can install available updates from the Updates page.</p>
                  )
                ) : null}
                {step === 5 ? (
                  <>
                    <dl className="orbis-setup-review">
                      <div>
                        <dt>Server</dt>
                        <dd>{name.trim()}</dd>
                      </div>
                      <div>
                        <dt>Appearance</dt>
                        <dd>
                          {presetLabels[draft.preset]} · {draft.mode === 'system' ? 'System' : draft.mode === 'dark' ? 'Dark' : 'Light'}
                        </dd>
                      </div>
                      <div>
                        <dt>Wallpaper</dt>
                        <dd>
                          {draft.wallpaperMode === 'theme'
                            ? 'Match palette'
                            : draft.appearance.wallpaperImage
                              ? 'Your image'
                              : draft.wallpaperPreset
                                ? presetLabels[draft.wallpaperPreset]
                                : draft.wallpaper}
                        </dd>
                      </div>
                      <div>
                        <dt>Performance</dt>
                        <dd>
                          {draft.appearance.lowEffects ? 'Save resources' : 'Full experience'}
                          {draft.appearance.motion === 'reduced' ? ' · Reduced movement' : ''}
                        </dd>
                      </div>
                      <div>
                        <dt>Open apps</dt>
                        <dd>{draft.appLaunch.mode === 'window' ? 'In Orbis' : 'In a new tab'}</dd>
                      </div>
                      <div>
                        <dt>Automatic updates</dt>
                        <dd>
                          {automaticEdited ? (automatic.orbis.enabled ? 'Orbis enabled' : 'Orbis manual') : 'Existing preferences kept'} ·{' '}
                          {appChoices.length ? `${appChoices.length} apps selected` : 'No app changes'}
                        </dd>
                      </div>
                    </dl>
                    <div className="orbis-setup-reporting">
                      <Switch checked={errorMonitoring} onCheckedChange={setErrorMonitoring} label="Send error reports" />
                      <p className="orbis-setup-help">Optional. Reports are sent to the upstream Sentry service.</p>
                    </div>
                    <Switch checked={pairNext} onCheckedChange={setPairNext} label="Pair another server after setup" />
                  </>
                ) : null}
              </fieldset>
            </section>
          </div>
          {error ? (
            <p className="orbis-setup-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="orbis-setup-footer">
            <Button type="button" variant="ghost" onClick={() => go(step - 1)} disabled={step === 0 || saving}>
              <IconArrowLeft size={18} aria-hidden="true" />
              Back
            </Button>
            <output aria-live="polite">{saving ? savingStep : 'Your choices are saved when you finish.'}</output>
            <Button
              type="submit"
              intent="primary"
              disabled={saving || syncState === 'loading' || (step === 0 && !nameValid) || (step >= 4 && !scheduleValid)}
            >
              {saving ? 'Saving…' : step === steps.length - 1 ? 'Open workspace' : 'Continue'}
              {saving ? null : step === steps.length - 1 ? (
                <IconCheck size={18} aria-hidden="true" />
              ) : (
                <IconArrowRight size={18} aria-hidden="true" />
              )}
            </Button>
          </footer>
        </form>
      </AuthLayout>
    </DesktopPreferencesPreview>
  );
};
