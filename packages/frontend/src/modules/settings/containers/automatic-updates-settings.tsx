import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/Switch';
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
  type IndependentScheduleOptions,
  type AutomaticUpdateSettings,
} from '@/desktop/automatic-updates-api';
import './automatic-updates-settings.css';
import { SystemUpdatesSettings } from './system-updates-settings';
import { AutomaticAppUpdateSwitch } from './app-update-policy';
import { useSettingsSave } from '../pages/settings-save';
import { automaticScheduleDirty, automaticSchedulePlan } from '../helpers/update-schedule-draft';

type ScheduleLifetime = Readonly<{ epoch: object; signal: AbortSignal; version: number }>;
type ScheduleWrite = ScheduleLifetime & { settings: AutomaticUpdateSettings; options: IndependentScheduleOptions };
type ScheduleDraft = { settings: AutomaticUpdateSettings; time: string | null | undefined; epoch: object; version: number };

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
  const activeDraft = draft?.epoch === sessionEpoch ? draft : null;
  const timeDraft = activeDraft?.time;
  const save = useMutation({
    mutationFn: async (write: ScheduleWrite) => {
      assertCurrent(write);
      const result = await saveAutomaticUpdateSettings(write.settings, write.options, write.signal);
      assertCurrent(write);
      return result;
    },
    onSuccess: (result, write) => {
      if (write.signal.aborted || write.epoch !== currentEpoch.current) return;
      client.setQueryData(options.queryKey, result);
      void client.invalidateQueries({ queryKey: ['orbis-system-update-schedule'] });
      setDraft((current) => (current?.epoch === write.epoch && current.version === write.version ? null : current));
    },
  });
  const currentSave = save.variables?.epoch === sessionEpoch && !save.variables.signal.aborted;
  const saving = save.isPending && currentSave;
  const value = activeDraft?.settings ?? status.data?.settings;
  const independent = hasIndependentUpdateSchedules(status.data);
  const savedTime = mode === 'apps' ? status.data?.settings.schedule.time : status.data?.orbisSchedule?.time;
  const time = useTimeField({
    value: timeDraft === undefined ? (savedTime ?? null) : timeDraft,
    format: preferences.appearance.timeFormat,
    onFormatChange: (timeFormat) => updateAppearance({ timeFormat }),
    onChange: (next) => {
      if (value) setDraft({ settings: value, time: next, epoch: sessionEpoch, version: ++editVersion.current });
      save.reset();
    },
  });
  const resolvedValue = value && time.value ? structuredClone(value) : null;
  const timeInvalid = Boolean(independent && timeDraft !== undefined && value && !resolvedValue);
  const change = (next: AutomaticUpdateSettings) => {
    setDraft({ settings: next, time: timeDraft, epoch: sessionEpoch, version: ++editVersion.current });
    save.reset();
  };
  const dirty = automaticScheduleDirty(
    mode,
    status.data,
    mode === 'apps' && value ? { ...value, apps: status.data?.settings.apps } : value,
    time.value,
  );
  const capture = (settings: AutomaticUpdateSettings, selectedTime: string) => ({
    settings: structuredClone(settings),
    selectedTime,
    epoch: sessionEpoch,
    signal: sessionAbortSignal,
    version: activeDraft?.version ?? editVersion.current,
  });
  const commit = async (write: ReturnType<typeof capture>) => {
    assertCurrent(write);
    const latest = await readAutomaticUpdateSettings(write.signal);
    assertCurrent(write);
    const next = mode === 'apps' ? { ...write.settings, apps: latest.settings.apps } : write.settings;
    const plan = automaticSchedulePlan(mode, latest, next, write.selectedTime);
    await save.mutateAsync({ ...plan, epoch: write.epoch, signal: write.signal, version: write.version });
    assertCurrent(write);
  };
  const sharedSave = useSettingsSave({
    section: 'updates',
    dirty: dirty || timeInvalid,
    pending: saving,
    prepare: async () => {
      if (!time.finish() || !resolvedValue || !time.value || !status.data?.available || !independent) return null;
      const write = capture(resolvedValue, time.value);
      assertCurrent(write);
      return () => commit(write);
    },
  });
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
      {value ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (sharedSave.shared) return void sharedSave.save?.();
            time.finish();
            if (dirty && resolvedValue && time.value && independent) void commit(capture(resolvedValue, time.value)).catch(() => undefined);
          }}
        >
          <fieldset className="settings-save-fields" disabled={sharedSave.pending || !independent}>
            {mode === 'all' ? (
              <>
                <Switch
                  label="Update Orbis automatically"
                  checked={value.orbis.enabled}
                  disabled={saving || (!status.data?.available && !value.orbis.enabled)}
                  onCheckedChange={(enabled) => change({ ...value, orbis: { ...value.orbis, enabled } })}
                />
                <fieldset disabled={!value.orbis.enabled || !status.data?.available || saving} className="automatic-updates-modes">
                  <legend>When to update Orbis</legend>
                  <label>
                    <input
                      type="radio"
                      name={`${id}-mode`}
                      checked={value.orbis.mode === 'idle'}
                      onChange={() => change({ ...value, orbis: { ...value.orbis, mode: 'idle' } })}
                    />
                    <span>When Orbis is idle</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={`${id}-mode`}
                      checked={value.orbis.mode === 'scheduled'}
                      onChange={() => change({ ...value, orbis: { ...value.orbis, mode: 'scheduled' } })}
                    />
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
              disabled={saving || !status.data?.available}
              describedBy={`${id}-server-time`}
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
            {save.isError && currentSave ? (
              <InlineFeedback>{save.error instanceof Error ? save.error.message : 'The update schedule could not be saved.'}</InlineFeedback>
            ) : null}
            {sharedSave.shared ? null : (
              <button className="automatic-updates-save" type="submit" disabled={!dirty || timeInvalid || saving || !status.data?.available}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </fieldset>
        </form>
      ) : null}
      {mode === 'all' ? (
        <>
          <AutomaticUpdatesSettings mode="apps" />
          <SystemUpdatesSettings />
        </>
      ) : null}
    </section>
  );
}
