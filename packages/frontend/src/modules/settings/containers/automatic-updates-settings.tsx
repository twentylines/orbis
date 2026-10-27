import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/Switch';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useDesktopPreferences } from '@/desktop/preferences';
import {
  applyAutomaticUpdateTime,
  editUpdateTime,
  parseWholeUpdateTime,
  readUpdateTime,
  updateTimeError,
  updateTimeFields,
  type UpdateTimeFields,
  type UpdateTimeField,
  type UpdateTimeFormat,
} from '@/desktop/automatic-update-time';
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
  const [timeDraft, setTimeDraft] = useState<{ fields: UpdateTimeFields; format: UpdateTimeFormat } | null>(null);
  const [timeTouched, setTimeTouched] = useState(false);
  const minuteInput = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: saveAutomaticUpdateSettings,
    onSuccess: (result) => {
      client.setQueryData(options.queryKey, result);
      void client.invalidateQueries({ queryKey: ['orbis-system-update-schedule'] });
      setDraft(null);
      setTimeDraft(null);
      setTimeTouched(false);
      setSaved(true);
    },
  });
  const value = draft ?? status.data?.settings;
  const format = timeDraft?.format ?? preferences.appearance.timeFormat;
  const fields = timeDraft?.fields ?? updateTimeFields(value?.schedule.time ?? '03:00', format);
  const resolvedValue = value ? applyAutomaticUpdateTime(value, fields, format) : null;
  const timeInvalid = Boolean(value && !resolvedValue);
  const timeError = timeTouched && timeInvalid ? updateTimeError(format) : null;
  const change = (next: AutomaticUpdateSettings) => {
    setDraft(next);
    setSaved(false);
    save.reset();
  };
  const dirty = Boolean(resolvedValue && JSON.stringify(resolvedValue) !== JSON.stringify(status.data?.settings));
  const editTime = (field: UpdateTimeField, input: string) => {
    if (value) setDraft((previous) => previous ?? value);
    setTimeDraft({ fields: editUpdateTime(fields, field, input, format), format });
    setTimeTouched(false);
    setSaved(false);
    save.reset();
  };
  const finishTime = () => {
    const time = readUpdateTime(fields, format);
    setTimeTouched(true);
    if (time) setTimeDraft({ fields: updateTimeFields(time, format), format });
    return Boolean(time);
  };
  const timeKey = (event: KeyboardEvent<HTMLInputElement>, field: UpdateTimeField) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (finishTime()) {
        if (field === 'hour') minuteInput.current?.focus();
        else event.currentTarget.blur();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setTimeDraft(null);
      setTimeTouched(false);
    }
  };
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
            setTimeTouched(true);
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
          <fieldset className="automatic-updates-schedule" aria-describedby={`${id}-server-time ${id}-shared`}>
            <legend className="automatic-updates-time-label">Daily update time</legend>
            <div className="automatic-updates-time" data-format={format}>
              <input
                id={`${id}-hour`}
                className="form-control automatic-updates-time-input"
                type="text"
                inputMode="numeric"
                aria-label={format === '12h' ? 'Daily update hour, 1 to 12' : 'Daily update hour, 00 to 23'}
                aria-invalid={Boolean(timeError)}
                aria-describedby={timeError ? `${id}-time-error` : undefined}
                value={fields.hour}
                maxLength={16}
                autoComplete="off"
                spellCheck={false}
                disabled={save.isPending || !status.data?.available}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => editTime('hour', event.target.value)}
                onBlur={finishTime}
                onKeyDown={(event) => timeKey(event, 'hour')}
                onPaste={(event) => {
                  const text = event.clipboardData.getData('text');
                  if (parseWholeUpdateTime(text)) {
                    event.preventDefault();
                    editTime('hour', text);
                  }
                }}
              />
              <span aria-hidden="true" className="automatic-updates-time-separator">
                :
              </span>
              <input
                ref={minuteInput}
                id={`${id}-minute`}
                className="form-control automatic-updates-time-input"
                type="text"
                inputMode="numeric"
                aria-label="Daily update minute, 00 to 59"
                aria-invalid={Boolean(timeError)}
                aria-describedby={timeError ? `${id}-time-error` : undefined}
                value={fields.minute}
                maxLength={16}
                autoComplete="off"
                spellCheck={false}
                disabled={save.isPending || !status.data?.available}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => editTime('minute', event.target.value)}
                onBlur={finishTime}
                onKeyDown={(event) => timeKey(event, 'minute')}
                onPaste={(event) => {
                  const text = event.clipboardData.getData('text');
                  if (parseWholeUpdateTime(text)) {
                    event.preventDefault();
                    editTime('minute', text);
                  }
                }}
              />
              {format === '12h' ? (
                <Select
                  value={fields.period}
                  disabled={save.isPending || !status.data?.available}
                  onValueChange={(period) => {
                    if (period === 'AM' || period === 'PM') {
                      if (value) setDraft((previous) => previous ?? value);
                      setTimeDraft({ fields: { ...fields, period }, format });
                      setSaved(false);
                      save.reset();
                    }
                  }}
                >
                  <SelectTrigger fitContent className="automatic-updates-time-period" aria-label="Daily update AM or PM">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AM">AM</SelectItem>
                    <SelectItem value="PM">PM</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
            </div>
            {timeError ? <InlineFeedback id={`${id}-time-error`}>{timeError}</InlineFeedback> : null}
            <div className="automatic-updates-time-format">
              <span id={`${id}-format-label`}>Time format</span>
              <Select
                value={format}
                onValueChange={(next) => {
                  if (next !== '12h' && next !== '24h') return;
                  const time = readUpdateTime(fields, format);
                  if (!time) {
                    setTimeTouched(true);
                    return;
                  }
                  setTimeDraft({ fields: updateTimeFields(time, next), format: next });
                  updateAppearance({ timeFormat: next });
                }}
              >
                <SelectTrigger fitContent className="automatic-updates-format-select" aria-labelledby={`${id}-format-label`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="12h">12-hour</SelectItem>
                  <SelectItem value="24h">24-hour</SelectItem>
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
          {save.isError ? (
            <InlineFeedback>{save.error instanceof Error ? save.error.message : 'The update schedule could not be saved.'}</InlineFeedback>
          ) : null}
          {saved ? <output>Automatic update settings saved.</output> : null}
          <button className="automatic-updates-save" type="submit" disabled={!dirty || timeInvalid || save.isPending || !status.data?.available}>
            {save.isPending ? 'Saving…' : 'Save update settings'}
          </button>
        </form>
      ) : null}
      <SystemUpdatesSettings />
    </section>
  );
}
