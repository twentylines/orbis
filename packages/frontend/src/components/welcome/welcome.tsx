import { acknowledgeWelcome } from '@/api-client';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AuthLayout } from '@/components/layouts/auth/layout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { TimeField, useTimeField } from '@/components/ui/TimeField/TimeField';
import { validTime } from '@/components/ui/TimeField/time-field';
import { automaticUpdateSettingsForSave } from '@/desktop/automatic-update-time';
import { useAppContext } from '@/context/app-context';
import {
  automaticUpdateSettingsOptions,
  readAppUpdateSchedule,
  saveAutomaticUpdateSettings,
  saveAppUpdateSchedule,
  type AutomaticUpdateSettings,
} from '@/desktop/automatic-updates-api';
import { DesktopPreferencesPreview, useDesktopPreferences } from '@/desktop/preferences';
import { AppLaunchModeChoice } from '@/desktop/app-launch-mode-choice';
import { useReducedMotion, useReducedTransparency } from '@/desktop/motion-preferences';
import { themePresets, presetLabels, presetWallpaperPreviews } from '@/desktop/wallpaper-presets';
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconChevronDown,
  IconDeviceDesktop,
  IconLeaf,
  IconMoon,
  IconSparkles,
  IconSun,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { saveSetupSteps, setupAppUpdateSteps, setupScheduleAllowsNext, type SetupAppChoices, type SetupSaveStep } from './setup-save';
import { SystemBackupsSettings } from '@/modules/system-backups/system-backups-settings';
import { HostTransferPanel } from '@/modules/host-transfer/host-transfer-panel';
import { nextSetupStep, previousSetupStep, setupCanFinish, setupPosition, setupStepCopy, type SetupEntry, type SetupStep } from './setup-navigation';
import './welcome.css';

const defaultAutomatic: AutomaticUpdateSettings = { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } };

export const Welcome = ({ allowErrorMonitoring }: { allowErrorMonitoring: boolean }) => {
  const { preferences, completeOnboarding, syncState } = useDesktopPreferences();
  const { user } = useAppContext();
  const [draft, setDraft] = useState(preferences);
  const [name, setName] = useState(preferences.serverName);
  const [step, setStep] = useState<SetupStep>('choose');
  const [entry, setEntry] = useState<SetupEntry>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
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
  const touchedApps = useRef<SetupAppChoices>(new Map());
  const heading = useRef<HTMLHeadingElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [stageScroll, setStageScroll] = useState({ overflow: false, below: false });
  const firstStep = useRef(true);
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const reduceTransparency = useReducedTransparency();
  const reduceSetupMotion = reduceMotion || draft.appearance.motion === 'reduced' || draft.appearance.lowEffects;
  const glassEnabled =
    !draft.appearance.lowEffects &&
    draft.appearance.glassBlur !== 0 &&
    (draft.appearance.transparency === 'glass' || (draft.appearance.transparency === 'system' && !reduceTransparency));
  const canManageUpdates = user.operator;
  const updateSettings = useQuery({ ...automaticUpdateSettingsOptions(), enabled: canManageUpdates && (step === 'updates' || step === 'ready') });
  const installed = useQuery({
    ...getInstalledAppsOptions(),
    enabled: canManageUpdates && (step === 'updates' || step === 'ready'),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const eligibleApps = installed.data?.installed.filter(({ info }) => !info.urn.endsWith(':_user')) ?? [];
  const selectedApps = eligibleApps.filter(({ info }) => appChoices.includes(info.urn));
  const nameValid = name.trim().length > 0 && name.trim().length <= 40;
  const sharedScheduleNeeded = (automatic.orbis.enabled && automatic.orbis.mode === 'scheduled') || appChoices.length > 0;
  const timeValid = validTime(automatic.schedule.time);
  const scheduleValid = setupScheduleAllowsNext(automatic.schedule.time, automaticEdited, sharedScheduleNeeded);
  const time = useTimeField({
    value: timeValid ? automatic.schedule.time : null,
    format: draft.appearance.timeFormat,
    onFormatChange: (timeFormat) => setDraft((current) => ({ ...current, appearance: { ...current.appearance, timeFormat } })),
    onChange: (next) => {
      setAutomaticEdited(true);
      setAutomatic((current) => ({ ...current, schedule: { ...current.schedule, time: next ?? '' } }));
    },
  });

  useEffect(() => {
    if (updateSettings.data && !automaticEdited) {
      setAutomatic(updateSettings.data.settings);
    }
  }, [updateSettings.data, automaticEdited]);
  useLayoutEffect(() => {
    if (firstStep.current && step === 'choose') {
      firstStep.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [step]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each step replaces the observed section.
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const overflow = element.scrollHeight > element.clientHeight + 2;
      const below = overflow && element.scrollTop + element.clientHeight < element.scrollHeight - 2;
      setStageScroll((current) => (current.overflow === overflow && current.below === below ? current : { overflow, below }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', measure);
    };
  }, [step]);

  const position = setupPosition(step);
  const recoveryStep = step === 'restore' || step === 'transfer';
  const SetupSurface = recoveryStep ? 'div' : 'form';
  const go = (next: SetupStep | null) => {
    if (saving || restoreBusy || next === null) return;
    setDirection(setupPosition(next).current > position.current ? 1 : -1);
    setError('');
    setStep(next);
  };
  const save = async () => {
    if (!setupCanFinish(step, entry) || restoreBusy || savingLock.current || !nameValid || !scheduleValid || syncState === 'loading') return;
    savingLock.current = true;
    setSaving(true);
    setError('');
    const completedDraft = { ...draft, serverName: name.trim() };
    const automaticToSave = automaticUpdateSettingsForSave(automatic);
    const tasks: SetupSaveStep[] = [
      {
        id: 'Saving reporting preference',
        value: errorMonitoring,
        save: () => acknowledgeWelcome({ body: { allowErrorMonitoring: errorMonitoring }, signal: AbortSignal.timeout(20_000), throwOnError: true }),
      },
    ];
    if (canManageUpdates && automaticEdited && automaticToSave)
      tasks.push({ id: 'Saving Orbis update schedule', value: automaticToSave, save: () => saveAutomaticUpdateSettings(automaticToSave) });
    tasks.push(
      ...setupAppUpdateSteps(
        selectedApps.map(({ info }) => ({ urn: info.urn, name: info.name })),
        touchedApps.current,
        { read: readAppUpdateSchedule, save: saveAppUpdateSchedule },
      ),
    );
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
        <SetupSurface
          className="orbis-setup"
          aria-labelledby="setup-heading"
          aria-busy={saving}
          data-reduced={reduceSetupMotion}
          onSubmit={(event: FormEvent<HTMLElement>) => {
            if (recoveryStep || event.target !== event.currentTarget) return;
            event.preventDefault();
            if (setupCanFinish(step, entry)) void save();
            else if ((step !== 'server' || nameValid) && (step !== 'updates' || scheduleValid)) go(nextSetupStep(step, entry));
          }}
        >
          <header className="orbis-setup-header">
            <div className="orbis-setup-progress-label">
              <span>{recoveryStep ? (step === 'transfer' ? 'Server transfer' : 'Backup recovery') : 'Setup'}</span>
              <span>{recoveryStep ? 'Review & restore' : `${position.current} / ${position.total}`}</span>
            </div>
            {recoveryStep ? null : (
              <div
                className="orbis-setup-progress"
                role="progressbar"
                aria-label="Setup progress"
                aria-valuemin={1}
                aria-valuemax={position.total}
                aria-valuenow={position.current}
                aria-valuetext={`Step ${position.current} of ${position.total}: ${setupStepCopy[step].title}`}
              >
                <span style={{ transform: `scaleX(${position.current / position.total})` }} />
              </div>
            )}
          </header>
          <div ref={stage} id="setup-choices" className="orbis-setup-stage" data-direction={direction}>
            <section key={step} className="orbis-setup-step" aria-labelledby="setup-heading">
              <div className="orbis-setup-intro">
                <h2 ref={heading} id="setup-heading" tabIndex={-1}>
                  {setupStepCopy[step].title}
                </h2>
                <p>{setupStepCopy[step].description}</p>
              </div>
              {step === 'restore' ? <SystemBackupsSettings restoreOnly embedded onActivityChange={setRestoreBusy} /> : null}
              {step === 'transfer' ? <HostTransferPanel mode="receive" embedded onActivityChange={setRestoreBusy} /> : null}
              {recoveryStep ? null : (
                <fieldset disabled={saving} className="orbis-setup-fields">
                  {step === 'choose' ? (
                    <div className="orbis-setup-entry-choices">
                      <button type="button" aria-pressed={entry === 'fresh'} onClick={() => setEntry('fresh')}>
                        <strong>Start fresh</strong>
                        <span>Choose your server name, appearance and update preferences.</span>
                      </button>
                      {user.operator ? (
                        <>
                          <button type="button" aria-pressed={entry === 'restore'} onClick={() => setEntry('restore')}>
                            <strong>Restore a backup</strong>
                            <span>Bring back saved Orbis configuration and managed app data.</span>
                          </button>
                          <button type="button" aria-pressed={entry === 'transfer'} onClick={() => setEntry('transfer')}>
                            <strong>Transfer a server</strong>
                            <span>Receive an encrypted backup over your private network.</span>
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {step === 'server' ? (
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
                        Up to 40 characters.
                      </p>
                    </>
                  ) : null}
                  {step === 'colour' ? (
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
                  {step === 'wallpaper' ? (
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
                            <img src={presetWallpaperPreviews[preset]} alt="" loading="lazy" decoding="async" />
                            <span>
                              {presetLabels[preset]}
                              {(draft.wallpaperMode === 'theme' ? draft.preset === preset : draft.wallpaperPreset === preset) ? (
                                <IconCheck size={18} aria-hidden="true" />
                              ) : null}
                            </span>
                          </button>
                        ))}
                      </div>
                      <p className="orbis-setup-help">Choose an image to keep it when you change palette.</p>
                    </>
                  ) : null}
                  {step === 'performance' ? (
                    <>
                      <div className="orbis-setup-performance">
                        {(
                          [
                            { low: false, title: 'Full experience', text: 'Backdrop blur, depth and fluid motion.', Icon: IconSparkles },
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
                      <div className="orbis-setup-choice-group">
                        <Switch
                          label="Background blur"
                          checked={glassEnabled}
                          disabled={draft.appearance.lowEffects}
                          aria-describedby="setup-glass-help"
                          onCheckedChange={(enabled) =>
                            setDraft({
                              ...draft,
                              appearance: {
                                ...draft.appearance,
                                transparency: enabled ? 'glass' : 'solid',
                                glassBlur: enabled && draft.appearance.glassBlur === 0 ? null : draft.appearance.glassBlur,
                                chromeBlur: enabled && draft.appearance.chromeBlur === 0 ? null : draft.appearance.chromeBlur,
                              },
                            })
                          }
                        />
                        <p id="setup-glass-help" className="orbis-setup-help">
                          {draft.appearance.lowEffects
                            ? 'Save resources uses solid panels with no blur.'
                            : 'Softens the wallpaper behind panels during setup, sign-in and in your workspace. Turn off for solid panels.'}
                        </p>
                      </div>
                      <Switch
                        label="Reduce movement"
                        checked={draft.appearance.motion === 'reduced'}
                        onCheckedChange={(reduced) =>
                          setDraft({ ...draft, appearance: { ...draft.appearance, motion: reduced ? 'reduced' : 'system' } })
                        }
                      />
                      <AppLaunchModeChoice
                        value={draft.appLaunch.mode}
                        onChange={(mode) => setDraft({ ...draft, appLaunch: { ...draft.appLaunch, mode } })}
                      />
                    </>
                  ) : null}
                  {step === 'updates' ? (
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
                                <Select
                                  value={automatic.orbis.mode}
                                  onValueChange={(mode) => {
                                    if (mode === 'idle' || mode === 'scheduled')
                                      setAutomaticDraft({ ...automatic, orbis: { ...automatic.orbis, mode } });
                                  }}
                                >
                                  <SelectTrigger id="setup-update-mode" label="When to update" value={automatic.orbis.mode}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="idle">When Orbis is idle</SelectItem>
                                    <SelectItem value="scheduled">At a scheduled time</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            ) : null}
                          </>
                        ) : null}
                        <details className="orbis-setup-app-updates">
                          <summary>
                            Choose apps for automatic updates <span>{appChoices.length} selected</span>
                          </summary>
                          <p>
                            Select apps to enable daily updates. Other apps keep their current settings; new apps stay manual. Selected apps may
                            restart during installation.
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
                            {timeValid
                              ? `Shared daily app time: ${automatic.schedule.time} (${automatic.schedule.timezone}). Custom apps stay manual.`
                              : 'Choose a daily update time below. Custom apps stay manual.'}
                          </p>
                        ) : null}
                        {sharedScheduleNeeded || !timeValid ? (
                          <div className="orbis-setup-schedule">
                            <TimeField control={time} label="Update time" id="setup-update-time" name="setup-update-time" disabled={saving} />
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
                  {step === 'ready' ? (
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
                            {!draft.appearance.lowEffects && !glassEnabled ? ' · Solid panels' : ''}
                            {draft.appearance.motion === 'reduced' ? ' · Reduced movement' : ''}
                          </dd>
                        </div>
                        <div>
                          <dt>Open apps</dt>
                          <dd>{draft.appLaunch.mode === 'window' ? 'Window layout' : 'Open apps in new tabs'}</dd>
                        </div>
                        <div>
                          <dt>Automatic updates</dt>
                          <dd>
                            {automaticEdited ? (automatic.orbis.enabled ? 'Orbis enabled' : 'Orbis manual') : 'Existing preferences kept'} ·{' '}
                            {appChoices.length ? `${appChoices.length} ${appChoices.length === 1 ? 'app' : 'apps'} selected` : 'No apps selected'}
                          </dd>
                        </div>
                        {sharedScheduleNeeded ? (
                          <div>
                            <dt>Daily schedule</dt>
                            <dd>
                              {automatic.schedule.time} · {automatic.schedule.timezone}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                      <div className="orbis-setup-reporting">
                        <Switch checked={errorMonitoring} onCheckedChange={setErrorMonitoring} label="Send error reports" />
                        <p className="orbis-setup-help">Optional. Reports are sent to the upstream Sentry service.</p>
                      </div>
                      <Switch checked={pairNext} onCheckedChange={setPairNext} label="Pair another server after setup" />
                    </>
                  ) : null}
                </fieldset>
              )}
            </section>
          </div>
          {error ? (
            <p className="orbis-setup-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="orbis-setup-footer">
            <Button type="button" variant="ghost" onClick={() => go(previousSetupStep(step))} disabled={step === 'choose' || saving || restoreBusy}>
              <IconArrowLeft size={18} aria-hidden="true" />
              Back
            </Button>
            <div className="orbis-setup-footer-status">
              {!saving && stageScroll.overflow ? (
                <button
                  type="button"
                  className="orbis-setup-scroll-hint"
                  aria-controls="setup-choices"
                  data-below={stageScroll.below}
                  onClick={() => {
                    const element = stage.current;
                    if (!element) return;
                    const behavior = reduceSetupMotion ? 'instant' : 'smooth';
                    if (stageScroll.below) element.scrollBy({ top: Math.max(120, element.clientHeight * 0.75), behavior });
                    else element.scrollTo({ top: 0, behavior });
                  }}
                >
                  {stageScroll.below ? 'More below' : 'Back to top'}
                  <IconChevronDown size={18} aria-hidden="true" />
                </button>
              ) : (
                <output aria-live="polite">
                  {saving
                    ? savingStep
                    : recoveryStep
                      ? restoreBusy
                        ? step === 'transfer'
                          ? 'Follow transfer or restore progress above.'
                          : 'Follow the backup progress above.'
                        : step === 'transfer'
                          ? 'Approve the transfer, then review the received backup.'
                          : 'Verify the backup before confirming replacement.'
                      : 'Your choices are saved when you finish.'}
                </output>
              )}
            </div>
            {recoveryStep ? null : (
              <Button
                type="submit"
                intent="primary"
                disabled={
                  saving ||
                  syncState === 'loading' ||
                  (step === 'choose' && entry === null) ||
                  (step === 'server' && !nameValid) ||
                  ((step === 'updates' || step === 'ready') && !scheduleValid)
                }
              >
                {saving ? 'Saving…' : step === 'ready' ? 'Open workspace' : 'Continue'}
                {saving ? null : step === 'ready' ? <IconCheck size={18} aria-hidden="true" /> : <IconArrowRight size={18} aria-hidden="true" />}
              </Button>
            )}
          </footer>
        </SetupSurface>
      </AuthLayout>
    </DesktopPreferencesPreview>
  );
};
