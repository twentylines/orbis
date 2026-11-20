import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { TimeField, useTimeField } from '@/components/ui/TimeField/TimeField';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useUserContext } from '@/context/user-context';
import { useDesktopPreferences } from '@/desktop/preferences';

import {
  automaticUpdateSettingsOptions,
  formatAutomaticUpdateServerTime,
  saveAutomaticUpdateSettings,
  readAutomaticUpdateSettings,
  hasIndependentUpdateSchedules,
  type AutomaticUpdateSettings,
} from '@/desktop/automatic-updates-api';
import './automatic-updates-settings.css';
import { SystemUpdatesSettings } from './system-updates-settings';
import { AutomaticAppUpdateSwitch } from './app-update-policy';
import { useDebouncedPreferenceSave } from '../hooks/use-debounced-preference-save';
import { AutosavedSettingSwitch } from '../components/autosaved-setting-switch';
import { automaticSettingsScope, useAutomaticUpdateToggle } from '../hooks/use-update-setting-toggles';
import { automaticSchedulePlan, type AutomaticScheduleEdit } from '../helpers/update-schedule-draft';

type OrbisUpdateMode = AutomaticUpdateSettings['orbis']['mode'];

type ScheduleLifetime = Readonly<{ epoch: object; signal: AbortSignal; version: number }>;
type ScheduleWrite = ScheduleLifetime & AutomaticScheduleEdit;
type ScheduleDraft = { time: string | null; epoch: object; version: number };

export function AutomaticUpdatesSettings({ mode = 'all' }: { mode?: 'all' | 'apps' }) {
  const id = useId();
  const visible = useWindowVisible();
  const { preferences, updateAppearance } = useDesktopPreferences();
  const client = useQueryClient();
  const { sessionEpoch, sessionAbortSignal } = useUserContext();
  const currentEpoch = useRef(sessionEpoch);
  currentEpoch.current = sessionEpoch;
  const editVersion = useRef(0);
  const assertCurrent = (write: ScheduleLifetime) => {
    write.signal.throwIfAborted();
    if (write.epoch !== currentEpoch.current) throw new DOMException('The settings session changed.', 'AbortError');
  };
  const options = automaticUpdateSettingsOptions();
  const status = useQuery({ ...options, enabled: visible });
  const serverTime = status.data?.serverTime;
  const clock = useMemo(() => (serverTime ? { value: serverTime, receivedAt: performance.now() } : null), [serverTime]);
  const [, refreshClock] = useState(0);
  useEffect(() => {
    if (!visible || !clock) return;
    const timer = setInterval(() => refreshClock((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, [visible, clock]);
  const currentServerTime = clock ? formatAutomaticUpdateServerTime(clock.value, Math.max(0, performance.now() - clock.receivedAt)) : null;
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [requestedTime, setRequestedTime] = useState<ScheduleWrite | null>(null);
  const [requestedMode, setRequestedMode] = useState<ScheduleWrite | null>(null);
  const activeDraft = draft?.epoch === sessionEpoch ? draft : null;
  const orbis = useAutomaticUpdateToggle('orbis', status.data, visible && mode === 'all');
  const timeDraft = activeDraft?.time;
  const savedMode = status.data?.settings.orbis.mode;
  const selectedMode = requestedMode?.epoch === sessionEpoch ? requestedMode.mode : savedMode;
  const independent = hasIndependentUpdateSchedules(status.data);
  const savedTime = mode === 'apps' ? status.data?.settings.schedule.time : status.data?.orbisSchedule?.time;
  const save = useMutation({
    scope: { id: automaticSettingsScope },
    networkMode: 'always',
    retry: false,
    mutationFn: async (write: ScheduleWrite) => {
      assertCurrent(write);
      const latest = await readAutomaticUpdateSettings(write.signal);
      assertCurrent(write);
      const { settings, options } = automaticSchedulePlan(mode, latest, write);
      const result = await saveAutomaticUpdateSettings(settings, options, write.signal);
      assertCurrent(write);
      return result;
    },
    onSuccess: (result, write) => {
      if (write.signal.aborted || write.epoch !== currentEpoch.current) return;
      client.setQueryData(options.queryKey, result);
      void client.invalidateQueries({ queryKey: ['orbis-system-update-schedule'] });
      if (write.time !== undefined) {
        setDraft((current) => (current?.epoch === write.epoch && current.version === write.version ? null : current));
        setRequestedTime((current) => (current === write ? null : current));
      }
      if (write.mode !== undefined) setRequestedMode((current) => (current === write ? null : current));
    },
  });
  const time = useTimeField({
    value: timeDraft === undefined ? (savedTime ?? null) : timeDraft,
    format: preferences.appearance.timeFormat,
    onFormatChange: (timeFormat) => updateAppearance({ timeFormat }),
    onChange: (next) => setDraft({ time: next, epoch: sessionEpoch, version: ++editVersion.current }),
  });
  const ready = Boolean(status.data?.available && independent);
  const writeTime = requestedTime?.epoch === sessionEpoch && requestedTime.time === time.value ? requestedTime : null;
  const writeMode = requestedMode?.epoch === sessionEpoch ? requestedMode : null;
  const timeSave = useDebouncedPreferenceSave(
    writeTime ? String(writeTime.version) : null,
    async () => {
      if (writeTime) await save.mutateAsync(writeTime);
    },
    { delay: 0, ready, signal: sessionAbortSignal, unsaved: activeDraft !== null && time.value !== savedTime },
  );
  const modeSave = useDebouncedPreferenceSave(
    writeMode ? String(writeMode.version) : null,
    async () => {
      if (writeMode) await save.mutateAsync(writeMode);
    },
    { delay: 0, ready, signal: sessionAbortSignal },
  );
  const changeMode = (next: OrbisUpdateMode) =>
    setRequestedMode({ mode: next, epoch: sessionEpoch, signal: sessionAbortSignal, version: ++editVersion.current });
  const commitTime = (next: string) => {
    if (next === savedTime) {
      setDraft(null);
      setRequestedTime(null);
      return;
    }
    if (requestedTime?.time === next && requestedTime.epoch === sessionEpoch) return;
    setRequestedTime({ time: next, epoch: sessionEpoch, signal: sessionAbortSignal, version: editVersion.current });
  };
  return (
    <section
      id={mode === 'all' ? 'setting-orbis-updates' : 'setting-app-updates'}
      className="automatic-updates-settings"
      aria-labelledby={`${id}-title`}
    >
      <header>
        <h2 id={`${id}-title`}>{mode === 'apps' ? 'App updates' : 'Orbis updates'}</h2>
      </header>
      {status.isPending ? <output>Reading automatic update settings…</output> : null}
      {status.isError ? (
        <p role="alert">
          Automatic update settings could not be read.{' '}
          <button type="button" className="btn btn-outline-primary ms-2" onClick={() => void status.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {status.data ? (
        <fieldset className="settings-save-fields" disabled={!independent}>
          {mode === 'all' ? (
            <>
              <AutosavedSettingSwitch label="Update Orbis automatically" toggle={orbis} />
              <fieldset disabled={!orbis.checked || !ready} className="automatic-updates-modes">
                <legend>When to update Orbis</legend>
                <label>
                  <input type="radio" name={`${id}-mode`} checked={selectedMode === 'idle'} onChange={() => changeMode('idle')} />
                  <span>When Orbis is idle</span>
                </label>
                <label>
                  <input type="radio" name={`${id}-mode`} checked={selectedMode === 'scheduled'} onChange={() => changeMode('scheduled')} />
                  <span>After the daily update time</span>
                </label>
              </fieldset>
              {status.data?.pauseReason ? <p>{status.data.pauseReason}</p> : null}
              {status.data?.lastAttempt ? <p>Last Orbis check: {status.data.lastAttempt.message ?? status.data.lastAttempt.state}</p> : null}
            </>
          ) : null}
          {mode === 'apps' ? <AutomaticAppUpdateSwitch /> : null}
          <TimeField
            control={time}
            label={mode === 'apps' ? 'App update time' : 'Orbis update time'}
            id={mode === 'apps' ? 'setting-app-update-time' : 'setting-update-time'}
            disabled={timeSave.pending || !ready}
            describedBy={`${id}-server-time`}
            onCommit={commitTime}
          />
          <p id={`${id}-server-time`} className="automatic-updates-server-time">
            {currentServerTime ? (
              <>
                Server time: <time>{currentServerTime}</time> · {serverTime?.timezone}
              </>
            ) : (
              'Server time is unavailable.'
            )}
          </p>
          {independent ? null : <p role="note">Update Orbis to configure separate update schedules.</p>}
          {status.data?.available === false ? <p role="alert">{status.data.reason ?? 'Automatic updates are unavailable.'}</p> : null}
          {[modeSave, timeSave].map((result, index) =>
            result.error ? (
              <InlineFeedback key={index === 0 ? 'mode' : 'time'}>
                {result.error}{' '}
                <button type="button" className="btn btn-outline-primary" onClick={result.retry}>
                  Retry
                </button>
              </InlineFeedback>
            ) : null,
          )}
        </fieldset>
      ) : null}
    </section>
  );
}

export function UpdateSchedules() {
  return (
    <>
      <AutomaticUpdatesSettings />
      <AutomaticUpdatesSettings mode="apps" />
      <SystemUpdatesSettings />
    </>
  );
}
