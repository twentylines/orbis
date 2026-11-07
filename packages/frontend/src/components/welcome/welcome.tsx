import { DepthTravel } from '@/components/recovery-progress/depth-travel';
import { useStartupSession } from '@/components/startup/startup-boundary';
import { acknowledgeWelcome } from '@/api-client';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AuthLayout } from '@/components/layouts/auth/layout';
import { Button } from '@/components/ui/Button';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { TimeField, useTimeField } from '@/components/ui/TimeField/TimeField';
import { validTime } from '@/components/ui/TimeField/time-field';
import { automaticUpdateSettingsForSave } from '@/desktop/automatic-update-time';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import {
  automaticUpdateSettingsOptions,
  readAppUpdateSchedule,
  saveAutomaticUpdateSettings,
  saveAppUpdateSchedule,
  type AutomaticUpdateSettings,
} from '@/desktop/automatic-updates-api';
import { DesktopPreferencesPreview, useDesktopPreferences, type DesktopPreferences } from '@/desktop/preferences';
import { ColourModeChoice } from '@/desktop/colour-mode-choice';
import { useResolvedColourMode } from '@/desktop/colour-mode';
import { AppLaunchModeChoice } from '@/desktop/app-launch-mode-choice';
import { useReducedMotion, useReducedTransparency } from '@/desktop/motion-preferences';
import { themePresets, presetLabels } from '@/desktop/wallpaper-presets';
import { IconArrowLeft, IconArrowRight, IconCheck, IconDeviceDesktop, IconHistory, IconLeaf, IconSparkles } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { useNavigate } from 'react-router';
import { finishSetup, prepareSetupHome, setupAppUpdateSteps, setupScheduleAllowsNext, type SetupAppChoices, type SetupSaveStep } from './setup-save';
import { readManualProtection, saveManualProtection } from '@/modules/time-machine-capsules/protection-choice';
import { timeMachinePreferencesQueryKey } from '@/modules/time-machine/time-machine-preferences-query';
import { TimeMachineApiError } from '@/modules/time-machine/time-machine-api';
import { nextSetupStep, previousSetupStep, setupCanFinish, setupPosition, setupStepCopy, type SetupEntry, type SetupStep } from './setup-navigation';
import {
  acknowledgeSetupCapture,
  readSetupCapture,
  reconcileSetupCapture,
  reserveSetupCapture,
  setupCaptureStorage,
  priorUnconfirmedSetupCapture,
  setupCaptureCanContinue,
  setupCaptureRequested,
  SetupCaptureNotStartedError,
  SetupCaptureTerminalError,
} from './setup-capture';
import { recordSetupFailureTask } from './setup-capture-task';
import { SetupStage } from './setup-stage';
import './welcome.css';

const defaultAutomatic: AutomaticUpdateSettings = { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } };
const setupEase = [0.22, 1, 0.36, 1] as const;
const SetupSpace = memo(DepthTravel);
const loadSetupBackups = () => import('@/modules/system-backups/system-backups-settings');
const loadSetupTransfer = () => import('@/modules/host-transfer/host-transfer-panel');
const SetupBackups = lazy(() => loadSetupBackups().then(({ SystemBackupsSettings }) => ({ default: SystemBackupsSettings })));
const SetupTransfer = lazy(() => loadSetupTransfer().then(({ HostTransferPanel }) => ({ default: HostTransferPanel })));

export function SetupCustomisation({ draft, onChange }: { draft: DesktopPreferences; onChange: (next: DesktopPreferences) => void }) {
  return (
    <>
      <fieldset className="orbis-setup-choice-group">
        <legend>Colour</legend>
        <div className="orbis-setup-palettes">
          {themePresets.map((preset) => (
            <button
              key={preset}
              type="button"
              className="orbis-setup-palette"
              data-palette={preset}
              aria-pressed={draft.preset === preset}
              onClick={() => onChange({ ...draft, preset, appearance: { ...draft.appearance, accent: null } })}
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
      </fieldset>
      <fieldset className="orbis-setup-choice-group">
        <legend>Display mode</legend>
        {draft.mode === 'system' ? (
          <p className="orbis-setup-help orbis-setup-choice-note">System follows this browser’s light or dark preference.</p>
        ) : null}
        <ColourModeChoice
          compact
          mode={draft.mode}
          oledDark={draft.appearance.oledDark}
          onChange={({ mode, oledDark }) => onChange({ ...draft, mode, appearance: { ...draft.appearance, oledDark } })}
        />
      </fieldset>
    </>
  );
}

export function SetupTimeMachineStep({
  enabled,
  canManage,
  disabled,
  unavailable,
  onChange,
  onRetry,
}: {
  enabled: boolean;
  canManage: boolean;
  disabled: boolean;
  unavailable: boolean;
  onChange: (enabled: boolean) => void;
  onRetry: () => void;
}) {
  return (
    <>
      <div className="orbis-setup-time-machine-illustration" aria-hidden="true">
        <span />
        <span />
        <div>
          <IconDeviceDesktop size={36} stroke={1.5} />
          <i />
          <i />
          <i />
        </div>
      </div>
      {canManage ? (
        <Switch label="Enable Time Machine" checked={enabled} onCheckedChange={onChange} disabled={disabled} />
      ) : (
        <p className="orbis-setup-help">Time Machine is managed by an operator.</p>
      )}
      <p className="orbis-setup-help">Experimental. Starts a capture after setup on supported hosts.</p>
      {unavailable ? (
        <InlineFeedback>
          <p>Time Machine is unavailable. You can continue setup and try again in Settings.</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </InlineFeedback>
      ) : null}
    </>
  );
}

function SetupStepPanel({
  children,
  direction,
  reduced,
  onReady,
  onSettled,
  headingId,
}: {
  children: ReactNode;
  direction: number;
  reduced: boolean;
  onReady: (element: HTMLElement) => void;
  onSettled: () => void;
  headingId: string;
}) {
  const element = useRef<HTMLElement>(null);
  const present = useIsPresent();
  const reported = useRef(false);
  useLayoutEffect(() => {
    if (!reported.current && element.current) {
      reported.current = true;
      onReady(element.current);
    }
    if (reduced && present) onSettled();
  }, [onReady, onSettled, reduced, present]);
  return (
    <motion.section
      ref={element}
      className="orbis-setup-step"
      aria-labelledby={headingId}
      onAnimationComplete={() => {
        if (present) onSettled();
      }}
      aria-hidden={!present || undefined}
      data-present={present}
      inert={!present}
      custom={direction}
      variants={{
        enter: (next: number) => ({ opacity: 0, z: next * 80 }),
        active: { opacity: 1, z: 0 },
        exit: (next: number) => ({ opacity: 0, z: -next * 80, transition: { duration: 0.3, ease: setupEase } }),
      }}
      initial={reduced ? false : 'enter'}
      animate="active"
      exit={reduced ? { opacity: 0, z: 0, transition: { duration: 0 } } : 'exit'}
      transition={{ duration: reduced ? 0 : 0.38, ease: setupEase }}
    >
      {children}
    </motion.section>
  );
}

export const Welcome = ({ allowErrorMonitoring }: { allowErrorMonitoring: boolean }) => {
  const { preferences, completeOnboarding, syncState, onboardingOrigin, onboardingGeneration } = useDesktopPreferences();
  const { user } = useAppContext();
  const { sessionAbortSignal } = useUserContext();
  const queryClient = useQueryClient();
  const [captureState, setCaptureState] = useState(() => {
    try {
      return { receipt: readSetupCapture(user.id, setupCaptureStorage(onboardingGeneration)), error: '' };
    } catch (reason) {
      return { receipt: null, error: reason instanceof Error ? reason.message : 'The setup capture receipt needs recovery.' };
    }
  });
  const resumingCapture = ['pending', 'submitted', 'accepted'].includes(captureState.receipt?.phase ?? '') || Boolean(captureState.error);
  const [draft, setDraft] = useState(preferences);
  const resolvedSetupMode = useResolvedColourMode(draft.mode);
  const [name, setName] = useState(preferences.serverName);
  const [step, setStep] = useState<SetupStep>(resumingCapture ? 'ready' : onboardingOrigin === 'runtipi' ? 'customisation' : 'choose');
  const [entry, setEntry] = useState<SetupEntry>(resumingCapture ? 'fresh' : onboardingOrigin === 'runtipi' ? 'migration' : null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [direction, setDirection] = useState(1);
  const [errorMonitoring, setErrorMonitoring] = useState(allowErrorMonitoring);
  const [automatic, setAutomatic] = useState(defaultAutomatic);
  const [automaticEdited, setAutomaticEdited] = useState(false);
  const [protectionDraft, setProtectionDraft] = useState<boolean | null>(null);
  const [appChoicesDraft, setAppChoices] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingStep, setSavingStep] = useState('');
  const [error, setError] = useState(captureState.error);
  const resumedCapture = useRef(false);
  const savingLock = useRef(false);
  const receipts = useRef(new Map<string, string>());
  const touchedApps = useRef<SetupAppChoices>(new Map());
  const heading = useRef<HTMLHeadingElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [stepElement, setStepElement] = useState<HTMLElement | null>(null);
  const transitionLock = useRef(false);
  const [transitioning, setTransitioning] = useState(false);
  const firstStep = useRef(true);
  const navigate = useNavigate();
  const startupSession = useStartupSession();
  const reduceMotion = useReducedMotion();
  const reduceTransparency = useReducedTransparency();
  const reduceSetupMotion = reduceMotion || draft.appearance.motion === 'reduced' || draft.appearance.lowEffects;
  const glassEnabled =
    !draft.appearance.lowEffects &&
    !(resolvedSetupMode === 'dark' && draft.appearance.oledDark) &&
    draft.appearance.glassBlur !== 0 &&
    (draft.appearance.transparency === 'glass' || (draft.appearance.transparency === 'system' && !reduceTransparency));
  const canManageUpdates = user.operator;
  const protection = useQuery({
    queryKey: ['setup-time-machine-preferences', user.id],
    queryFn: ({ signal }) => readManualProtection(signal),
    enabled: canManageUpdates && (step === 'time-machine' || step === 'ready'),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const captureRequested = setupCaptureRequested(canManageUpdates, protectionDraft, protection.data?.enabled);
  const updateSettings = useQuery({
    ...automaticUpdateSettingsOptions(),
    enabled: canManageUpdates && (step === 'performance' || step === 'updates' || step === 'ready'),
  });
  const installed = useQuery({
    ...getInstalledAppsOptions(),
    enabled: canManageUpdates && (step === 'performance' || step === 'updates' || step === 'ready'),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const eligibleApps = installed.data?.installed.filter(({ info }) => !info.urn.endsWith(':_user')) ?? [];
  const appChoices =
    appChoicesDraft ??
    eligibleApps
      .filter(({ info }) => (updateSettings.data?.appRules?.[info.urn]?.mode ?? (automatic.apps?.enabled ? 'global' : 'disabled')) !== 'disabled')
      .map(({ info }) => info.urn);
  const selectedApps = eligibleApps.filter(({ info }) => appChoices.includes(info.urn));
  const nameValid = name.trim().length > 0 && name.trim().length <= 40;
  const sharedScheduleNeeded =
    (automatic.orbis.enabled && automatic.orbis.mode === 'scheduled') || Boolean(automatic.apps?.enabled) || appChoices.length > 0;
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
  const onStepSettled = useCallback(() => {
    transitionLock.current = false;
    setTransitioning(false);
  }, []);
  const onStepReady = useCallback((element: HTMLElement) => {
    setStepElement(element);
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    if (stage.current) stage.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, []);

  const position = setupPosition(step, entry);
  const stepLayoutPending =
    step === 'updates' &&
    canManageUpdates &&
    (updateSettings.isPending ||
      installed.isPending ||
      (!automaticEdited && Boolean(updateSettings.data) && automatic !== updateSettings.data?.settings));
  const headingId = `setup-heading-${step}`;
  const recoveryStep = step === 'restore' || step === 'transfer';
  const go = (next: SetupStep | null, dismissedRecovery = false) => {
    if (saving || (restoreBusy && !dismissedRecovery) || transitionLock.current || next === null || next === step) return;
    transitionLock.current = true;
    setTransitioning(true);
    setDirection(setupPosition(next, entry).current > position.current ? 1 : -1);
    setError('');
    setStep(next);
  };
  const save = async () => {
    if (
      !setupCanFinish(step, entry) ||
      restoreBusy ||
      transitionLock.current ||
      savingLock.current ||
      !nameValid ||
      !scheduleValid ||
      syncState === 'loading' ||
      (canManageUpdates && (protection.isPending || protection.isError))
    )
      return;
    savingLock.current = true;
    setSaving(true);
    setSavingStep('Saving preferences');
    startupSession.begin('preparing-orbis', true, 'Saving preferences');
    setError('');
    const completedDraft = { ...draft, serverName: name.trim() };
    const automaticToSave = automaticUpdateSettingsForSave(automatic);
    const tasks: SetupSaveStep[] = [
      {
        id: 'Saving preferences',
        value: errorMonitoring,
        save: () => acknowledgeWelcome({ body: { allowErrorMonitoring: errorMonitoring }, signal: AbortSignal.timeout(20_000), throwOnError: true }),
      },
    ];
    if (canManageUpdates && automaticEdited && automaticToSave)
      tasks.push({ id: 'Saving Orbis update schedule', value: automaticToSave, save: () => saveAutomaticUpdateSettings(automaticToSave) });
    if (canManageUpdates && protectionDraft !== null)
      tasks.push({
        id: 'Saving Time Machine preferences',
        value: protectionDraft,
        save: async () => {
          try {
            const saved = await saveManualProtection(protectionDraft, AbortSignal.any([sessionAbortSignal, AbortSignal.timeout(20_000)]));
            queryClient.setQueryData(timeMachinePreferencesQueryKey(user.id), saved);
          } catch (reason) {
            sessionAbortSignal.throwIfAborted();
            const safeReason =
              reason instanceof TimeMachineApiError
                ? reason.message
                : 'The preference could not be saved. Review Time Machine settings and try again.';
            if (onboardingGeneration)
              recordSetupFailureTask(user.id, onboardingGeneration, 'preferences-save-failed', new Date().toISOString(), undefined, safeReason);
          }
        },
      });
    tasks.push(
      ...setupAppUpdateSteps(
        appChoicesDraft === null ? [] : selectedApps.map(({ info }) => ({ urn: info.urn, name: info.name })),
        touchedApps.current,
        { read: readAppUpdateSchedule, save: saveAppUpdateSchedule },
        appChoicesDraft === null
          ? undefined
          : {
              manualApps: eligibleApps.filter(({ info }) => !appChoices.includes(info.urn)).map(({ info }) => ({ urn: info.urn, name: info.name })),
              originalRules: updateSettings.data?.appRules ?? {},
            },
      ),
    );
    tasks.push({
      id: 'Saving workspace preferences',
      value: { preferences: completedDraft, capture: captureRequested },
      save: async () => {
        await completeOnboarding(name, completedDraft, async () => {
          let captured = false;
          if (captureRequested) {
            setSavingStep('Starting Time Machine capture');
            let receipt = captureState.receipt;
            const storage = setupCaptureStorage(onboardingGeneration);
            try {
              if (priorUnconfirmedSetupCapture(user.id, onboardingGeneration))
                throw new Error('A previous setup capture needs review in Time Machine before starting another.');
              receipt ??= reserveSetupCapture(user.id, storage);
              setCaptureState({ receipt, error: '' });
              const signal = AbortSignal.any([sessionAbortSignal, AbortSignal.timeout(30_000)]);
              await reconcileSetupCapture(user.id, receipt, true, signal, storage);
              setCaptureState({ receipt: { ...receipt, phase: 'accepted' }, error: '' });
              captured = true;
            } catch (reason) {
              sessionAbortSignal.throwIfAborted();
              if (!setupCaptureCanContinue(reason)) throw reason;
              if (receipt && reason instanceof SetupCaptureTerminalError) {
                recordSetupFailureTask(user.id, receipt.attemptId, 'capture-failed');
                try {
                  acknowledgeSetupCapture(user.id, receipt, 'failed', storage);
                } catch {
                  // The existing receipt remains available for a later status check.
                }
              } else if (receipt && reason instanceof SetupCaptureNotStartedError) {
                recordSetupFailureTask(user.id, receipt.attemptId, 'capture-not-started');
              }
            }
          }
          setSavingStep('Preparing Orbis');
          startupSession.setSetupStage('Preparing Orbis');
          await prepareSetupHome(
            () => import('@/modules/dashboard/pages/dashboard'),
            () => queryClient.fetchQuery({ ...getInstalledAppsOptions(), staleTime: 10_000, retry: false }),
            document.fonts.ready,
            new Promise<void>((resolve) => window.setTimeout(resolve, 300)),
          );
          return captured;
        });
      },
    });
    try {
      await finishSetup(
        tasks,
        receipts.current,
        (stage) => {
          const label = stage === 'Preparing Orbis' ? stage : 'Saving preferences';
          setSavingStep(label);
          startupSession.setSetupStage(label);
        },
        async (destination, options) => {
          await navigate(destination, options);
          await startupSession.finish();
        },
      );
    } catch (reason) {
      void startupSession.finish();
      setError(
        `Setup is not complete. ${reason instanceof Error ? reason.message : 'Check the connection and try again.'} Saved choices are kept; retry continues with the remaining steps.`,
      );
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  };
  useEffect(() => {
    if (
      resumedCapture.current ||
      !resumingCapture ||
      captureState.error ||
      syncState === 'loading' ||
      (canManageUpdates && (protection.isPending || protection.isError))
    )
      return;
    resumedCapture.current = true;
    void save();
  });
  const setAutomaticDraft = (value: AutomaticUpdateSettings) => {
    setAutomaticEdited(true);
    setAutomatic(value);
  };

  return (
    <DesktopPreferencesPreview value={draft} onChange={setDraft}>
      <AuthLayout
        busy={saving}
        setup
        scene={
          <SetupSpace
            mode={saving ? 'travel' : 'ambient'}
            variant="onboarding"
            distance={position.current + (saving ? 1 : 0)}
            className="orbis-setup-space"
          />
        }
        progress={
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
        }
      >
        <section className="orbis-setup" aria-labelledby={headingId} aria-busy={saving || transitioning} data-reduced={reduceSetupMotion}>
          <SetupStage stageRef={stage} stepElement={stepElement} reduced={reduceSetupMotion} pending={stepLayoutPending}>
            <AnimatePresence initial={false} mode="sync" custom={direction}>
              <SetupStepPanel
                key={step}
                direction={direction}
                reduced={reduceSetupMotion}
                onReady={onStepReady}
                onSettled={onStepSettled}
                headingId={headingId}
              >
                <div className="orbis-setup-intro">
                  <h2 ref={heading} id={headingId} tabIndex={-1}>
                    {step === 'time-machine' ? <IconHistory size="1em" aria-hidden="true" /> : null}
                    {setupStepCopy[step].title}
                  </h2>
                  {setupStepCopy[step].description ? <p>{setupStepCopy[step].description}</p> : null}
                </div>
                {step === 'restore' ? (
                  <Suspense fallback={<output>Loading backup options…</output>}>
                    <SetupBackups restoreOnly embedded recoveryScene onActivityChange={setRestoreBusy} onDismiss={() => go('choose', true)} />
                  </Suspense>
                ) : null}
                {step === 'transfer' ? (
                  <Suspense fallback={<output>Loading transfer options…</output>}>
                    <SetupTransfer mode="receive" embedded recoveryScene onActivityChange={setRestoreBusy} onDismiss={() => go('choose', true)} />
                  </Suspense>
                ) : null}
                {recoveryStep ? null : (
                  <form
                    id="setup-form"
                    className="orbis-setup-form"
                    onSubmit={(event: FormEvent<HTMLFormElement>) => {
                      if (event.target !== event.currentTarget) return;
                      event.preventDefault();
                      if (setupCanFinish(step, entry)) void save();
                      else if ((step !== 'server' || nameValid) && (step !== 'updates' || scheduleValid)) go(nextSetupStep(step, entry));
                    }}
                  >
                    <fieldset disabled={saving} className="orbis-setup-fields">
                      {step === 'choose' ? (
                        <div className="orbis-setup-entry-choices">
                          <button type="button" aria-pressed={entry === 'fresh'} onClick={() => setEntry('fresh')}>
                            <strong>Start fresh</strong>
                            <span>Choose your server name, appearance and update preferences.</span>
                          </button>
                          {user.operator ? (
                            <>
                              <button
                                type="button"
                                aria-pressed={entry === 'restore'}
                                onClick={() => {
                                  setEntry('restore');
                                  void loadSetupBackups().catch(() => undefined);
                                }}
                              >
                                <strong>Restore a backup</strong>
                                <span>Bring back your saved Orbis settings.</span>
                              </button>
                              <button
                                type="button"
                                aria-pressed={entry === 'transfer'}
                                onClick={() => {
                                  setEntry('transfer');
                                  void loadSetupTransfer().catch(() => undefined);
                                }}
                              >
                                <strong>Transfer a server</strong>
                                <span>Transfer from Orbis to Orbis over your private network.</span>
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
                      {step === 'customisation' ? <SetupCustomisation draft={draft} onChange={setDraft} /> : null}
                      {step === 'performance' ? (
                        <>
                          <div className="orbis-setup-performance">
                            {(
                              [
                                { low: false, title: 'Full experience', text: 'Backdrop blur, depth and fluid motion.', Icon: IconSparkles },
                                {
                                  low: true,
                                  title: 'Save resources',
                                  text: 'Solid surfaces and less movement for lighter browsing.',
                                  Icon: IconLeaf,
                                },
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
                              disabled={draft.appearance.lowEffects || (resolvedSetupMode === 'dark' && draft.appearance.oledDark)}
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
                              {resolvedSetupMode === 'dark' && draft.appearance.oledDark
                                ? 'OLED uses black panels.'
                                : draft.appearance.lowEffects
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
                                <Button type="button" variant="outline" onClick={() => void updateSettings.refetch()}>
                                  Try again
                                </Button>
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
                                <p className="orbis-setup-help">
                                  Off by default. Updates wait until everyone has left Orbis. Your apps keep running.
                                </p>
                                {updateSettings.data.available ? null : (
                                  <p className="orbis-setup-help">
                                    {updateSettings.data.reason || 'Automatic updates are unavailable on this host.'}
                                  </p>
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
                            {updateSettings.data ? (
                              <>
                                <Switch
                                  label="Automatically update apps"
                                  checked={automatic.apps?.enabled ?? false}
                                  disabled={!updateSettings.data.available}
                                  onCheckedChange={(enabled) => setAutomaticDraft({ ...automatic, apps: { enabled } })}
                                />
                                <p className="orbis-setup-help">
                                  Off by default. Store apps, including future installs, use the daily schedule. Each app can stay manual. Custom apps
                                  stay manual.
                                </p>
                              </>
                            ) : null}
                            {eligibleApps.length > 0 ? (
                              <details className="orbis-setup-app-updates">
                                <summary>
                                  Choose apps for automatic updates <span>{appChoices.length} selected</span>
                                </summary>
                                <p>
                                  Choose which installed apps may update. Unselected apps stay manual; existing custom schedules are kept. Updates may
                                  restart an app.
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
                                <div className="orbis-setup-app-list">
                                  {eligibleApps.map(({ info }) => (
                                    <label key={info.urn}>
                                      <input
                                        disabled={!updateSettings.data?.available}
                                        type="checkbox"
                                        checked={appChoices.includes(info.urn)}
                                        onChange={(event) =>
                                          setAppChoices((current) =>
                                            event.target.checked
                                              ? [...(current ?? appChoices), info.urn]
                                              : (current ?? appChoices).filter((urn) => urn !== info.urn),
                                          )
                                        }
                                      />
                                      <span>{info.name}</span>
                                    </label>
                                  ))}
                                </div>
                              </details>
                            ) : null}
                            {updateSettings.data && sharedScheduleNeeded ? (
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
                      {step === 'time-machine' ? (
                        <SetupTimeMachineStep
                          enabled={protectionDraft ?? protection.data?.enabled ?? false}
                          canManage={canManageUpdates}
                          disabled={saving || protection.isPending || protection.isError}
                          unavailable={protection.isError}
                          onChange={setProtectionDraft}
                          onRetry={() => void protection.refetch()}
                        />
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
                                {presetLabels[draft.preset]} ·{' '}
                                {draft.mode === 'system' ? 'System' : draft.mode === 'dark' ? (draft.appearance.oledDark ? 'OLED' : 'Dark') : 'Light'}
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
                                {automatic.apps?.enabled
                                  ? 'Apps enabled'
                                  : appChoices.length
                                    ? `${appChoices.length} ${appChoices.length === 1 ? 'app' : 'apps'} selected`
                                    : 'Apps manual'}
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
                        </>
                      ) : null}
                    </fieldset>
                  </form>
                )}
              </SetupStepPanel>
            </AnimatePresence>
          </SetupStage>
          {error ? <InlineFeedback className="orbis-setup-error">{error}</InlineFeedback> : null}
          <footer className="orbis-setup-footer">
            <Button
              type="button"
              variant="ghost"
              onClick={() => go(previousSetupStep(step, entry))}
              disabled={previousSetupStep(step, entry) === null || saving || restoreBusy || transitioning}
            >
              <IconArrowLeft size={18} aria-hidden="true" />
              Back
            </Button>
            {saving || recoveryStep ? (
              <div className="orbis-setup-footer-status">
                {saving || recoveryStep ? (
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
                        : ''}
                  </output>
                ) : null}
              </div>
            ) : null}
            {recoveryStep ? null : (
              <Button
                type="submit"
                form="setup-form"
                intent="primary"
                disabled={
                  saving ||
                  transitioning ||
                  syncState === 'loading' ||
                  (step === 'choose' && entry === null) ||
                  (step === 'server' && !nameValid) ||
                  ((step === 'updates' || step === 'ready') && !scheduleValid)
                }
              >
                {saving ? 'Saving…' : step === 'ready' ? 'Finish' : 'Continue'}
                {saving || step === 'ready' ? null : <IconArrowRight size={18} aria-hidden="true" />}
              </Button>
            )}
          </footer>
        </section>
      </AuthLayout>
    </DesktopPreferencesPreview>
  );
};
