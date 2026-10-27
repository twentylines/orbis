import { useEffect, useId, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/Switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useWindowVisible } from '@/desktop/window-visibility';
import {
  automaticUpdateSettingsOptions,
  formatAutomaticUpdateServerTime,
  saveAutomaticUpdateSettings,
  type AutomaticUpdateSettings,
} from '@/desktop/automatic-updates-api';
import './automatic-updates-settings.css';
import { SystemUpdatesSettings } from './system-updates-settings';

const hours = Array.from({ length: 24 }, (_, value) => String(value).padStart(2, '0'));
const minutes = Array.from({ length: 60 }, (_, value) => String(value).padStart(2, '0'));

export function AutomaticUpdatesSettings() {
  const id = useId();
  const visible = useWindowVisible();
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
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: saveAutomaticUpdateSettings,
    onSuccess: (result) => {
      client.setQueryData(options.queryKey, result);
      void client.invalidateQueries({ queryKey: ['orbis-system-update-schedule'] });
      setDraft(null);
      setSaved(true);
    },
  });
  const value = draft ?? status.data?.settings;
  const change = (next: AutomaticUpdateSettings) => {
    setDraft(next);
    setSaved(false);
    save.reset();
  };
  const dirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(status.data?.settings));
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
            if (dirty) save.mutate(value);
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
          <fieldset className="automatic-updates-schedule" aria-describedby={`${id}-server-time ${id}-shared`}>
            <legend className="automatic-updates-time-label">Daily update time</legend>
            <div className="automatic-updates-time">
              <Select
                value={value.schedule.time.slice(0, 2)}
                disabled={save.isPending || !status.data?.available}
                onValueChange={(hour) => change({ ...value, schedule: { ...value.schedule, time: `${hour}:${value.schedule.time.slice(3)}` } })}
              >
                <SelectTrigger fitContent className="automatic-updates-time-select" aria-label="Daily update hour">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hours.map((hour) => (
                    <SelectItem key={hour} value={hour}>
                      {hour}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span aria-hidden="true" className="automatic-updates-time-separator">
                :
              </span>
              <Select
                value={value.schedule.time.slice(3)}
                disabled={save.isPending || !status.data?.available}
                onValueChange={(minute) =>
                  change({ ...value, schedule: { ...value.schedule, time: `${value.schedule.time.slice(0, 2)}:${minute}` } })
                }
              >
                <SelectTrigger fitContent className="automatic-updates-time-select" aria-label="Daily update minute">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {minutes.map((minute) => (
                    <SelectItem key={minute} value={minute}>
                      {minute}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p id={`${id}-server-time`} className="automatic-updates-server-time">
              {currentServerTime ? (
                <>
                  Server time: <time>{currentServerTime}</time> · {serverTime?.timezone}
                </>
              ) : (
                'Server time is unavailable.'
              )}
            </p>
          </fieldset>
          <p id={`${id}-shared`}>
            This daily time is also available to individual apps. App updates are disabled until you enable them in each app’s settings.
          </p>
          {status.data?.pauseReason ? <p>{status.data.pauseReason}</p> : null}
          {status.data?.lastAttempt ? <p>Last Orbis check: {status.data.lastAttempt.message ?? status.data.lastAttempt.state}</p> : null}
          {status.data?.available === false ? <p role="alert">{status.data.reason ?? 'Automatic updates are unavailable.'}</p> : null}
          {save.isError ? <p role="alert">{save.error instanceof Error ? save.error.message : 'The update schedule could not be saved.'}</p> : null}
          {saved ? <output>Automatic update settings saved.</output> : null}
          <button className="automatic-updates-save" type="submit" disabled={!dirty || save.isPending || !status.data?.available}>
            {save.isPending ? 'Saving…' : 'Save update settings'}
          </button>
        </form>
      ) : null}
      <SystemUpdatesSettings />
    </section>
  );
}
