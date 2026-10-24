import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/Switch';
import { useWindowVisible } from '@/desktop/window-visibility';
import { automaticUpdateSettingsOptions, saveAutomaticUpdateSettings, type AutomaticUpdateSettings } from '@/desktop/automatic-updates-api';
import './automatic-updates-settings.css';
import { SystemUpdatesSettings } from './system-updates-settings';

export function AutomaticUpdatesSettings() {
  const id = useId();
  const visible = useWindowVisible();
  const client = useQueryClient();
  const options = automaticUpdateSettingsOptions();
  const status = useQuery({ ...options, enabled: visible });
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
          <div className="automatic-updates-time">
            <label htmlFor={`${id}-time`}>
              <span>Daily update time</span>
              <input
                id={`${id}-time`}
                type="time"
                required
                value={value.schedule.time}
                disabled={save.isPending || !status.data?.available}
                onChange={(event) => change({ ...value, schedule: { ...value.schedule, time: event.target.value } })}
              />
            </label>
            <label htmlFor={`${id}-zone`}>
              <span>Timezone</span>
              <input
                id={`${id}-zone`}
                type="text"
                required
                maxLength={100}
                spellCheck={false}
                autoComplete="off"
                value={value.schedule.timezone}
                disabled={save.isPending || !status.data?.available}
                onChange={(event) => change({ ...value, schedule: { ...value.schedule, timezone: event.target.value } })}
                aria-describedby={`${id}-shared`}
              />
            </label>
          </div>
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
