import { useEffect, useId, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/Switch';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { TimeField, useTimeField } from '@/components/ui/TimeField/TimeField';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useDesktopPreferences } from '@/desktop/preferences';

import {
  automaticUpdateSettingsOptions,
  formatAutomaticUpdateServerTime,
  saveAutomaticUpdateSettings,
  type AutomaticUpdateSettings,
} from '@/desktop/automatic-updates-api';
import './automatic-updates-settings.css';
import { SystemUpdatesSettings } from './system-updates-settings';

export function AutomaticUpdatesSettings() {
  const id = useId();
  const visible = useWindowVisible();
  const { preferences, updateAppearance } = useDesktopPreferences();
  const client = useQueryClient();
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
  const [draft, setDraft] = useState<AutomaticUpdateSettings | null>(null);
  const [timeDraft, setTimeDraft] = useState<string | null | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: saveAutomaticUpdateSettings,
    onSuccess: (result) => {
      client.setQueryData(options.queryKey, result);
      void client.invalidateQueries({ queryKey: ['orbis-system-update-schedule'] });
      setDraft(null);
      setTimeDraft(undefined);
      setSaved(true);
    },
  });
  const value = draft ?? status.data?.settings;
  const time = useTimeField({
    value: timeDraft === undefined ? (value?.schedule.time ?? '03:00') : timeDraft,
    format: preferences.appearance.timeFormat,
    onFormatChange: (timeFormat) => updateAppearance({ timeFormat }),
    onChange: (next) => {
      if (value) setDraft((previous) => previous ?? value);
      setTimeDraft(next);
      setSaved(false);
      save.reset();
    },
  });
  const resolvedValue = value && time.value ? { ...value, schedule: { ...value.schedule, time: time.value } } : null;
  const timeInvalid = Boolean(value && !resolvedValue);
  const change = (next: AutomaticUpdateSettings) => {
    setDraft(next);
    setSaved(false);
    save.reset();
  };
  const dirty = Boolean(resolvedValue && JSON.stringify(resolvedValue) !== JSON.stringify(status.data?.settings));
  return (
    <section className="automatic-updates-settings" aria-labelledby={`${id}-title`}>
      <header>
        <h2 id={`${id}-title`}>Automatic updates</h2>
        <p>Orbis updates wait until every browser has been inactive for at least ten minutes. New releases are checked once a day.</p>
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
            time.finish();
            if (dirty && resolvedValue) save.mutate(resolvedValue);
          }}
        >
          <Switch
            label="Update Orbis automatically"
            checked={value.orbis.enabled}
            disabled={save.isPending || (!status.data?.available && !value.orbis.enabled)}
            onCheckedChange={(enabled) => change({ ...value, orbis: { ...value.orbis, enabled } })}
          />
          <fieldset disabled={!value.orbis.enabled || !status.data?.available || save.isPending} className="automatic-updates-modes">
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
          <TimeField
            control={time}
            label="Daily update time"
            id={`${id}-time`}
            disabled={save.isPending || !status.data?.available}
            describedBy={`${id}-server-time ${id}-shared`}
          />
          <Switch
            label="Update apps automatically"
            checked={value.apps?.enabled ?? false}
            disabled={save.isPending || !status.data?.available}
            onCheckedChange={(enabled) => change({ ...value, apps: { enabled } })}
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
          <p id={`${id}-shared`}>
            Store apps use this daily time when automatic updates are enabled. Each app can use its own schedule or stay manual. Custom apps stay
            manual.
          </p>
          {status.data?.pauseReason ? <p>{status.data.pauseReason}</p> : null}
          {status.data?.lastAttempt ? <p>Last Orbis check: {status.data.lastAttempt.message ?? status.data.lastAttempt.state}</p> : null}
          {status.data?.available === false ? <p role="alert">{status.data.reason ?? 'Automatic updates are unavailable.'}</p> : null}
          {save.isError ? (
            <InlineFeedback>{save.error instanceof Error ? save.error.message : 'The update schedule could not be saved.'}</InlineFeedback>
          ) : null}
          {saved ? <output>Automatic update settings saved.</output> : null}
          <button className="automatic-updates-save" type="submit" disabled={!dirty || timeInvalid || save.isPending || !status.data?.available}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </form>
      ) : null}
      <SystemUpdatesSettings />
    </section>
  );
}
